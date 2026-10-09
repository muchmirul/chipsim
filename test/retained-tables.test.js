import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { readTableLayouts } from "../src/model/tables/layout.js";
import { readRetainedTable } from "../src/model/tables/retained-read.js";
import { buildRetainedTable } from "../src/model/tables/retained-build.js";
import { simulateModel } from "../src/model/engine.js";
import { validateModel, ModelError } from "../src/model/validate.js";
import { TuiState } from "../src/tui/state.js";
import { screenText, render, displayWidth } from "../src/tui/render.js";
import { tableReference } from "../src/ui/render.js";
import { exportCSV, exportJSON, exportVCD } from "../src/trace/export.js";
import { documentTitle } from "../src/documents/title.js";

const manual = new URL(
  "../docs/references/hd74hc77/renesas-hd74hc77.pdf",
  import.meta.url,
).pathname;
const documentPromise = extractPDFFile(manual);
const specPromise = documentPromise.then(
  (document) => analyzeDocument(document).models[0].spec,
);
const event = (tick, signal, value) => ({ tick, signal, value });
const signals = (tick, data, enable) => [
  event(tick, "pin_data", data),
  event(tick, "pin_enableg", enable),
];

test("real unnumbered latch table compiles locally from defined levels and explicit retention without a chip fingerprint", async () => {
  const document = await documentPromise,
    result = analyzeDocument(document);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.models.length, 1);
  const { spec, checks, method } = result.models[0];
  assert.equal(method, "level-sensitive function table");
  assert.equal(spec.sourceTable.compiler, "retained-function-table-v1");
  assert.deepEqual(spec.sourceTable.inputs, ["Data", "EnableG"]);
  assert.deepEqual(spec.sourceTable.outputs, ["Q"]);
  assert.equal(spec.sourceTable.page, 3);
  assert.equal(spec.sourceTable.symbolRows[2].outputs[0], "No change");
  assert.equal(checks.length, 8);
  assert.ok(checks.every((check) => check.passed));
  assert.equal(spec.registers.length, 0);
  assert.equal(spec.sourceTable.clock, undefined);
  assert.equal(spec.signals.length, 3);
  assert.equal(spec.sourceTable.instances.length, 1);
  const unknown = {
    ...document,
    sha256: "b".repeat(64),
    filename: "unfamiliar.pdf",
    title: "Different chip name",
  };
  const generated = analyzeDocument(unknown).models[0].spec;
  assert.deepEqual(generated.states, spec.states);
  assert.deepEqual(generated.sourceTable.matrix, spec.sourceTable.matrix);
  assert.deepEqual(validateModel(spec, [document]).warnings, []);
  assert.match(spec.scope, /package wiring is inferred/);
  const changed = structuredClone(document);
  for (const line of changed.pages[2].layoutLines)
    if (
      line.cells.length === 3 &&
      line.cells.every((cell) => cell.text === "H")
    )
      line.cells[2].text = "L";
  const adapted = analyzeDocument(changed).models[0].spec;
  assert.equal(
    simulateModel(adapted, {}, { inputs: signals(0, 1, 1), ticks: 1 })[0]
      .signals.pin_q,
    0,
  );
});

test("independent latch oracle exhausts all six-step level sequences and both initial states, including immediate tick-zero following", async () => {
  const spec = await specPromise;
  for (const initialOutputs of [0, 1])
    for (let sequence = 0; sequence < 4 ** 6; sequence++) {
      const inputs = [],
        expected = [];
      let q = initialOutputs;
      for (let tick = 0; tick < 6; tick++) {
        const pair = (sequence >> (tick * 2)) & 3,
          data = pair & 1,
          enable = pair >> 1;
        inputs.push(...signals(tick, data, enable));
        if (enable) q = data;
        expected.push(q);
      }
      const trace = simulateModel(
        spec,
        { initialOutputs },
        { ticks: 5, inputs },
      );
      assert.deepEqual(
        trace.map((snapshot) => snapshot.signals.pin_q),
        expected,
      );
    }
  const demo = simulateModel(spec);
  assert.equal(demo[4].signals.pin_enableg, 1);
  assert.equal(demo[6].signals.pin_enableg, 1);
  assert.equal(demo[4].signals.pin_q, 0);
  assert.equal(demo[6].signals.pin_q, 1);
  assert.equal(demo[8].signals.pin_q, 1);
  assert.equal(demo[10].signals.pin_data, 0);
  assert.equal(demo[10].signals.pin_q, 1);
});

test("undefined levels, wildcard meanings, gaps, conflicting retained states, unsupported symbols, and misleading merged headings reject", async () => {
  const document = await documentPromise,
    raw = readTableLayouts(document).tables[0];
  const variants = [
    (table) => (table.legend = "H: High level X: Irrelevant"),
    (table) => (table.legend = "H: High level L: Low level"),
    (table) => table.rawRows.pop(),
    (table) => table.rawRows.push({ inputs: ["X", "L"], outputs: ["H"] }),
    (table) => (table.rawRows[2].outputs[0] = "Q0"),
    (table) => (table.rawRows[2].outputs[0] = "Z"),
    (table) => (table.rawRows[0].inputs[0] = "h"),
    (table) => (table.rawRows[0].inputs[1] = "↑"),
    (table) => (table.rawRows[2].inputs = ["H", "H"]),
  ];
  for (const mutate of variants) {
    const table = structuredClone(raw);
    mutate(table);
    assert.throws(() => readRetainedTable(table));
  }
  const partial = structuredClone(document);
  partial.pages[2].layoutLines
    .find((line) => line.cells.some((cell) => cell.text === "Irrelevant"))
    .cells.push({ text: "only after reset", x: 170, width: 50 });
  assert.equal(analyzeDocument(partial).models.length, 0);
  assert.match(
    analyzeDocument(partial).diagnostics[0].reason,
    /complete and unqualified/,
  );
  const separated = structuredClone(document);
  const heading = separated.pages[2].layoutLines.find((line) =>
    line.cells.some((cell) => cell.text === "Enable"),
  );
  heading.cells.find((cell) => cell.text === "Enable").x -= 60;
  assert.equal(analyzeDocument(separated).models.length, 0);
  const agreeing = structuredClone(raw);
  agreeing.rawRows.push(structuredClone(agreeing.rawRows[2]));
  assert.deepEqual(
    readRetainedTable(agreeing).matrix,
    readRetainedTable(raw).matrix,
  );
});

test("bounded two-output tables cover 64 states, maintain independent outputs, and reject oversized or malformed metadata", async () => {
  const document = await documentPromise;
  const raw = {
    page: 3,
    number: "test",
    caption: "Function Table",
    inputs: ["A", "B", "G", "Ignored"],
    outputs: ["Y", "W"],
    legend: "H = HIGH; L = LOW; X = don't care",
    rawRows: [
      { inputs: ["X", "X", "L", "X"], outputs: ["no change", "no change"] },
    ],
  };
  for (const a of ["L", "H"])
    for (const b of ["L", "H"])
      raw.rawRows.push({ inputs: [a, b, "H", "X"], outputs: [a, b] });
  const table = readRetainedTable(raw),
    spec = buildRetainedTable(document, table).spec;
  assert.equal(table.matrix.length, 64);
  assert.equal(spec.checks.length, 64);
  for (let initialOutputs = 0; initialOutputs < 4; initialOutputs++)
    for (let value = 0; value < 16; value++) {
      const inputs = [
        event(1, "pin_a", value & 1),
        event(1, "pin_b", (value >> 1) & 1),
        event(1, "pin_g", (value >> 2) & 1),
        event(1, "pin_ignored", value >> 3),
      ];
      const trace = simulateModel(
        spec,
        { initialOutputs },
        { inputs, ticks: 1 },
      );
      assert.equal(
        trace[1].signals.pin_y,
        value & 4 ? value & 1 : initialOutputs & 1,
      );
      assert.equal(
        trace[1].signals.pin_w,
        value & 4 ? (value >> 1) & 1 : initialOutputs >> 1,
      );
    }
  assert.throws(
    () => readRetainedTable({ ...raw, inputs: [...raw.inputs, "TooMany"] }),
    /64 input\/state/,
  );
  const mutations = [
    (m) => (m.sourceTable.clock = { index: 2 }),
    (m) => (m.sourceTable.rows = null),
    (m) => (m.sourceTable.rows[0].outputs = {}),
    (m) => (m.sourceTable.rows[0].inputs[2] = "rise"),
    (m) => m.sourceTable.matrix.pop(),
    (m) => (m.sourceTable.symbolRows[0].outputs[0] = "Q0"),
  ];
  for (const mutate of mutations) {
    const m = structuredClone(spec);
    mutate(m);
    assert.throws(() => validateModel(m), ModelError);
  }
});

test("TUI import, direct input edits, all formats, original source symbols, session restore, and trace exports share retained-state behavior", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-level-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(manual);
  assert.match(state.message, /level-sensitive function table/);
  assert.equal(state.model.sourceTable.instances.length, 1);
  state.seek(4);
  state.driveInput("pin_data", 1);
  assert.equal(state.snapshot.signals.pin_q, 1);
  state.seek(8);
  state.driveInput("pin_data", 0);
  assert.equal(state.snapshot.signals.pin_q, 1);
  for (const format of ["hex", "decimal", "binary", "octal"])
    for (const [columns, rows] of [
      [80, 24],
      [120, 40],
    ])
      for (const view of ["wave", "inspect", "registers", "model", "log"]) {
        state.format = format;
        state.columns = columns;
        state.rows = rows;
        state.setView(view);
        const frame = render(state);
        assert.equal(frame.length, rows);
        assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
      }
  state.setView("model");
  while (!screenText(state).includes("No change") && state.infoScroll < 100)
    state.infoScroll++;
  assert.match(screenText(state), /No change/);
  assert.match(tableReference(state.model), /No change/);
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(state.session());
  assert.deepEqual(restored.trace, state.trace);
  const json = JSON.parse(
    exportJSON(state.model, state.trace, state.config.parameters),
  );
  assert.equal(json.trace[8].signals.pin_q, 1);
  assert.match(exportCSV(state.model, state.trace), /pin_q/);
  assert.match(exportVCD(state.model, state.trace), /signals_pin_q/);
});

test("document CLI produces the same stable table identity and title metadata uses the part-bearing title over a bare revision code", async (t) => {
  const result = JSON.parse(
    execFileSync(process.execPath, ["scripts/document.mjs", manual, "--json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.models[0].spec.id, (await specPromise).id);
  assert.equal(
    documentTitle(
      { Subject: "REJ03D0552-0200", Title: "HD74HC77 Datasheet" },
      "manual.pdf",
    ),
    "HD74HC77 Datasheet",
  );
  assert.equal(
    documentTitle(
      { Subject: "REJ03D0552-0200", Title: "Data Sheet" },
      "manual.pdf",
    ),
    "REJ03D0552-0200",
  );
  assert.equal(
    documentTitle(
      { Subject: "74HC595; 74HCT595", Title: "Data Sheet" },
      "manual.pdf",
    ),
    "74HC595; 74HCT595",
  );
});
