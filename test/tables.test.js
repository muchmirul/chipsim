import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { positionedLines, popplerLines } from "../src/documents/layout.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { readFunctionTables } from "../src/model/tables/read.js";
import { simulateModel } from "../src/model/engine.js";
import { validateModel } from "../src/model/validate.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { EventEmitter } from "node:events";
import { screenText, render, displayWidth } from "../src/tui/render.js";
const path = (part) =>
  new URL("../docs/references/nexperia-74hc" + part + ".pdf", import.meta.url)
    .pathname;
const documents = Promise.all(
  ["00", "86"].map((part) => extractPDFFile(path(part))),
);
function synthetic(
  rows,
  {
    heading = "Input Output",
    names = "A B Y",
    legend = "H = HIGH; L = LOW; X = don’t care.",
    columns = [0, 80, 160],
  } = {},
) {
  const lines = [
    "Table 1. Function table",
    legend,
    heading,
    names,
    ...rows,
    "2. Limiting values",
  ].map((text, index) => ({
    y: index * 20,
    cells:
      index === 2
        ? [
            { text: "Input", x: 0, width: 30 },
            { text: "Output", x: 160, width: 30 },
          ]
        : index >= 3 && index < rows.length + 4
          ? text
              .split(" ")
              .map((text, col) => ({ text, x: columns[col], width: 10 }))
          : [{ text, x: 0, width: text.length * 5 }],
  }));
  return {
    sha256: "a".repeat(64),
    filename: "unfamiliar.pdf",
    title: "Unfamiliar device",
    pages: [
      {
        number: 1,
        text: ["Table 1. Function table", legend, heading, names, ...rows].join(
          "\n",
        ),
        layoutLines: lines,
      },
    ],
  };
}
test("real NAND and XOR tables compile from their rows without fingerprint-specific behavior", async () => {
  const docs = await documents;
  for (let index = 0; index < docs.length; index++) {
    const doc = docs[index],
      result = analyzeDocument(doc);
    assert.equal(result.models.length, 1);
    assert.equal(result.diagnostics.length, 0);
    const spec = result.models[0].spec;
    assert.equal(spec.sourceTable.instances.length, 4);
    assert.equal(spec.signals.length, 12);
    assert.equal(spec.checks.length, 4);
    // Independent exhaustive package oracle, not the compiler's expanded matrix.
    for (let vector = 0; vector < 256; vector++) {
      const inputs = [];
      for (let gate = 1; gate <= 4; gate++) {
        inputs.push(
          {
            tick: 0,
            signal: "pin_" + gate + "a",
            value: (vector >> ((gate - 1) * 2)) & 1,
          },
          {
            tick: 0,
            signal: "pin_" + gate + "b",
            value: (vector >> ((gate - 1) * 2 + 1)) & 1,
          },
        );
      }
      const trace = simulateModel(spec, {}, { inputs, ticks: 1 });
      for (let gate = 1; gate <= 4; gate++) {
        const a = (vector >> ((gate - 1) * 2)) & 1,
          b = (vector >> ((gate - 1) * 2 + 1)) & 1;
        assert.equal(
          trace[0].signals["pin_" + gate + "y"],
          index === 0 ? 1 - (a & b) : a ^ b,
        );
        assert.equal(
          trace[1].signals["pin_" + gate + "y"],
          trace[0].signals["pin_" + gate + "y"],
        );
      }
    }
    // Change the document hash/name: behavior still comes from the actual table.
    const other = {
      ...doc,
      sha256: (index ? "d" : "b").repeat(64),
      filename: "unfamiliar-vendor.pdf",
    };
    assert.equal(
      analyzeDocument(other).models[0].spec.sourceTable.matrix[3][0],
      0,
    );
  }
});
test("table content changes the compiled logic rather than selecting a model by chip name", () => {
  const doc = synthetic(["L L L", "L H L", "H L L", "H H H"]);
  const model = analyzeDocument(doc).models[0];
  assert.ok(model);
  assert.deepEqual(model.spec.sourceTable.matrix, [[0], [0], [0], [1]]);
  const nand = analyzeDocument(synthetic(["L X H", "X L H", "H H L"]))
    .models[0];
  assert.deepEqual(nand.spec.sourceTable.matrix, [[1], [1], [1], [0]]);
});
test("unsupported, incomplete, conflicting, and undefined tables never receive invented behavior", () => {
  const cases = [
    synthetic(["L L L", "H H H"]),
    synthetic(["X X H", "H H L"]),
    synthetic(["L X H", "X L H", "H H Z"]),
    synthetic(["L X H", "X L H", "↑ H L"]),
    synthetic(["L X H", "X L H", "H H L"], {
      legend: "H = HIGH; L = LOW; X = unknown.",
    }),
    synthetic(["L L L", "L H H", "H L H", "H H H"], {
      legend: "No voltage symbols are defined.",
    }),
  ];
  for (const doc of cases) {
    const result = analyzeDocument(doc);
    assert.equal(result.models.length, 0);
    assert.ok(result.diagnostics.length);
  }
  const merged = synthetic(["H X H", "X H", "L L L"]);
  assert.equal(analyzeDocument(merged).models.length, 0);
  const misplaced = synthetic(["L L L", "L H H", "H L H", "H H L"]);
  misplaced.pages[0].layoutLines[4].cells[2].x = 0;
  assert.equal(analyzeDocument(misplaced).models.length, 0);
});
test("layout reconstruction sorts reading order and safely decodes XML text", () => {
  const lines = positionedLines([
    { text: "Output", x: 100, y: 10, width: 30 },
    { text: "Input", x: 0, y: 10, width: 30 },
    { text: "Y", x: 100, y: 30, width: 5 },
  ]);
  assert.deepEqual(
    lines[0].cells.map((cell) => cell.text),
    ["Input", "Output"],
  );
  assert.equal(
    popplerLines(
      '<word xMin="1" yMin="2" xMax="20" yMax="12">A&amp;B</word>',
    )[0].cells[0].text,
    "A&B",
  );
});
test("table metadata rejects malformed fields before either interface renders them", async () => {
  const spec = analyzeDocument((await documents)[0]).models[0].spec;
  for (const mutate of [
    (copy) => copy.sourceTable.rows[0].inputs.push(0),
    (copy) => (copy.sourceTable.instances[0][0] = "missing"),
    (copy) => (copy.sourceTable.matrix = null),
    (copy) => (copy.sourceTable.outputs = ["<script>"]),
  ]) {
    const copy = structuredClone(spec);
    mutate(copy);
    assert.throws(() => validateModel(copy), /sourceTable/);
  }
});
test("PDF-only TUI creation persists real tables and displays their source mapping", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-table-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(path("00"));
  assert.equal(state.model.sourceTable.instances.length, 4);
  assert.match(state.message, /from function table/);
  const saved = JSON.parse(
    await readFile(join(workspace, "models", state.modelId + ".json"), "utf8"),
  );
  assert.equal(saved.sourceTable.page, 3);
  state.view = "model";
  state.rows = 100;
  assert.match(screenText(state), /SOURCE FUNCTION TABLE/);
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadFile(path("00"));
  assert.equal(restored.models.length, 7);
  assert.equal(restored.modelId, state.modelId);
});
test("CLI analysis exports one valid model and returns structured diagnostics", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-table-cli-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const output = join(workspace, "model.json");
  const report = execFileSync(
    process.execPath,
    ["scripts/document.mjs", path("86"), "--out", output, "--json"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(report);
  assert.equal(parsed.models.length, 1);
  assert.equal(parsed.models[0].method, "function table");
  assert.equal(
    JSON.parse(await readFile(output, "utf8")).sourceTable.rows.length,
    4,
  );
});
test("compact terminal block navigation reaches every independently simulated channel", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-block-scroll-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(path("00"));
  const output = new EventEmitter();
  output.columns = 80;
  output.rows = 24;
  output.write = () => {};
  const app = new TerminalApp(state, { input: new EventEmitter(), output });
  state.columns = 80;
  state.rows = 24;
  state.view = "inspect";
  const labels = new Set();
  for (let step = 0; step < 12; step++) {
    const text = screenText(state);
    for (const node of state.model.topology.nodes)
      if (text.includes(node.label)) labels.add(node.label);
    const frame = render(state);
    assert.equal(frame.length, 24);
    assert.ok(frame.every((row) => displayWidth(row.text) <= 80));
    app.key("j", { name: "j" });
  }
  assert.equal(labels.size, state.model.topology.nodes.length);
  assert.equal(state.selected, 0);
  state.columns = 120;
  state.rows = 40;
  screenText(state);
  assert.equal(state.blockScroll, 0);
  state.blockScroll = 3;
  state.selectModel("pio");
  assert.equal(state.blockScroll, 0);
});
