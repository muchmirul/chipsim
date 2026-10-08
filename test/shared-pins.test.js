import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { hasTableLayout } from "../src/documents/layout.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { instancesFor } from "../src/model/tables/pins.js";
import { simulateModel } from "../src/model/engine.js";
import { buildScenario } from "../src/model/templates.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { screenText, render, displayWidth } from "../src/tui/render.js";
const path = new URL("../docs/references/nexperia-74hc157.pdf", import.meta.url)
  .pathname;
const document = extractPDFFile(path);
async function setup(t) {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-shared-pins-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(path);
  const output = new EventEmitter();
  output.columns = 80;
  output.rows = 24;
  output.write = () => {};
  return {
    state,
    app: new TerminalApp(state, { input: new EventEmitter(), output }),
  };
}
test("real multiplexer PDF derives four channels with one select and enable: all 1024 package vectors", async () => {
  const result = analyzeDocument(await document);
  assert.equal(result.models.length, 1);
  assert.deepEqual(result.diagnostics, []);
  const spec = result.models[0].spec;
  assert.equal(spec.sourceTable.instances.length, 4);
  assert.equal(spec.signals.length, 14);
  assert.equal(
    spec.signals.filter((signal) => signal.id === "pin_e").length,
    1,
  );
  assert.equal(
    spec.signals.filter((signal) => signal.id === "pin_s").length,
    1,
  );
  assert.equal(spec.checks.length, 16);
  for (const check of spec.checks) {
    assert.equal(check.inputs.length, 10);
    assert.equal(new Set(check.inputs.map((event) => event.signal)).size, 10);
  }
  // Independent oracle from the documented select/enable behavior, without
  // consulting the compiler's matrix or generated acceptance cases.
  for (let vector = 0; vector < 1024; vector++) {
    const enable = (vector >> 8) & 1,
      select = (vector >> 9) & 1;
    const inputs = [
      { tick: 0, signal: "pin_e", value: enable },
      { tick: 0, signal: "pin_s", value: select },
    ];
    for (let channel = 1; channel <= 4; channel++)
      for (let source = 0; source < 2; source++)
        inputs.push({
          tick: 0,
          signal: `pin_${channel}i${source}`,
          value: (vector >> ((channel - 1) * 2 + source)) & 1,
        });
    const trace = simulateModel(spec, {}, { inputs, ticks: 1 });
    for (const snapshot of trace)
      for (let channel = 1; channel <= 4; channel++)
        assert.equal(
          snapshot.signals[`pin_${channel}y`],
          enable ? 0 : (vector >> ((channel - 1) * 2 + select)) & 1,
        );
  }
  const unknown = structuredClone(await document);
  unknown.sha256 = "e".repeat(64);
  unknown.filename = "unknown-vendor.pdf";
  unknown.title = "Unknown vendor";
  assert.equal(analyzeDocument(unknown).models[0].spec.signals.length, 14);
});
test("shared controls require unambiguous single input pins; missing roles and conflicting declarations reject", async () => {
  const original = await document;
  const table = analyzeDocument(original).models[0].table;
  const row = (page) =>
    page.layoutLines.find(
      (line) =>
        line.cells[0]?.text === "E" &&
        line.cells.some((cell) => cell.text === "enable"),
    );
  for (const mutate of [
    (copy) => {
      const line = row(copy.pages[2]);
      line.cells.find((cell) => cell.text === "input").text = "output";
    },
    (copy) => {
      row(copy.pages[2]).cells.find((cell) => cell.text === "15").text =
        "15,16";
    },
    (copy) => {
      copy.pages[2].layoutLines = copy.pages[2].layoutLines.filter(
        (line) => line !== row(copy.pages[2]),
      );
    },
    (copy) => {
      const extra = structuredClone(copy.pages[2]);
      extra.number = 16;
      row(extra).cells.find((cell) => cell.text === "15").text = "20";
      copy.pages.push(extra);
    },
  ]) {
    const copy = structuredClone(original);
    mutate(copy);
    assert.throws(() => instancesFor(copy, table), /Shared control E/);
    assert.equal(analyzeDocument(copy).models.length, 0);
  }
  assert.throws(
    () => instancesFor(original, { ...table, outputs: ["Y", "nY"] }),
    /shared output/i,
  );
  const partial = structuredClone(original);
  partial.pages[2].text = partial.pages[2].text.replace(
    "1I1 to 4I1",
    "1I1 to 3I1",
  );
  assert.throws(
    () => instancesFor(partial, table),
    /same documented instance set/,
  );
});
test("pin description geometry can reside on a separate source page", async () => {
  const copy = structuredClone(await document),
    page = copy.pages[2];
  const split = page.layoutLines.findIndex((line) =>
    line.cells
      .map((cell) => cell.text)
      .join(" ")
      .startsWith("6. Functional description"),
  );
  const pins = {
    number: 16,
    text: page.text.slice(0, page.text.indexOf("6. Functional description")),
    layoutLines: page.layoutLines.slice(0, split),
  };
  page.text = page.text.slice(page.text.indexOf("6. Functional description"));
  page.layoutLines = page.layoutLines.slice(split);
  copy.pages.push(pins);
  copy.pageCount++;
  assert.equal(hasTableLayout(pins.text), true);
  const result = analyzeDocument(copy);
  assert.equal(result.models.length, 1);
  assert.equal(
    result.models[0].spec.evidence.find((e) => e.id === "pin-instances").page,
    16,
  );
});
test("TUI input editor accepts every number format, preserves the cursor and later events, and persists session stimulus", async (t) => {
  const { state, app } = await setup(t);
  state.seek(2);
  state.format = "decimal";
  const before = structuredClone(state.config.inputs);
  for (const value of ["1", "0x1", "0b1", "0o1"]) {
    app.key("i", { name: "i" });
    assert.equal(state.menu.title, "DRIVE INPUT · tick 2");
    app.key("\r", { name: "return" });
    for (const char of value) app.key(char, { name: char });
    app.key("\r", { name: "return" });
    assert.equal(state.prompt, null);
    assert.equal(state.tick, 2);
    assert.equal(state.format, "decimal");
    assert.equal(state.snapshot.signals.pin_e, 1);
    for (let channel = 1; channel <= 4; channel++)
      assert.equal(state.snapshot.signals[`pin_${channel}y`], 0);
  }
  assert.equal(state.config.inputs.length, before.length);
  assert.deepEqual(
    state.config.inputs.filter((event) => event.tick > 2),
    before.filter((event) => event.tick > 2),
  );
  assert.equal(state.trace[4].signals.pin_e, 0);
  app.key("i", { name: "i" });
  app.key("\r", { name: "return" });
  app.key("2", { name: "2" });
  app.key("\r", { name: "return" });
  assert.match(state.prompt.error, /Invalid 1-bit/);
  assert.equal(state.snapshot.signals.pin_e, 1);
  app.key("", { name: "escape" });
  const session = state.session(),
    restored = new TuiState({ workspace: state.workspace.path });
  await restored.initialize();
  await restored.loadSession(session);
  assert.deepEqual(restored.config.inputs, state.config.inputs);
  assert.equal(restored.tick, 2);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    state.view = "inspect";
    const frame = render(state);
    assert.equal(frame.length, rows);
    assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
    assert.match(screenText(state), /Blocks/);
  }
});
test("driving rejects output pins and preserves the last working trace on arithmetic faults", async (t) => {
  const { state } = await setup(t);
  const previous = state.trace,
    inputs = structuredClone(state.config.inputs);
  assert.throws(() => state.driveInput("pin_1y", 1), /Unknown input/);
  assert.throws(() => state.driveInput("pin_e", 1, -1), /current trace/);
  assert.equal(state.trace, previous);
  assert.deepEqual(state.config.inputs, inputs);
  const probe = structuredClone(state.model.spec);
  probe.id = "fault-probe";
  probe.checks = [
    {
      name: "Safe inactive control",
      ticks: 1,
      inputs: [],
      expect: { "signal.pin_1y": 1 },
    },
  ];
  probe.exampleInputs = [];
  const actions = [
    {
      target: "signal.pin_1y",
      value: { op: "div", args: [1, { op: "sub", args: [1, "signal.pin_e"] }] },
    },
  ];
  probe.states[0].entry = actions;
  probe.states[0].tick = actions;
  await state.installModel(probe);
  state.seek(1);
  const working = state.trace;
  assert.throws(
    () => state.driveInput("pin_e", 1),
    /Simulation fault at tick 1: Division by zero/,
  );
  assert.equal(state.trace, working);
  assert.deepEqual(state.config.inputs, []);
  assert.equal(state.tick, 1);
});
test("driving a 32-bit FIFO data input accepts its maximum value and rejects overflow", async (t) => {
  const { state } = await setup(t);
  const doc = await document;
  const generated = buildScenario(doc, {
    kind: "fifo",
    name: "32-bit FIFO",
    width: 32,
    depth: 4,
    page: 3,
    quote: "Function table",
    claim:
      "Explicit FIFO scenario for testing input editing; not mux behavior.",
  });
  await state.installModel(generated.spec);
  const input = state.model.signals.find(
    (signal) => signal.width === 32 && signal.direction === "input",
  );
  state.driveInput(input.id, 0xffffffff);
  assert.equal(state.snapshot.signals[input.id], 0xffffffff);
  assert.throws(() => state.driveInput(input.id, 2 ** 32), /Invalid 32-bit/);
  assert.equal(state.snapshot.signals[input.id], 0xffffffff);
});
