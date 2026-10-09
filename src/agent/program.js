import { resolve, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { readBounded, createDirectory, writeJSON } from "./io.js";
import { checkModel } from "./model.js";
import { loadProject } from "./project.js";
import { registerModel, builtinModels } from "../models/index.js";
import { parseProgram } from "../program/parse.js";
import { ProgramDebugger } from "../program/engine.js";
import { verifyProgramGuides } from "../program/guides.js";
import { exportJSON, exportCSV, exportVCD } from "../trace/export.js";

export async function loadAgentProgram(file, options) {
  const text = (await readBounded(file, 65536)).toString("utf8");
  const program = parseProgram(text);
  let model,
    manual = null,
    modelReport = null;
  if (builtinModels.some((m) => m.id === options.model)) {
    model = builtinModels.find((m) => m.id === options.model);
  } else {
    if (!options.project)
      throw new Error(
        "Document programs require --project to verify the original model sources.",
      );
    const { spec, report } = await checkModel(options.model, options.project, {
      progress: options.progress,
    });
    if (!report.ok) throw new Error("Model acceptance checks failed.");
    model = registerModel(spec);
    modelReport = report;
  }
  if (options.project)
    ({ document: manual } = await loadProject(options.project, {
      fresh: true,
    }));
  await options.progress?.(
    "Verifying programming-guide fingerprints and quoted PDF pages",
  );
  const guides = await verifyProgramGuides(program, model, { manual });
  const debug = new ProgramDebugger(model, program, {
    guides,
    maxTicks: options.ticks,
    maxSteps: options.steps,
  });
  return { debug, modelReport };
}

export async function runAgentProgram(file, output, options) {
  const { debug, modelReport } = await loadAgentProgram(file, options);
  await options.progress?.(
    "Executing source program and recording line-to-signal mapping",
  );
  debug.continue();
  return createDirectory(output, async (root) => {
    const artifacts = {};
    for (const [name, contents] of [
      ["program.chip", debug.program.text],
      [
        "trace.json",
        exportJSON(debug.model, debug.trace, debug.parameters, debug.inputs),
      ],
      ["trace.csv", exportCSV(debug.model, debug.trace)],
      ["trace.vcd", exportVCD(debug.model, debug.trace)],
    ]) {
      artifacts[name] = join(root, name);
      await writeFile(artifacts[name], contents, { flag: "wx" });
    }
    const session = {
      format: "chipsim-session",
      version: 1,
      modelId: debug.model.id,
      model: debug.model.spec || null,
      parameters: debug.parameters,
      inputs: debug.inputs,
      duration: Math.max(1, debug.tick),
      tick: 0,
      display: "hex",
      program: {
        text: debug.program.text,
        steps: debug.steps.length,
        status: debug.status,
        maxTicks: debug.maxTicks,
        maxSteps: debug.maxSteps,
      },
    };
    artifacts["session.json"] = join(root, "session.json");
    await writeJSON(artifacts["session.json"], session);
    artifacts["debug.json"] = join(root, "debug.json");
    await writeJSON(artifacts["debug.json"], debug.report());
    const result = {
      ...debug.report({ includeSteps: false }),
      model: { id: debug.model.id, scope: debug.model.scope },
      modelChecks: modelReport?.checks || [],
      snapshots: debug.trace.length,
      final: debug.snapshot,
      checks: modelReport?.checks || [],
      provenance: modelReport?.provenance,
      artifacts,
      tui: [
        "chipsim",
        ...(options.project
          ? ["--document", resolve(options.project, "manual.pdf")]
          : []),
        "--model",
        artifacts["session.json"],
        "--view",
        "program",
      ],
    };
    await writeJSON(join(root, "result.json"), result);
    return result;
  });
}
