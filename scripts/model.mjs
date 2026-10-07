#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { registerModel, defaultParameters } from "../src/models/index.js";
import { exportCSV, exportJSON, exportVCD } from "../src/trace/export.js";
const [command, file, ...args] = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf("--" + name);
  return index < 0 ? undefined : args[index + 1];
};
if (!["validate", "simulate"].includes(command) || !file) {
  console.error(
    "Usage: npm run model -- validate model.json [--sources manual.sources.json]\n       npm run model -- simulate model.json [--params parameters.json] [--inputs events.json] [--ticks 100] [--format json|csv|vcd] [--out trace.json]",
  );
  process.exit(1);
}
try {
  const spec = JSON.parse(await readFile(file, "utf8")),
    bundle = option("sources")
      ? JSON.parse(await readFile(option("sources"), "utf8"))
      : null;
  if (
    bundle &&
    (bundle.format !== "chipsim-source-bundle" ||
      !Array.isArray(bundle.documents))
  )
    throw new Error("Invalid source bundle");
  const model = registerModel(spec, bundle?.documents || []);
  if (command === "validate") {
    console.log(`${model.id}: ${model.checks.length} acceptance checks passed`);
    for (const warning of model.warnings) console.log("Warning: " + warning);
  } else {
    const parameters = option("params")
        ? JSON.parse(await readFile(option("params"), "utf8"))
        : defaultParameters(model),
      inputs = option("inputs")
        ? JSON.parse(await readFile(option("inputs"), "utf8"))
        : [];
    const trace = model.simulate(parameters, {
      ticks: option("ticks") ? Number(option("ticks")) : undefined,
      inputs,
    });
    if (trace.at(-1).phase === "fault")
      throw new Error("Simulation fault: " + trace.at(-1).detail);
    const format = option("format") || "json";
    if (!["json", "csv", "vcd"].includes(format))
      throw new Error("Use json, csv, or vcd");
    const content =
      format === "csv"
        ? exportCSV(model, trace)
        : format === "vcd"
          ? exportVCD(model, trace)
          : exportJSON(model, trace, parameters, inputs);
    if (option("out")) {
      await writeFile(option("out"), content);
      console.log(`Wrote ${trace.length} snapshots to ${option("out")}`);
    } else process.stdout.write(content + "\n");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
