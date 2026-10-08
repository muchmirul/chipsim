import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { simulateModel, evaluate } from "../src/model/engine.js";
import { validateModel, ModelError } from "../src/model/validate.js";
import { exportJSON, exportCSV, exportVCD } from "../src/trace/export.js";
import { registerModel } from "../src/models/index.js";
import { TuiState } from "../src/tui/state.js";
import { screenText, render, displayWidth } from "../src/tui/render.js";
import { waveform } from "../src/ui/render.js";
import { formatPayload } from "../src/core/values.js";
import { EventEmitter } from "node:events";
import { TerminalApp } from "../src/tui/app.js";
const path = new URL("../docs/references/ti-sn74lvc1g125.pdf", import.meta.url)
  .pathname;
const document = extractPDFFile(path);
const compiled = document.then((doc) => analyzeDocument(doc).models[0].spec);
const events = (tick, value) => [
  { tick, signal: "pin_oe", value: (value >> 1) & 1 },
  { tick, signal: "pin_a", value: value & 1 },
];
test("a complete 32-row tri-state table compiles within expression bounds and evaluates every input", () => {
  const caption = "Table 1. Function table",
    legend = "Z = High Impedance State";
  const line = (words) => ({
    y: 0,
    cells: words.map((text, index) => ({ text, x: index * 80, width: 10 })),
  });
  const body = Array.from({ length: 32 }, (_, value) =>
    line([
      ...Array.from({ length: 5 }, (_, bit) =>
        String((value >> (4 - bit)) & 1),
      ),
      value & 16 ? "Z" : String(value & 1),
    ]),
  );
  const doc = {
    sha256: "f".repeat(64),
    filename: "logic.pdf",
    title: "Published binary-input logic",
    pages: [
      {
        number: 1,
        text: caption + "\n" + legend,
        layoutLines: [
          line([caption]),
          line([legend]),
          {
            y: 0,
            cells: [
              { text: "Inputs", x: 0, width: 30 },
              { text: "Output", x: 400, width: 30 },
            ],
          },
          line(["A", "B", "C", "D", "E", "Y"]),
          ...body,
          line(["2. Limiting values"]),
        ],
      },
    ],
  };
  const result = analyzeDocument(doc);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.models.length, 1);
  const spec = result.models[0].spec;
  assert.equal(spec.checks.length, 32);
  for (let value = 0; value < 32; value++) {
    const inputs = ["a", "b", "c", "d", "e"].map((pin, bit) => ({
      tick: 0,
      signal: "pin_" + pin,
      value: (value >> (4 - bit)) & 1,
    }));
    const trace = simulateModel(spec, {}, { inputs, ticks: 1 });
    assert.equal(trace[0].signals.pin_y, value & 16 ? "Z" : value & 1);
    assert.notEqual(trace[1].phase, "fault");
  }
});
function rows(doc) {
  return doc.pages[10].layoutLines.filter(
    (line) =>
      line.cells.length === 3 &&
      line.cells.every((cell) => /^[HLXZ]$/.test(cell.text)),
  );
}
test("real buffer PDF derives tri-state behavior from complete rows and numbered symbol definitions", async () => {
  const doc = await document,
    result = analyzeDocument(doc);
  assert.equal(result.models.length, 1);
  assert.deepEqual(result.diagnostics, []);
  const spec = result.models[0].spec;
  assert.equal(spec.sourceTable.compiler, "tri-state-function-table-v1");
  assert.match(spec.name, /SN74LVC1G125/);
  assert.equal(spec.sourceTable.page, 11);
  assert.deepEqual(spec.sourceTable.matrix, [[0], [1], ["Z"], ["Z"]]);
  assert.equal(spec.signals.find((s) => s.id === "pin_y").triState, true);
  assert.equal(spec.checks.length, 4);
  assert.ok(result.models[0].checks.every((check) => check.passed));
  assert.ok(spec.evidence.some((item) => item.id === "output-release"));
  validateModel(spec, [doc]);
  const unknown = {
    ...doc,
    sha256: "c".repeat(64),
    filename: "new-device.pdf",
    title: "New vendor",
  };
  assert.deepEqual(
    analyzeDocument(unknown).models[0].spec.sourceTable.matrix,
    spec.sourceTable.matrix,
  );
});
test("independent oracle covers every three-step input sequence, release, disabled data changes, and re-enable", async () => {
  const spec = await compiled;
  for (let sequence = 0; sequence < 64; sequence++) {
    const inputs = Array.from({ length: 3 }, (_, tick) =>
      events(tick, (sequence >> (tick * 2)) & 3),
    ).flat();
    const trace = simulateModel(spec, {}, { inputs, ticks: 2 });
    assert.equal(trace.length, 3);
    for (const snapshot of trace) {
      assert.notEqual(snapshot.phase, "fault");
      assert.equal(
        snapshot.signals.pin_y,
        snapshot.signals.pin_oe ? "Z" : snapshot.signals.pin_a,
      );
    }
  }
  const changed = structuredClone(await document);
  for (const line of rows(changed))
    line.cells[0].text = line.cells[0].text === "H" ? "L" : "H";
  const other = analyzeDocument(changed).models[0].spec;
  for (let value = 0; value < 4; value++) {
    const s = simulateModel(
      other,
      {},
      { inputs: events(0, value), ticks: 1 },
    )[0];
    assert.equal(s.signals.pin_y, s.signals.pin_oe ? s.signals.pin_a : "Z");
  }
});
test("undefined Z, input Z, unknown outputs, conflicts, blanks, and qualified/incomplete footnotes reject", async () => {
  const original = await document;
  const cases = [
    (doc) => {
      for (const line of doc.pages[10].layoutLines)
        for (const c of line.cells)
          if (c.text === "Impedance") c.text = "Numeric";
    },
    (doc) => {
      rows(doc)[0].cells[0].text = "Z";
    },
    (doc) => {
      rows(doc)[0].cells[2].text = "X";
    },
    (doc) => {
      rows(doc)[0].cells[0].text = "H";
    },
    (doc) => {
      rows(doc)[0].cells.pop();
    },
    (doc) => {
      const row = rows(doc)[1];
      doc.pages[10].layoutLines.splice(
        doc.pages[10].layoutLines.indexOf(row),
        1,
      );
    },
    (doc) => {
      doc.pages[10].layoutLines = doc.pages[10].layoutLines.filter(
        (line) => !line.cells.some((c) => c.text === "Driving"),
      );
    },
    (doc) => {
      const line = doc.pages[10].layoutLines.find((line) =>
        line.cells.some((c) => c.text === "Driving"),
      );
      line.cells.push({ text: "after settling", x: 500, width: 50 });
    },
    (doc) => {
      const line = doc.pages[10].layoutLines.find((line) =>
        line.cells.some((c) => c.text === "Driving"),
      );
      line.cells.splice(line.cells.findIndex((c) => c.text === "Impedance"));
    },
    (doc) => {
      const lines = doc.pages[10].layoutLines;
      const index = lines.findIndex((line) =>
        line.cells.some((c) => c.text === "Driving"),
      );
      lines.splice(index + 1, 0, {
        y: lines[index].y + 10,
        cells: [{ text: "Only after settling time", x: 180, width: 160 }],
      });
    },
  ];
  for (const mutate of cases) {
    const doc = structuredClone(original);
    mutate(doc);
    const result = analyzeDocument(doc);
    assert.equal(result.models.length, 0);
    assert.ok(result.diagnostics.length);
  }
});
test("Z cannot be coerced by arithmetic, bitwise, logical, ordering, or branching operators", () => {
  const context = { signals: { released: "Z" } };
  for (const op of [
    "add",
    "sub",
    "mul",
    "div",
    "mod",
    "lt",
    "le",
    "gt",
    "ge",
    "and",
    "or",
    "bitAnd",
    "bitOr",
    "bitXor",
    "shiftLeft",
    "shiftRight",
  ]) {
    for (const args of [
      ["signal.released", 1],
      [1, "signal.released"],
    ])
      assert.throws(() => evaluate({ op, args }, context), /High-impedance Z/);
  }
  assert.throws(
    () => evaluate({ op: "not", args: ["signal.released"] }, context),
    /High-impedance Z/,
  );
  assert.throws(
    () => evaluate({ op: "select", args: ["signal.released", 1, 0] }, context),
    /logical condition/,
  );
  assert.equal(
    evaluate({ op: "eq", args: ["signal.released", "Z"] }, context),
    true,
  );
  assert.equal(
    evaluate({ op: "ne", args: ["signal.released", 0] }, context),
    true,
  );
  assert.equal(
    evaluate(
      { op: "select", args: [true, "Z", { op: "div", args: [1, 0] }] },
      context,
    ),
    "Z",
  );
});
test("only declared tri-state outputs accept Z; malformed definitions and snapshots reject safely", async () => {
  const spec = await compiled;
  for (const mutate of [
    (s) => {
      s.signals[2].triState = "yes";
    },
    (s) => {
      s.signals[0].triState = true;
    },
    (s) => {
      s.signals[0].initial = "Z";
    },
    (s) => {
      delete s.signals[2].triState;
    },
    (s) => {
      s.sourceTable.rows[0].inputs[0] = "Z";
    },
    (s) => {
      s.sourceTable.rows[0].outputs[0] = "X";
    },
    (s) => {
      s.sourceTable.rows = null;
    },
    (s) => {
      s.sourceTable.matrix = null;
    },
    (s) => {
      s.sourceTable.matrix[0][0] = "hold";
    },
    (s) => {
      s.checks[0].expect["signal.pin_oe"] = "Z";
    },
  ]) {
    const copy = structuredClone(spec);
    mutate(copy);
    assert.throws(() => validateModel(copy), ModelError);
  }
  const inputs = [{ tick: 0, signal: "pin_a", value: "Z" }];
  assert.throws(
    () => simulateModel(spec, {}, { inputs }),
    /Invalid 1-bit input/,
  );
  const copy = structuredClone(spec);
  delete copy.sourceTable;
  copy.registers.push({ id: "number", width: 8, initial: 0 });
  copy.states[0].entry = [
    { target: "reg.number", value: { op: "select", args: [true, "Z", 0] } },
  ];
  const failed = simulateModel(copy);
  assert.equal(failed.length, 1);
  assert.match(failed[0].detail, /Z requires a tri-state output/);
  copy.states[0].entry = [{ target: "signal.pin_y", value: "Z" }];
  copy.states[0].tick = [];
  copy.states[0].transitions[0].when = "signal.pin_y";
  assert.match(simulateModel(copy).at(-1).detail, /logical condition/);
});
test("JSON, CSV, VCD, browser SVG, and whole-bus output Z preserve the same released state", async () => {
  const spec = await compiled,
    model = registerModel(spec),
    trace = simulateModel(spec);
  assert.equal(
    JSON.parse(exportJSON(model, trace, {})).trace[4].signals.pin_y,
    "Z",
  );
  assert.match(exportCSV(model, trace), /"Z"/);
  assert.match(exportVCD(model, trace), /#4\nb1 v0\nb0 v1\nbz v2/);
  const svg = waveform(model, trace, 4);
  assert.match(svg, /high-impedance/);
  assert.match(svg, /high impedance/);
  assert.ok(!/NaN|undefined/.test(svg));
  for (const format of ["hex", "decimal", "binary", "octal"])
    assert.equal(formatPayload("Z", format, 32), "Z");
  const bus = structuredClone(spec);
  delete bus.sourceTable;
  bus.signals[2].width = 32;
  bus.signals[2].initial = "Z";
  bus.states[0].entry = [];
  bus.states[0].tick = [];
  bus.states[0].transitions = [];
  bus.checks = [
    { name: "Released whole bus", ticks: 1, expect: { "signal.pin_y": "Z" } },
  ];
  const busModel = registerModel(bus),
    busTrace = simulateModel(bus);
  assert.match(exportVCD(busModel, busTrace), /bz{32} v2/);
  assert.equal(busTrace[0].signals.pin_y, "Z");
});
test("terminal import, direct input experiments, Z waveforms, edge navigation, and sessions work offline", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-tri-state-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(path);
  state.selected = 2;
  state.seek(4);
  assert.equal(state.snapshot.signals.pin_y, "Z");
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    Object.assign(state, { columns, rows, view: "wave" });
    assert.match(screenText(state), /Z/);
    for (const view of ["wave", "inspect", "registers", "log", "model"]) {
      state.view = view;
      assert.equal(render(state).length, rows);
      assert.ok(
        render(state).every((row) => displayWidth(row.text) <= columns),
      );
    }
  }
  state.setDuration(12);
  state.setInputs([
    ...events(0, 0),
    ...events(2, 1),
    ...events(4, 2),
    ...events(8, 0),
    ...events(9, 1),
  ]);
  const output = new EventEmitter();
  Object.assign(output, { columns: 80, rows: 24, write: () => {} });
  const app = new TerminalApp(state, { input: new EventEmitter(), output });
  state.seek(0);
  app.key("f", { name: "f" });
  app.key("z", { name: "z" });
  app.key("\r", { name: "return" });
  assert.equal(state.tick, 4, "f finds a released output");
  state.seek(2);
  state.jumpEdge("fall");
  assert.equal(state.tick, 2, "release to Z is not a falling binary edge");
  state.seek(4);
  state.jumpEdge("any");
  assert.equal(state.tick, 8);
  state.seek(4);
  state.jumpEdge("rise");
  assert.equal(state.tick, 9);
  state.seek(4);
  state.driveInput("pin_oe", 0);
  assert.equal(state.tick, 4);
  assert.equal(state.snapshot.signals.pin_y, 0);
  assert.throws(() => state.driveInput("pin_y", 0), /Unknown input/);
  const session = state.session();
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(session);
  assert.equal(restored.tick, 4);
  assert.equal(restored.snapshot.signals.pin_y, 0);
  assert.equal(restored.trace[9].signals.pin_y, 1);
});
test("document CLI writes a tri-state model with the PDF fingerprint and executable checks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chipsim-tri-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "buffer.model.json");
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/document.mjs", path, "--out", output, "--json"],
      { encoding: "utf8" },
    ),
  );
  const spec = JSON.parse(await readFile(output));
  assert.equal(spec.sources[0].sha256, (await document).sha256);
  assert.ok(report.models[0].checks.every((check) => check.passed));
  validateModel(spec, [await document]);
});
