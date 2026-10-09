import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { readTableLayouts } from "../src/model/tables/layout.js";
import { readSequentialTable } from "../src/model/tables/sequential-read.js";
import { simulateModel } from "../src/model/engine.js";
import { validateModel, ModelError } from "../src/model/validate.js";
import { inputDeclarations } from "../src/model/tables/pins.js";
import { clockMask } from "../src/model/tables/clock-patterns.js";
import { TuiState } from "../src/tui/state.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";
import { exportJSON, exportVCD } from "../src/trace/export.js";

const path = new URL("../docs/references/sn74ahc273-q1/ti-sn74ahc273-q1.pdf", import.meta.url)
  .pathname;
const documentPromise = extractPDFFile(path);
const specPromise = documentPromise.then(
  (document) => analyzeDocument(document).models[0].spec,
);
const event = (tick, pin, value) => ({ tick, signal: "pin_" + pin, value });
const pins = (tick, clr, clk, d) => [
  event(tick, "clr", clr),
  event(tick, "clk", clk),
  event(tick, "d", d),
];

test("real wrapped definitions, tightly positioned Q subscript, typed clock declaration, and inactive-clock list compile without chip fingerprint rules", async () => {
  const document = await documentPromise,
    result = analyzeDocument(document),
    spec = result.models[0].spec;
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.models.length, 1);
  assert.equal(spec.id, "state-table-832098c1b03b-p12-t71");
  assert.equal(spec.checks.length, 32);
  assert.ok(result.models[0].checks.every((check) => check.passed));
  assert.equal(spec.sourceTable.symbolRows[1].inputs[1], "L, H, ↓");
  assert.equal(spec.sourceTable.symbolRows[1].outputs[0], "Q0");
  assert.deepEqual(spec.sourceTable.rows[1].inputs[1], { clock: 13 });
  assert.deepEqual(spec.sourceTable.clock.edges, ["rise"]);
  assert.equal(spec.sourceTable.clock.pairs, true);
  assert.equal(spec.sourceTable.instances.length, 1);
  assert.equal(spec.registers.length, 3);
  assert.match(spec.scope, /package replication and wiring are omitted/);
  assert.deepEqual(validateModel(spec, [document]).warnings, []);
  assert.deepEqual(inputDeclarations(document.pages[2], "CLK"), [
    {
      page: 3,
      pin: "11",
      description: "Clock for all channels, rising edge triggered",
      valid: true,
    },
  ]);
  const renamed = {
    ...document,
    title: "Unfamiliar device",
    filename: "different.pdf",
    sha256: "b".repeat(64),
  };
  const unknown = analyzeDocument(renamed).models[0].spec;
  assert.deepEqual(unknown.states, spec.states);
  assert.deepEqual(unknown.sourceTable, spec.sourceTable);
  // Output values are read from the table, even when the part name is unchanged.
  const changed = structuredClone(document);
  const row = changed.pages[11].layoutLines.find(
    (line) =>
      line.cells.length === 4 &&
      line.cells[1].text === "↑" &&
      line.cells[2].text === "H",
  );
  row.cells[3].text = "L";
  const adapted = analyzeDocument(changed).models[0].spec;
  assert.equal(
    simulateModel(
      adapted,
      {},
      { inputs: [...pins(0, 1, 0, 1), event(1, "clk", 1)], ticks: 1 },
    )[1].signals.pin_q,
    0,
  );
});

test("independent flip-flop oracle checks all four-step input sequences from both initial states, with reset priority and no invented tick-zero edge", async () => {
  const spec = await specPromise;
  for (const initialOutputs of [0, 1])
    for (let sequence = 0; sequence < 8 ** 4; sequence++) {
      const inputs = [],
        expected = [],
        pairs = [];
      let q = initialOutputs,
        previous = 0;
      for (let tick = 0; tick < 4; tick++) {
        const value = Math.floor(sequence / 8 ** tick) % 8,
          clr = value >> 2,
          clk = (value >> 1) & 1,
          d = value & 1;
        inputs.push(...pins(tick, clr, clk, d));
        if (!clr) q = 0;
        else if (tick > 0 && previous === 0 && clk === 1) q = d;
        expected.push(q);
        pairs.push(tick === 0 ? clk * 3 : previous * 2 + clk);
        previous = clk;
      }
      const trace = simulateModel(
        spec,
        { initialOutputs },
        { inputs, ticks: 3 },
      );
      assert.deepEqual(
        trace.map((snapshot) => snapshot.signals.pin_q),
        expected,
        "sequence " + sequence + ", initial " + initialOutputs,
      );
      assert.deepEqual(
        trace.map((snapshot) => snapshot.registers.pair_pin_clk),
        pairs,
      );
      assert.ok(trace.every((snapshot) => snapshot.phase === "running"));
    }
});

test("steady-high data changes retain, falling clocks retain, rising clocks capture, and asynchronous clear acts before/without an edge", async () => {
  const spec = await specPromise;
  const trace = simulateModel(
    spec,
    { initialOutputs: 1 },
    {
      ticks: 10,
      inputs: [
        ...pins(0, 1, 1, 0),
        event(1, "d", 1),
        event(2, "d", 0),
        event(3, "clk", 0),
        event(4, "clk", 1),
        event(5, "d", 1),
        event(6, "clr", 0),
        event(7, "clr", 1),
        event(8, "clk", 0),
        event(9, "clk", 1),
      ],
    },
  );
  assert.deepEqual(
    trace.map((snapshot) => snapshot.signals.pin_q),
    [1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1],
  );
  for (const tick of [1, 2, 3, 5, 7, 8, 10])
    assert.match(trace[tick].message, /row 2: no change/);
  assert.match(trace[4].message, /row 3: specified/);
  assert.match(trace[6].message, /row 1: specified/);
  assert.match(trace[9].message, /row 4: specified/);
});

test("undefined/qualified retention, conflicting or misplaced clock lists, missing edge rows, and loose subscript geometry require review", async () => {
  const document = await documentPromise,
    raw = readTableLayouts(document).tables[0];
  for (const change of [
    (table) => {
      table.legend = table.legend.replace(
        "Q0 = previous state",
        "Q0 = unspecified",
      );
    },
    (table) => {
      table.outputs[0] = "Y";
    },
    (table) => {
      table.outputs = ["Q", "QB"];
      table.rawRows.forEach((row) => row.outputs.push("L"));
    },
    (table) => {
      table.rawRows[1].inputs[1] = "L, L, ↓";
    },
    (table) => {
      table.rawRows[1].inputs[1] = "L, H, ↑";
    },
    (table) => {
      table.rawRows[1].inputs[1] = "L, H, ?";
    },
    (table) => {
      table.rawRows[1].outputs[0] = "H";
    },
    (table) => {
      table.rawRows[1].inputs[0] = "L, H, ↓";
      table.rawRows[1].inputs[1] = "X";
    },
    (table) => {
      table.rawRows.splice(3, 1);
    },
    (table) => {
      table.legend = table.legend.replace(
        "↓ = input transitioning from high to low",
        "↓ = unknown",
      );
    },
    (table) => {
      table.legend = table.legend.replace(
        "H = output high",
        "H = output unknown",
      );
    },
  ]) {
    const copy = structuredClone(raw);
    change(copy);
    assert.throws(() => readSequentialTable(copy, document));
  }
  assert.equal(clockMask("L, H, ↓"), 13);
  const loose = structuredClone(document);
  const row = loose.pages[11].layoutLines.find(
    (line) =>
      line.cells.some((cell) => cell.text === "Q") &&
      line.cells.some((cell) => cell.text === "0"),
  );
  row.cells.find((cell) => cell.text === "0").x += 2;
  assert.equal(analyzeDocument(loose).models.length, 0);
  for (const change of [
    (copy) => {
      const note = copy.pages[11].layoutLines.find((line) =>
        line.cells.some((cell) => cell.text === "state"),
      );
      note.cells.push({ text: "unless disabled", x: 420, width: 40 });
    },
    (copy) => {
      const note = copy.pages[11].layoutLines.find(
        (line) => line.cells[0].text === "high,",
      );
      note.cells[0].x += 4;
    },
  ]) {
    const copy = structuredClone(document);
    change(copy);
    assert.equal(analyzeDocument(copy).models.length, 0);
  }
});

test("typed pin direction, edge wording, local role definitions, and pin conflicts are validated before compilation", async () => {
  const document = await documentPromise;
  const clockRow = (copy) =>
    copy.pages[2].layoutLines.find((line) => line.cells[0].text === "CLK");
  for (const change of [
    (copy) => {
      clockRow(copy).cells.find((cell) => cell.text === "I").text = "O";
    },
    (copy) => {
      clockRow(copy).cells.find((cell) => cell.text === "I").text = "I/O";
    },
    (copy) => {
      clockRow(copy).cells.find((cell) => cell.text === "rising").text =
        "falling";
    },
    (copy) => {
      clockRow(copy).cells.push({ text: "unless selected", x: 400, width: 60 });
    },
    (copy) => {
      const note = copy.pages[2].layoutLines.find((line) =>
        line.cells.some((cell) => cell.text === "Types:"),
      );
      note.cells.push({ text: "sometimes", x: 310, width: 30 });
    },
    (copy) => {
      copy.pages[2].layoutLines = copy.pages[2].layoutLines.filter(
        (line) => line !== clockRow(copy),
      );
    },
    (copy) => {
      const extra = structuredClone(copy.pages[2]);
      extra.number = 31;
      extra.layoutLines.find(
        (line) => line.cells[0].text === "CLK",
      ).cells[1].text = "12";
      copy.pages.push(extra);
    },
  ]) {
    const copy = structuredClone(document);
    change(copy);
    assert.equal(analyzeDocument(copy).models.length, 0);
  }
});

test("source metadata rejects malformed masks, mismatched symbols, and unsupported retention without incidental TypeErrors", async () => {
  const spec = await specPromise;
  for (const change of [
    (table) => {
      table.rows[1].inputs[1] = { clock: 0 };
    },
    (table) => {
      table.rows[1].inputs[1] = { clock: 16 };
    },
    (table) => {
      table.rows[1].inputs[1] = { clock: 13, extra: true };
    },
    (table) => {
      table.rows[1].inputs[1] = { clock: 14 };
    },
    (table) => {
      table.rows[1].outputs[0] = 0;
    },
    (table) => {
      delete table.clock.pairs;
    },
    (table) => {
      table.clock = null;
    },
    (table) => {
      table.retention.definition = "unknown";
    },
    (table) => {
      delete table.retention;
    },
    (table) => {
      table.symbolRows = {};
    },
    (table) => {
      table.symbolRows[1].outputs = null;
    },
    (table) => {
      table.symbolRows[1].inputs[1] = "L, H, ?";
    },
  ]) {
    const copy = structuredClone(spec);
    change(copy.sourceTable);
    assert.throws(() => validateModel(copy), ModelError);
  }
});

test("real PDF TUI retains source notation, supports scheduled experiments and sessions, and exports the same trace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-clock-patterns-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(path);
  state.setInputs([
    ...pins(0, 1, 1, 1),
    event(1, "d", 0),
    event(2, "clk", 0),
    event(3, "clk", 1),
  ]);
  state.setParameter("initialOutputs", 1);
  assert.deepEqual(
    state.trace.slice(0, 4).map((snapshot) => snapshot.signals.pin_q),
    [1, 1, 1, 0],
  );
  state.seek(1);
  state.stimulus.schedule("pin_clr", 0, 4);
  assert.equal(state.trace[4].signals.pin_q, 0);
  state.stimulus.undo();
  assert.ok(
    state.config.inputs.every(
      (input) => input.signal !== "pin_clr" || input.tick !== 4,
    ),
  );
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    for (const view of ["wave", "inspect", "registers", "stimulus", "model"]) {
      state.setView(view);
      const frame = render(state);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
    }
  }
  state.setView("model");
  state.infoScroll = 10000;
  assert.match(screenText(state), /L, H, ↓/);
  assert.match(screenText(state), /Q0/);
  const json = JSON.parse(
    exportJSON(
      state.model,
      state.trace,
      state.config.parameters,
      state.config.inputs,
    ),
  );
  assert.deepEqual(json.trace, state.trace);
  assert.equal(json.model.definition.sourceTable.retention.symbol, "Q0");
  assert.match(exportVCD(state.model, state.trace), /registers_pair_pin_clk/);
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(state.session());
  assert.deepEqual(restored.trace, state.trace);
  assert.equal(restored.tick, 1);
});
