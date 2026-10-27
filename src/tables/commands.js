import { basename, resolve, join } from "node:path";
import {
  readBounded,
  createDirectory,
  writeJSON,
  jsonText,
  integer,
} from "../agent/io.js";
import { writeFile } from "node:fs/promises";
import { extractSourceFile } from "../documents/extract-source.js";
import { sourceBundle } from "../documents/recognize.js";
import { buildRegisterBank } from "../model/register-bank/build.js";
import { modelId } from "../model/builders/sourced.js";
import { readRegisterRows } from "../model/register-bank/read.js";
import { readStimulusCSV } from "./stimulus.js";
import { builtinModels, registerModel } from "../models/index.js";
import { digest } from "../hdl/io.js";
import { defaultParameters } from "../models/index.js";
import { exportCSV, exportJSON, exportVCD } from "../trace/export.js";

export const usage = `CSV hardware tables (local, data-only)
  chipsim table registers MAP.csv --width 1..32 --priority before|after --name NAME --out NEW_DIRECTORY
  chipsim table stimulus EVENTS.csv --model MODEL_ID|MODEL.json --out NEW_DIRECTORY
Registers: name,address,mode,reset,mask (1..16 words; rw,ro,w1c,w1s,rc).
Stimulus: tick,signal,value (normalized model ticks; declared input signals only).
No PDF or simulator is needed. Register rules are developer-authored assumptions.
See docs/CSV_INPUTS.md.`;

export async function tableCommand(args) {
  const envelope = { format: "chipsim-table-result", version: 1 };
  try {
    if (!args.length || ["help", "--help", "-h"].includes(args[0]))
      return { result: { ...envelope, ok: true, help: usage }, exitCode: 0 };
    const [command, file, ...rest] = args;
    if (
      !["registers", "stimulus"].includes(command) ||
      !file ||
      file.startsWith("--")
    )
      throw new Error(
        "Expected table registers or table stimulus and a CSV path. " + usage,
      );
    if (!/\.csv$/i.test(file)) throw new Error("Choose a .csv source file.");
    const allowed =
      command === "registers"
        ? ["width", "priority", "name", "out"]
        : ["model", "out"];
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i].replace(/^--/, "");
      if (
        !rest[i].startsWith("--") ||
        !allowed.includes(key) ||
        Object.hasOwn(options, key) ||
        !rest[i + 1] ||
        rest[i + 1].startsWith("--")
      )
        throw new Error("Unknown, duplicate or incomplete option " + rest[i]);
      options[key] = rest[i + 1];
    }
    for (const key of allowed)
      if (!options[key]) throw new Error("Missing --" + key + ". " + usage);
    const bytes = await readBounded(
      file,
      command === "registers" ? 65536 : 1048576,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const source = {
      file: resolve(file),
      sha256: digest(bytes),
      mediaType: "text/csv",
    };
    let spec, checks, inputs, parameters, trace;
    if (command === "registers") {
      const width = integer(options.width, "width", 1, 32);
      // Use the same bytes for the fingerprint, parsed rows and evidence.
      const document = {
        mediaType: "text/csv",
        title: options.name,
        filename: basename(file),
        sha256: source.sha256,
        pages: [{ number: 1, text: text.replace(/^\uFEFF/, "").trim() }],
      };
      const rows = readRegisterRows(text, width);
      ({ spec, checks } = buildRegisterBank(document, {
        id: "csv-" + modelId(options.name).slice(0, 60),
        name: options.name,
        width,
        hardwarePriority: options.priority,
        rows: rows
          .map((row) =>
            [row.name, row.address, row.mode, row.reset, row.mask].join(" "),
          )
          .join("\n"),
        page: 1,
        quote: document.pages[0].text.slice(0, 1000),
        claim:
          "Developer-authored CSV register rules; no vendor document interpretation or silicon fidelity is claimed.",
      }));
      const model = registerModel(spec, [document]);
      parameters = defaultParameters(model);
      inputs = spec.exampleInputs;
      trace = model.simulate(parameters, { ticks: spec.duration, inputs });
      if (trace.at(-1).phase === "fault") throw new Error(trace.at(-1).detail);
    } else {
      const model =
        builtinModels.find((model) => model.id === options.model) ||
        registerModel(
          JSON.parse(
            (await readBounded(options.model, 3 * 1048576)).toString("utf8"),
          ),
        );
      inputs = readStimulusCSV(text, model.signals);
      spec = { id: model.id };
    }
    const result = await createDirectory(options.out, async (root) => {
      const artifacts = {};
      const saveJSON = async (name, value) => {
        const path = join(root, name);
        await writeJSON(path, value);
        artifacts[name] = path;
      };
      await writeFile(join(root, "source.csv"), bytes, { flag: "wx" });
      artifacts["source.csv"] = join(root, "source.csv");
      await saveJSON("inputs.json", inputs);
      if (command === "registers") {
        const document = await extractSourceFile(join(root, "source.csv"));
        // Source file names are descriptive; identity is its exact byte hash.
        document.filename = basename(file);
        document.title = options.name;
        await saveJSON("sources.json", sourceBundle([document]));
        await saveJSON("model.json", spec);
        await saveJSON("session.json", {
          format: "chipsim-session",
          version: 1,
          modelId: spec.id,
          model: spec,
          parameters,
          inputs,
          duration: spec.duration,
          tick: 0,
          display: "hex",
        });
        for (const [name, content] of [
          [
            "trace.json",
            exportJSON({ ...spec, spec }, trace, parameters, inputs),
          ],
          ["trace.csv", exportCSV(spec, trace)],
          ["trace.vcd", exportVCD(spec, trace)],
        ]) {
          await writeFile(join(root, name), content, { flag: "wx" });
          artifacts[name] = join(root, name);
        }
      }
      const report = {
        ...envelope,
        ok: true,
        command,
        source,
        model: spec.id,
        events: inputs.length,
        ...(checks
          ? { checks, scope: spec.scope, assumptions: spec.assumptions }
          : {}),
        artifacts,
        ...(command === "registers"
          ? {
              tui: [
                "chipsim",
                "--document",
                artifacts["source.csv"],
                "--model",
                artifacts["session.json"],
              ],
            }
          : {}),
      };
      await writeJSON(join(root, "result.json"), report);
      return report;
    });
    return { result, exitCode: 0 };
  } catch (error) {
    return {
      result: { ...envelope, ok: false, error: error.message },
      exitCode: 2,
    };
  }
}

export async function main(args) {
  const { result, exitCode } = await tableCommand(args);
  process.stdout.write(jsonText(result));
  process.exitCode = exitCode;
  return result;
}
