import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { readTableLayouts } from "../src/model/tables/layout.js";
import { simulateModel } from "../src/model/engine.js";
import { TuiState } from "../src/tui/state.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";

const path = new URL(
  "../docs/references/renesas-hd74hc138.pdf",
  import.meta.url,
).pathname;
const document = extractPDFFile(path);
const labels = ["G1", "G2A", "G2B", "C", "B", "A"];
const events = (word, tick) =>
  labels.map((label, at) => ({
    tick,
    signal: "pin_" + label.toLowerCase(),
    value: (word >> (5 - at)) & 1,
  }));
// Independently derived from the description/table: enable + 3-bit select.
function expectDecoder(snapshot, word) {
  const enabled = (word & 56) === 32,
    selected = word & 7;
  for (let output = 0; output < 8; output++)
    assert.equal(
      snapshot.signals["pin_y" + output],
      enabled && selected === output ? 0 : 1,
    );
}
test("original hierarchical decoder table compiles all 64 combinations and responds to changing inputs", async () => {
  const doc = await document,
    analysis = analyzeDocument(doc);
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(analysis.models.length, 1);
  const { spec, checks } = analysis.models[0];
  assert.equal(checks.length, 64);
  assert.ok(checks.every((check) => check.passed));
  assert.deepEqual(spec.sourceTable.inputs, labels);
  assert.deepEqual(
    spec.sourceTable.outputs,
    Array.from({ length: 8 }, (_, at) => "Y" + at),
  );
  assert.equal(spec.sourceTable.instances.length, 1);
  assert.equal(spec.signals.length, 14);
  assert.equal(spec.sourceTable.page, 4);
  const sequence = Array.from({ length: 128 }, (_, tick) => (tick * 17) % 64);
  const trace = simulateModel(
    spec,
    {},
    {
      ticks: 127,
      inputs: sequence.flatMap((word, tick) => events(word, tick)),
    },
  );
  trace.forEach((snapshot, tick) => expectDecoder(snapshot, sequence[tick]));
  assert.match(spec.scope, /No analog.*propagation delays/);
});
test("centered layout and tightly adjacent subscripts survive translated/scaled geometry without a device fingerprint", async () => {
  for (const scale of [0.8, 1.2]) {
    const doc = structuredClone(await document);
    doc.sha256 = "e".repeat(64);
    doc.filename = "unfamiliar-decoder.pdf";
    for (const page of doc.pages)
      for (const line of page.layoutLines || []) {
        line.y *= scale;
        for (const cell of line.cells) {
          cell.x = cell.x * scale + 41;
          cell.width *= scale;
        }
      }
    const analysis = analyzeDocument(doc);
    assert.deepEqual(analysis.diagnostics, []);
    assert.deepEqual(analysis.models[0].spec.sourceTable.inputs, labels);
    expectDecoder(
      simulateModel(
        analysis.models[0].spec,
        {},
        { inputs: events(37, 0), ticks: 1 },
      )[0],
      37,
    );
  }
});
test("explicit qualified Enable Inputs / Select Inputs groups identify the same complete decoder columns", async () => {
  const doc = structuredClone(await document),
    page = doc.pages[3],
    parent = page.layoutLines.findIndex(
      (line) => line.cells.length === 1 && line.cells[0].text === "Inputs",
    ),
    children = page.layoutLines[parent + 1];
  children.cells = children.cells.map((cell) =>
    cell.text === "Outputs"
      ? cell
      : {
          ...cell,
          text: cell.text + " Inputs",
          x: cell.x + cell.width / 2 - 35,
          width: 70,
        },
  );
  page.layoutLines.splice(parent, 1);
  const analysis = analyzeDocument(doc);
  assert.deepEqual(analysis.diagnostics, []);
  assert.deepEqual(analysis.models[0].spec.sourceTable.inputs, labels);
  expectDecoder(
    simulateModel(
      analysis.models[0].spec,
      {},
      { inputs: events(39, 0), ticks: 1 },
    )[0],
    39,
  );
});
test("misaligned/ambiguous groups, separated numeric labels, missing definitions/cells and qualified legend prose require review", async () => {
  const mutations = [
    (page) => {
      // Collapsing column spacing makes many whole hierarchies fit the same
      // centers. An ambiguous subgroup must not select a shorter input span.
      for (const line of page.layoutLines)
        for (const cell of line.cells) {
          cell.x = 60 + cell.x * 0.002;
          cell.width *= 0.002;
        }
    },
    (page) => {
      page.layoutLines
        .find((line) => line.cells.some((cell) => cell.text === "Outputs"))
        .cells.find((cell) => cell.text === "Outputs").x += 12;
    },
    (page) => {
      page.layoutLines
        .find((line) => line.cells.some((cell) => cell.text === "Enable"))
        .cells.find((cell) => cell.text === "Enable").x += 20;
    },
    (page) => {
      const row = page.layoutLines.find((line) =>
        line.cells.some((cell) => cell.text === "G1"),
      );
      row.cells.find((cell) => cell.text === "0").x += 3;
    },
    (page) => {
      const row = page.layoutLines.find(
        (line) => line.cells.length === 14 && line.cells[0].text === "X",
      );
      row.cells.splice(7, 1);
    },
    (page) => {
      page.layoutLines = page.layoutLines.filter(
        (line) => !/^X\s*:/.test(line.cells.map((cell) => cell.text).join(" ")),
      );
    },
    (page) => {
      const row = page.layoutLines.find((line) =>
        /^H\s*:/.test(line.cells.map((cell) => cell.text).join(" ")),
      );
      row.cells.push({ text: "only after settling", x: 170, width: 80 });
    },
  ];
  for (const mutate of mutations) {
    const doc = structuredClone(await document);
    mutate(doc.pages[3]);
    const analysis = analyzeDocument(doc);
    assert.equal(analysis.models.length, 0);
    assert.ok(analysis.diagnostics.length);
  }
});
test("source data selects logic; changed output cells change the generated behavior", async () => {
  const doc = structuredClone(await document),
    page = doc.pages[3];
  for (const line of page.layoutLines)
    if (line.cells.length === 14 && /^[HLX]$/.test(line.cells[0].text))
      line.cells[6].text = "L";
  const analysis = analyzeDocument(doc);
  assert.deepEqual(analysis.diagnostics, []);
  const trace = simulateModel(
    analysis.models[0].spec,
    {},
    { inputs: events(0, 0), ticks: 1 },
  );
  assert.equal(trace[0].signals.pin_y0, 0);
  assert.equal(trace[0].signals.pin_y1, 1);
  assert.equal(readTableLayouts(doc).tables[0].rawRows[0].outputs[0], "L");
});
test("a missing header cannot borrow the next table's centered headings or rows", async () => {
  const doc = structuredClone(await document),
    page = doc.pages[3];
  const at = page.layoutLines.findIndex((line) =>
    line.cells.some((cell) => cell.text === "Function"),
  );
  page.layoutLines.splice(at, 0, {
    y: page.layoutLines[at].y - 5,
    cells: [{ text: "Table X. Function Table", x: 56, width: 150 }],
  });
  page.text = "Table X. Function Table\n" + page.text;
  const analysis = analyzeDocument(doc);
  assert.equal(analysis.models.length, 1);
  assert.equal(analysis.models[0].spec.sourceTable.caption, "Function Table");
  assert.ok(
    analysis.diagnostics.some(
      (issue) => issue.caption === "Table X. Function Table",
    ),
  );
});
test("PDF-only TUI import opens a decoder, retains pin experiments in sessions and shows all outputs at supported sizes", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-decoder-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(path);
  assert.equal(state.models.length, 7);
  assert.equal(state.model.signals.length, 14);
  state.setInputs(events(35, 0));
  state.seek(0);
  expectDecoder(state.snapshot, 35);
  const session = structuredClone(state.session());
  await state.loadSession(session);
  expectDecoder(state.snapshot, 35);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    state.view = "registers";
    state.selected = 13;
    assert.ok(render(state).every((row) => displayWidth(row.text) <= columns));
    assert.match(screenText(state), /pin_y7/);
  }
});
