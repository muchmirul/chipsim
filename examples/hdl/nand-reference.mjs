// SPDX-License-Identifier: CC0-1.0
// Export a real datasheet-derived ChipSim model for the HDL NAND probes.
import { resolve, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { extractPDFFile } from "../../src/documents/extract-node.js";
import { analyzeDocument } from "../../src/model/from-document.js";
import { registerModel } from "../../src/models/index.js";
import { exportJSON } from "../../src/trace/export.js";
import { createDirectory, jsonText } from "../../src/agent/io.js";

if (process.argv.length !== 3)
  throw new Error("Usage: node examples/hdl/nand-reference.mjs NEW_DIRECTORY");
const root = resolve(import.meta.dirname, "../..");
const document = await extractPDFFile(
  join(root, "docs/references/74hc00/nexperia-74hc00.pdf"),
);
const model = registerModel(analyzeDocument(document).models[0].spec, [
  document,
]);
const inputs = Array.from({ length: 256 }, (_, tick) => [
  { tick, signal: "pin_1a", value: Math.floor(tick / 16) & 1 },
  { tick, signal: "pin_1b", value: tick & 1 },
]).flat();
const trace = model.simulate({}, { inputs, ticks: 255 });
const result = await createDirectory(process.argv[2], async (out) => {
  await writeFile(
    join(out, "trace.json"),
    exportJSON(model, trace, {}, inputs),
    { flag: "wx" },
  );
  const common = {
    mode: "sampled",
    rightTick: "5ns",
    sampleEvery: "5ns",
    from: "0ns",
    to: "1275ns",
  };
  const signals = [
    { left: "adder_tb.nand_a", right: "signal.pin_1a", role: "input" },
    { left: "adder_tb.nand_b", right: "signal.pin_1b", role: "input" },
    { left: "adder_tb.nand_probe", right: "signal.pin_1y", role: "output" },
  ];
  await writeFile(join(out, "mapping.json"), jsonText({ ...common, signals }), {
    flag: "wx",
  });
  return {
    trace: join(out, "trace.json"),
    map: join(out, "mapping.json"),
    source: document.sha256,
    checks: model.checks.length,
  };
});
process.stdout.write(jsonText(result));
