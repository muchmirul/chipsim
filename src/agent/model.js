import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { validateModel } from "../model/validate.js";
import {
  normalizeParameters,
  runChecks,
  simulateModel,
  validateInputs,
} from "../model/engine.js";
import { builtinModels } from "../models/index.js";
import { exportCSV, exportJSON, exportVCD } from "../trace/export.js";
import { loadProject } from "./project.js";
import { AgentError, readJSON, createDirectory, writeJSON } from "./io.js";

export async function checkModel(
  file,
  project,
  { progress = async () => {} } = {},
) {
  await progress("Reading model and validating schema");
  const spec = await readJSON(file);
  // Catch schema errors before expensive PDF extraction; missing attachments
  // are subsequently an error here, even though interactive import allows them.
  validateModel(spec);
  if (builtinModels.some((model) => model.id === spec.id))
    throw new AgentError(
      "MODEL",
      `Model ID ${spec.id} is reserved for a built-in example`,
    );
  await progress(
    "Verifying PDF fingerprint and extracting original source pages",
  );
  const { document } = await loadProject(project, { fresh: true });
  const missing = spec.sources.filter(
    (source) => source.sha256 !== document.sha256,
  );
  if (missing.length)
    throw new AgentError(
      "SOURCE_MISSING",
      "Every source must match this project's actual PDF. Use a single-manual model for this workflow.",
      missing.map((source) => ({ id: source.id, sha256: source.sha256 })),
    );
  validateModel(spec, [document]);
  await progress(
    `Source quotations verified · executing ${spec.checks.length} acceptance cases`,
  );
  const checks = runChecks(spec);
  const report = {
    ok: checks.every((check) => check.passed),
    model: {
      id: spec.id,
      name: spec.name,
      scope: spec.scope,
      fidelity: spec.fidelity,
      assumptions: spec.assumptions,
    },
    provenance: {
      method: "fresh extraction of fingerprinted PDF",
      sha256: document.sha256,
      verifiedQuotes: spec.evidence.length,
    },
    checks,
    diagnostics: [],
  };
  if (!report.ok)
    report.diagnostics.push({
      code: "ACCEPTANCE",
      message: "Acceptance checks failed",
    });
  return { spec, report };
}

export async function runModel(file, project, output, options = {}) {
  const { spec, report } = await checkModel(file, project, options);
  if (!report.ok) return report;
  const supplied = options.params ? await readJSON(options.params) : {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
    throw new AgentError("PARAMETERS", "Parameters must be a JSON object");
  const parameters = normalizeParameters(spec.parameters, supplied);
  const inputs = validateInputs(
    spec.signals,
    options.inputs ? await readJSON(options.inputs) : spec.exampleInputs || [],
  );
  const duration = options.ticks ?? spec.duration ?? 100;
  await options.progress?.(
    `Simulating ${spec.id} · ${duration} normalized ticks`,
  );
  const trace = simulateModel(spec, parameters, { ticks: duration, inputs });
  const final = trace.at(-1),
    fault = final.phase === "fault";
  const model = { ...spec, spec };
  await options.progress?.("Writing trace artifacts and TUI session");
  return createDirectory(output, async (root) => {
    await writeFile(
      join(root, "trace.json"),
      exportJSON(model, trace, parameters, inputs),
      { flag: "wx" },
    );
    await writeFile(join(root, "trace.csv"), exportCSV(model, trace), {
      flag: "wx",
    });
    await writeFile(join(root, "trace.vcd"), exportVCD(model, trace), {
      flag: "wx",
    });
    await writeJSON(join(root, "session.json"), {
      format: "chipsim-session",
      version: 1,
      modelId: spec.id,
      model: spec,
      parameters,
      inputs,
      duration,
      tick: fault ? final.tick : 0,
      display: "hex",
    });
    const result = {
      ...report,
      ok: !fault,
      parameters,
      snapshots: trace.length,
      final,
      artifacts: Object.fromEntries(
        ["trace.json", "trace.csv", "trace.vcd", "session.json"].map((name) => [
          name,
          join(root, name),
        ]),
      ),
      // Argument arrays work with a shell tool or subprocess without quoting guesses.
      tui: [
        "chipsim",
        "--document",
        resolve(project, "manual.pdf"),
        "--model",
        join(root, "session.json"),
      ],
      snapshot: [
        "chipsim",
        "--document",
        resolve(project, "manual.pdf"),
        "--model",
        join(root, "session.json"),
        "--snapshot",
        "--columns",
        "120",
        "--rows",
        "40",
      ],
      diagnostics: fault
        ? [{ code: "SIMULATION_FAULT", message: final.detail }]
        : [],
      warnings: inputs.some((event) => event.tick > final.tick)
        ? [
            "Some input events occur after the produced trace and were not executed.",
          ]
        : [],
    };
    await writeJSON(join(root, "result.json"), result);
    return result;
  });
}
