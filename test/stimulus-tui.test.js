import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";
import { exportJSON, exportVCD } from "../src/trace/export.js";
import { buildScenario } from "../src/model/templates.js";

async function setup(t, manual = "renesas-hd74hc77.pdf") {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-stimulus-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  if (manual) await state.loadFile(join(state.root, "docs/references", manual));
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.isRaw = false;
  input.setRawMode = (raw) => (input.isRaw = raw);
  input.resume = input.pause = () => {};
  output.columns = 120;
  output.rows = 40;
  output.write = () => {};
  const app = new TerminalApp(state, { input, output });
  const key = (text, name = text) => app.key(text, { name });
  const enter = () => key("\r", "return");
  const submit = (text) => {
    for (const char of text) key(char);
    enter();
  };
  return { state, app, key, enter, submit, output };
}
const event = (tick, signal, value) => ({ tick, signal, value });
const data = (tick, value) => event(tick, "pin_data", value);
const enable = (tick, value) => event(tick, "pin_enableg", value);

test("timeline edits preserve later inputs, recompute latch behavior, and round-trip experiment stimulus", async (t) => {
  const { state: s } = await setup(t);
  s.setInputs([enable(0, 1), data(3, 1), enable(5, 0), data(6, 0)]);
  s.seek(7);
  s.stimulus.edit(1, { tick: 4 });
  assert.equal(s.tick, 7);
  assert.equal(s.trace[3].signals.pin_q, 0);
  assert.equal(s.trace[4].signals.pin_q, 1);
  assert.equal(s.trace[6].signals.pin_q, 1);
  assert.deepEqual(s.config.inputs.slice(2), [enable(5, 0), data(6, 0)]);
  const moved = structuredClone(s.config.inputs);
  assert.throws(() => s.stimulus.edit(1, { tick: 6 }), /destination tick/);
  assert.deepEqual(s.config.inputs, moved);
  s.stimulus.remove(1);
  assert.ok(s.trace.every((snapshot) => snapshot.signals.pin_q === 0));
  s.stimulus.undo();
  assert.deepEqual(s.config.inputs, moved);
  assert.equal(s.trace[6].signals.pin_q, 1);
  s.stimulus.undo(true);
  assert.equal(s.trace[6].signals.pin_q, 0);
  s.stimulus.schedule("pin_data", 1, 4);
  assert.equal(s.stimulus.history.redo.length, 0);
  s.stimulus.schedule("pin_enableg", 1, 25);
  assert.equal(s.config.duration, 25);
  assert.equal(s.trace.length, 26);
  assert.equal(s.tick, 7);
  assert.equal(s.trace[25].signals.pin_q, 0);
  s.stimulus.undo();
  assert.equal(s.config.duration, 20);
  assert.equal(s.trace.length, 21);
  s.stimulus.undo(true);
  const session = s.session(),
    restored = new TuiState({ workspace: s.workspace.path });
  await restored.initialize();
  await restored.loadSession(session);
  assert.deepEqual(restored.trace, s.trace);
  assert.deepEqual(restored.config.inputs, s.config.inputs);
  assert.deepEqual(
    JSON.parse(
      exportJSON(s.model, s.trace, s.config.parameters, s.config.inputs),
    ).inputs,
    s.config.inputs,
  );
  assert.ok(exportVCD(s.model, s.trace).includes("#25"));
});

test("filtered event indices and imported duplicate pin/tick rows retain exact ordered-event semantics", async (t) => {
  const { state: s } = await setup(t);
  s.setInputs([enable(0, 1), data(3, 0), data(3, 1), enable(5, 0), data(6, 0)]);
  assert.equal(s.trace[3].signals.pin_q, 1);
  s.stimulusFilter = "Data";
  const rows = s.stimulus.events();
  assert.deepEqual(
    rows.map((row) => row.index),
    [1, 2, 4],
  );
  assert.equal(rows[0].superseded, true);
  assert.equal(rows[1].until, 6);
  s.stimulus.remove(rows[1].index);
  assert.equal(s.trace[3].signals.pin_q, 0);
  assert.deepEqual(s.config.inputs, [
    enable(0, 1),
    data(3, 0),
    enable(5, 0),
    data(6, 0),
  ]);
  s.stimulus.undo();
  assert.equal(s.trace[3].signals.pin_q, 1);
  s.stimulus.edit(2, { value: 0 });
  assert.equal(s.stimulus.events()[s.stimulusIndex].index, 2);
  assert.equal(s.trace[3].signals.pin_q, 0);
  s.stimulus.undo();
  assert.throws(() => s.stimulus.schedule("pin_data", 0, 3), /already drives/);
  s.stimulusFilter = "6";
  assert.deepEqual(
    s.stimulus.events().map((row) => row.index),
    [4],
  );
  s.stimulus.edit(4, { value: 1 });
  assert.equal(s.config.inputs[4].value, 1);
  assert.equal(s.config.inputs[1].value, 0);
  s.stimulusFilter = "no such pin";
  s.setView("stimulus");
  assert.match(screenText(s), /No events match/);
});

test("invalid event edits and faulting bulk imports, removals, and history restores are atomic", async (t) => {
  const { state: s } = await setup(t);
  const model = structuredClone(s.model.spec);
  model.id = "faulting-stimulus-probe";
  model.exampleInputs = [];
  model.checks = [
    { name: "Safe zero data", ticks: 1, expect: { "signal.pin_q": 1 } },
  ];
  const actions = [
    {
      target: "signal.pin_q",
      value: {
        op: "div",
        args: [1, { op: "sub", args: [1, "signal.pin_data"] }],
      },
    },
  ];
  for (const state of model.states) {
    state.entry = actions;
    state.tick = actions;
  }
  await s.installModel(model);
  s.setInputs([data(0, 1), data(0, 0)]);
  s.seek(3);
  const original = {
    trace: s.trace,
    config: structuredClone(s.config),
    history: structuredClone(s.stimulus.history),
  };
  for (const change of [
    () => s.setInputs([data(0, 1)]),
    () => s.stimulus.edit(1, { value: 1 }),
    () => s.stimulus.remove(1),
    () => s.stimulus.schedule("pin_data", 1, 7),
    () => s.stimulus.schedule("pin_q", 0, 2),
    () => s.stimulus.edit(0, { tick: -1 }),
    () => s.stimulus.edit(0, { tick: 10001 }),
    () => s.stimulus.edit(0, { value: 2 }),
    () => s.stimulus.remove(-1),
  ]) {
    assert.throws(change);
    assert.equal(s.trace, original.trace);
    assert.equal(s.tick, 3);
    assert.deepEqual(s.config, original.config);
    assert.deepEqual(s.stimulus.history, original.history);
  }
  // A model may change externally; failed history playback cannot consume it.
  s.stimulus.history.undo.push({ inputs: [data(0, 1)], duration: 20 });
  const history = structuredClone(s.stimulus.history);
  assert.throws(() => s.stimulus.undo(), /Division by zero/);
  assert.deepEqual(s.stimulus.history, history);
  assert.equal(s.trace, original.trace);
});

test("terminal event scheduling, value/move menus, delete, clear/restore, and undo/redo work without JSON", async (t) => {
  const { state: s, app, key, enter, submit } = await setup(t);
  key("7");
  assert.equal(s.view, "stimulus");
  key("a");
  key("j");
  enter();
  assert.deepEqual(s.config.inputs, []);
  const schedule = (pin, tick, value) => {
    key("i");
    s.menu.selected = s.menu.items.findIndex((item) => item.value.id === pin);
    enter();
    submit(tick);
    submit(value);
    assert.equal(s.prompt, null);
  };
  schedule("pin_enableg", "0x0", "0b1");
  schedule("pin_data", "0o3", "1");
  assert.equal(s.trace[3].signals.pin_q, 1);
  enter();
  key("j");
  key("j");
  enter();
  submit("0x4");
  assert.equal(s.config.inputs[1].tick, 4);
  assert.equal(s.trace[3].signals.pin_q, 0);
  enter();
  key("j");
  enter();
  submit("0o0");
  assert.equal(s.config.inputs[1].value, 0);
  key("U");
  assert.equal(s.config.inputs[1].value, 1);
  key("R");
  assert.equal(s.config.inputs[1].value, 0);
  key("", "delete");
  assert.equal(s.config.inputs.length, 1);
  key("U");
  assert.equal(s.config.inputs.length, 2);
  key("/");
  submit("Data");
  assert.equal(s.stimulus.events().length, 1);
  key("/");
  app.key("", { ctrl: true, name: "u" });
  enter();
  assert.equal(s.stimulus.events().length, 2);
  key("j");
  enter();
  enter();
  assert.equal(s.view, "wave");
  assert.equal(s.tick, 4);
  key("7");
  key("a");
  key("j");
  key("j");
  enter();
  assert.deepEqual(s.config.inputs, s.model.exampleInputs);
  key("U");
  assert.equal(s.config.inputs.length, 2);
  key("", "tab");
  assert.equal(s.view, "activity");
  key("", "tab");
  assert.equal(s.view, "wave");
});

test("history is bounded and model-local, addressed accesses undo together, and unreachable built-in events are visible", async (t) => {
  const { state: s } = await setup(t, "ti-pca9555.pdf");
  const baseline = structuredClone(s.config),
    baselineTrace = s.trace;
  s.accessRegister("write", 2, 83);
  assert.equal(s.trace[1].registers.output0, 83);
  const experiment = structuredClone(s.config),
    experimentTrace = s.trace;
  s.stimulus.undo();
  assert.deepEqual(s.config, baseline);
  assert.deepEqual(s.trace, baselineTrace);
  s.stimulus.undo(true);
  assert.deepEqual(s.config, experiment);
  assert.deepEqual(s.trace, experimentTrace);
  const modelId = s.modelId;
  s.selectModel("pio");
  const beforeBuiltin = structuredClone(s.config),
    traceBeforeBuiltin = s.trace;
  assert.throws(() => s.stimulus.apply([], { duration: 0 }), /Duration/);
  assert.deepEqual(s.config, beforeBuiltin);
  assert.equal(s.trace, traceBeforeBuiltin);
  s.stimulus.schedule("ack", 1, 100);
  assert.equal(s.stimulus.events()[0].reached, false);
  s.setView("stimulus");
  assert.match(screenText(s), /outside current trace/);
  s.selectModel(modelId);
  s.stimulus.undo();
  assert.deepEqual(s.config, baseline);
  s.selectModel("pio");
  assert.deepEqual(s.config.inputs, [event(100, "ack", 1)]);
  s.stimulus.undo();
  assert.deepEqual(s.config.inputs, []);
  for (let tick = 0; tick < 22; tick++)
    s.stimulus.schedule("ack", tick % 2, tick);
  assert.equal(s.stimulus.history.undo.length, 20);
  s.setParameter("payload", 12);
  assert.equal(s.stimulus.history.undo.length, 0);
});

test("stimulus view fits 80×24 and 120×40 with all 32-bit numeric formats, and CLI shares the view catalog", async (t) => {
  const { state: s, output } = await setup(t, null);
  const quote = "A 32-bit FIFO stores input data.";
  const document = {
    id: "a".repeat(24),
    sha256: "a".repeat(64),
    title: "FIFO scenario",
    filename: "scenario.pdf",
    pages: [{ number: 1, text: quote }],
  };
  s.documents.push(document);
  await s.installModel(
    buildScenario(document, {
      name: "Timeline FIFO",
      kind: "fifo",
      width: 32,
      depth: 4,
      page: 1,
      quote,
      claim: "Selected FIFO scenario",
    }).spec,
  );
  s.setInputs([event(0, "word_in", 0xffffffff)]);
  s.setView("stimulus");
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    s.columns = output.columns = columns;
    s.rows = output.rows = rows;
    for (const [format, value] of [
      ["decimal", "4294967295"],
      ["hex", "0xFFFFFFFF"],
      ["binary", "0b" + "1".repeat(32)],
      ["octal", "0o37777777777"],
    ]) {
      s.format = format;
      const frame = render(s);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((row) => displayWidth(row.text) === columns));
      assert.ok(screenText(s).includes(value), format + " full value");
      assert.match(screenText(s), /STIMULUS/);
    }
  }
  const outputText = execFileSync(
    process.execPath,
    [
      "scripts/chipsim.mjs",
      "--snapshot",
      "--workspace",
      s.workspace.path,
      "--view",
      "stimulus",
      "--columns",
      "80",
      "--rows",
      "24",
    ],
    { cwd: s.root, encoding: "utf8" },
  );
  assert.match(outputText, /STIMULUS/);
  assert.match(outputText, /ACK uses model parameters/);
});
