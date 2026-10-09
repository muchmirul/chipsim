import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { buildBehaviorTable } from "../src/model/behavior-table/build.js";
import { readBehaviorTable } from "../src/model/behavior-table/read.js";
import { simulateModel } from "../src/model/engine.js";
import { validateModel } from "../src/model/validate.js";
import { exportJSON, exportVCD, exportCSV } from "../src/trace/export.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { behaviorRows } from "../src/tui/behavior-table-editor.js";
import { render, displayWidth, screenText } from "../src/tui/render.js";

const manual = {
  id: "test-manual",
  filename: "manual.pdf",
  title: "Illustrative control scenario",
  sha256: "b".repeat(64),
  pages: [
    {
      number: 1,
      text: "The state and output can depend on the input controls.",
    },
  ],
};
const base = {
  name: "Developer control experiment",
  inputs: "RESET ENABLE",
  outputs: "Q",
  states: "idle armed",
  rules: await readFile(
    new URL("../examples/control.rules.txt", import.meta.url),
    "utf8",
  ),
  page: 1,
  quote: manual.pages[0].text,
  claim:
    "Illustrative control scenario; the entered rules are explicit developer choices.",
};
const event = (tick, name, value) => ({
  tick,
  signal: "pin_" + name.toLowerCase(),
  value,
});
const spec = buildBehaviorTable(manual, base).spec;

test("developer-entered FSM covers prior outputs, reports exact rows, and uses independently checked reset/enable/hold behavior across all five-step sequences", () => {
  assert.equal(spec.checks.length, 16);
  assert.equal(spec.sourceTable, undefined);
  assert.match(spec.scope, /not inferred from the PDF/);
  for (let initialState = 0; initialState < 2; initialState++)
    for (let initialOutputs = 0; initialOutputs < 2; initialOutputs++)
      for (let sequence = 0; sequence < 1024; sequence++) {
        const inputs = [];
        for (let tick = 1; tick <= 5; tick++) {
          const value = (sequence >> (2 * (tick - 1))) & 3;
          inputs.push(
            event(tick, "reset", value >> 1),
            event(tick, "enable", value & 1),
          );
        }
        const trace = simulateModel(
          spec,
          { initialState: initialState ? "armed" : "idle", initialOutputs },
          { inputs, ticks: 5 },
        );
        let state = initialState,
          q = initialOutputs;
        assert.equal(trace[0].state, "initialize");
        assert.equal(trace[0].registers.behavior_state, state);
        assert.equal(trace[0].signals.pin_q, q);
        for (let tick = 1; tick <= 5; tick++) {
          const value = (sequence >> (2 * (tick - 1))) & 3;
          if (value & 2) {
            state = 0;
            q = 0;
          } else if (value & 1) {
            state = 1 - state;
            q = state;
          }
          assert.equal(trace[tick].state, state ? "state_armed" : "state_idle");
          assert.equal(trace[tick].registers.behavior_state, state);
          assert.equal(trace[tick].signals.pin_q, q);
          assert.match(trace[tick].message, /Entered row \d:/);
        }
      }
});

test("an original NAND datasheet backs manually entered rows without treating them as automatically extracted rules", async () => {
  const document = await extractPDFFile(
    new URL("../docs/references/74hc00/nexperia-74hc00.pdf", import.meta.url).pathname,
  );
  const { spec, checks } = buildBehaviorTable(document, {
    name: "Reviewed single NAND table",
    inputs: "A B",
    outputs: "Y",
    states: "logic",
    rules: await readFile(
      new URL("../examples/nand.rules.txt", import.meta.url),
      "utf8",
    ),
    page: 3,
    quote: "Quad 2-input NAND gate",
    claim:
      "The page identifies NAND logic; entered rows correspond to the manually reviewed function table on this page.",
    assumptions:
      "One manually selected gate; package replication is omitted. Updates occur at normalized behavior steps, not physical propagation delays.",
  });
  assert.equal(checks.length, 4);
  assert.ok(checks.every((item) => item.passed));
  assert.deepEqual(validateModel(spec, [document]).warnings, []);
  for (const a of [0, 1])
    for (const b of [0, 1]) {
      const trace = simulateModel(
        spec,
        {},
        { inputs: [event(1, "A", a), event(1, "B", b)], ticks: 2 },
      );
      assert.equal(trace[1].signals.pin_y, Number(!(a && b)));
      assert.equal(trace[2].signals.pin_y, trace[1].signals.pin_y);
    }
  assert.throws(
    () => buildBehaviorTable(document, { ...base, page: 3 }),
    /quote does not occur/,
  );
});

test("explicit clock-history states model rising capture and retain through held/falling clocks, independently of pin names", async () => {
  const document = await extractPDFFile(
      new URL("../docs/references/sn74ahc273-q1/ti-sn74ahc273-q1.pdf", import.meta.url)
        .pathname,
    ),
    rules = await readFile(
      new URL("../examples/flip-flop.rules.txt", import.meta.url),
      "utf8",
    ),
    { spec, checks } = buildBehaviorTable(document, {
      name: "Entered clock-history experiment",
      inputs: "CLK D",
      outputs: "Q",
      states: "low high",
      rules,
      page: 12,
      quote: "input transitioning from low to high",
      claim:
        "Table 7-1 defines rising-edge data capture and retention. The entered states represent the previous clock; CLR is held high as a selected scenario.",
      assumptions:
        "One selected flip-flop with CLR fixed high. Initial history must match the separately driven tick-zero clock. Package channels, asynchronous clear, and physical timing are omitted.",
    });
  assert.equal(checks.length, 16);
  for (const initialClock of [0, 1])
    for (const initialOutputs of [0, 1])
      for (let sequence = 0; sequence < 256; sequence++) {
        const inputs = [event(0, "CLK", initialClock)];
        for (let tick = 1; tick <= 4; tick++) {
          const pair = (sequence >> (2 * (tick - 1))) & 3;
          inputs.push(
            event(tick, "CLK", pair >> 1),
            event(tick, "D", pair & 1),
          );
        }
        const trace = simulateModel(
          spec,
          { initialState: initialClock ? "high" : "low", initialOutputs },
          { inputs, ticks: 4 },
        );
        let previous = initialClock,
          q = initialOutputs;
        assert.equal(trace[0].signals.pin_q, q);
        for (let tick = 1; tick <= 4; tick++) {
          const pair = (sequence >> (2 * (tick - 1))) & 3,
            clock = pair >> 1,
            d = pair & 1;
          if (!previous && clock) q = d;
          assert.equal(trace[tick].signals.pin_q, q);
          assert.equal(trace[tick].registers.behavior_state, clock);
          previous = clock;
        }
      }
});

test("held columns, output bit ordering, boundary tables, and agreeing overlaps remain explicit", () => {
  const table = buildBehaviorTable(manual, {
    ...base,
    inputs: "D",
    outputs: "LOW HIGH",
    states: "one",
    rules: "one 0 -> one / ==; one 1 -> one / 10",
  }).spec;
  assert.equal(table.checks.length, 8);
  const trace = simulateModel(
    table,
    { initialOutputs: 0b10 },
    { inputs: [event(2, "D", 1), event(3, "D", 0)], ticks: 4 },
  );
  assert.deepEqual(
    trace.map((s) => [s.signals.pin_low, s.signals.pin_high]),
    [
      [0, 1],
      [0, 1],
      [1, 0],
      [1, 0],
      [1, 0],
    ],
  );
  const maximum = buildBehaviorTable(manual, {
    ...base,
    inputs: "A B C D E F",
    outputs: "G H I J K L M N",
    states: "one",
    rules: "* XXXXXX -> one / 10101010",
  });
  assert.equal(maximum.checks.length, 64);
  assert.ok(maximum.checks.every((item) => item.passed));
  const states = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];
  assert.equal(
    buildBehaviorTable(manual, {
      ...base,
      inputs: "A",
      outputs: "Y",
      states,
      rules: states.map((state) => `${state} X -> ${state} / 0`).join(";"),
    }).checks.length,
    16,
  );
  assert.doesNotThrow(() =>
    readBehaviorTable({
      inputs: "A",
      outputs: "Y",
      states: "one",
      rules: "* X -> one / =; one 0 -> one / =",
    }),
  );
  for (const name of ["constructor", "prototype", "9".repeat(80)]) {
    const named = buildBehaviorTable(manual, { ...base, name }).spec;
    assert.ok(named.id.startsWith("model-"));
    assert.ok(named.id.length <= 58);
    assert.doesNotThrow(() => validateModel(named, [manual]));
  }
});

test("missing coverage, contradictory retained states, implicit priority, ambiguous identifiers, unsupported syntax, and oversized domains reject authoring", () => {
  for (const change of [
    { inputs: "A A" },
    { outputs: "reset" },
    { states: "idle Idle" },
    { states: "constructor" },
    { inputs: "A\x1b[31m" },
    { rules: "idle 0X -> idle / 0" },
    { rules: base.rules + "; idle X1 -> armed / 1" },
    { rules: base.rules + "; idle 00 -> idle / 0" },
    { rules: base.rules.replace("armed 01 -> idle", "armed 01 -> missing") },
    { rules: base.rules.replace("idle 00", "idle 000") },
    { rules: base.rules.replace("idle / =", "idle / Z") },
    { rules: base.rules.replace("1X", "↑X") },
    { rules: "process.exit()" },
    { rules: "" },
    { rules: "x".repeat(65537) },
    { rules: Array(33).fill("* XX -> idle / 0").join(";") },
    {
      inputs: "A B C D E",
      outputs: "Q",
      states: "idle armed",
      rules: "* XXXXX -> idle / =",
    },
  ])
    assert.throws(() => readBehaviorTable({ ...base, ...change }));
  assert.throws(
    () =>
      readBehaviorTable({
        ...base,
        rules: base.rules + "; idle 00 -> idle / 0",
      }),
    /prior outputs 1/,
  );
  assert.throws(
    () =>
      readBehaviorTable({
        ...base,
        rules: base.rules + "; idle X1 -> armed / 1",
      }),
    /Row order does not establish priority/,
  );
  for (const change of [
    { page: 2 },
    { quote: "a missing statement" },
    { quote: "short" },
    { name: " " },
    { claim: " " },
  ])
    assert.throws(() => buildBehaviorTable(manual, { ...base, ...change }));
});

test("bounded local rule-file loading preserves rows and does not execute imported text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chipsim-behavior-rows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "my rules.txt");
  await writeFile(path, base.rules.replaceAll("; ", "\n") + "\n");
  assert.equal(
    readBehaviorTable({ ...base, rules: await behaviorRows('@"' + path + '"') })
      .cases.length,
    16,
  );
  assert.equal(await behaviorRows(base.rules), base.rules);
  await writeFile(path, "x".repeat(65537));
  await assert.rejects(behaviorRows("@" + path), /at most 64 KiB/);
  await assert.rejects(behaviorRows("@" + root), /regular text file/);
  await assert.rejects(behaviorRows("@" + join(root, "missing")), /ENOENT/);
});

test("TUI creation retries invalid rule/source prompts, preserves the working model until success, and persists portable experiments with readable state/rule provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chipsim-behavior-tui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new TuiState({ workspace: root });
  await state.initialize();
  state.documents.push(manual);
  state.documentId = manual.id;
  const output = Object.assign(new EventEmitter(), {
      columns: 120,
      rows: 40,
      write() {},
    }),
    app = new TerminalApp(state, { output });
  const enter = () => app.key("", { name: "return" });
  async function submit(value = "") {
    state.prompt.value = value;
    enter();
    for (let wait = 0; state.busy && wait < 100; wait++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(state.busy, false);
  }
  app.key("c");
  for (let i = 0; i < 3; i++) app.key("j");
  enter();
  await submit(base.name);
  await submit(base.inputs);
  await submit(base.outputs);
  await submit(base.states);
  await submit("idle 00 -> idle / 0");
  assert.match(state.prompt.error, /No row covers/);
  assert.equal(state.modelId, "pio");
  await submit(base.rules);
  await submit("0x1");
  await submit("Absent statement in manual");
  assert.match(state.prompt.error, /Quote must occur/);
  await submit(base.quote);
  await submit(base.claim);
  await submit();
  assert.equal(state.models.length, 7);
  assert.equal(state.model.name, base.name);
  assert.equal(state.view, "wave");
  state.setInputs([
    event(1, "ENABLE", 1),
    event(2, "ENABLE", 0),
    event(4, "RESET", 1),
  ]);
  state.seek(2);
  assert.equal(state.snapshot.state, "state_armed");
  assert.equal(state.snapshot.signals.pin_q, 1);
  state.stimulus.schedule("pin_reset", 1, 3);
  assert.equal(state.trace[3].state, "state_idle");
  state.stimulus.undo();
  assert.equal(state.trace[3].state, "state_armed");
  const trace = state.trace;
  assert.deepEqual(
    JSON.parse(
      exportJSON(
        state.model,
        trace,
        state.config.parameters,
        state.config.inputs,
      ),
    ).trace,
    trace,
  );
  assert.match(exportCSV(state.model, trace), /state_armed/);
  assert.match(exportVCD(state.model, trace), /registers_behavior_state/);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    for (const view of [
      "wave",
      "inspect",
      "log",
      "model",
      "registers",
      "stimulus",
    ]) {
      state.setView(view);
      const frame = render(state);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((row) => displayWidth(row.text) <= columns));
    }
    state.setView("model");
    state.infoScroll = 10000;
    assert.match(screenText(state), /state_idle|state_armed/);
  }
  const restored = new TuiState({ workspace: root });
  await restored.initialize();
  await restored.loadSession(state.session());
  assert.deepEqual(restored.trace, trace);
  assert.equal(restored.tick, 2);
  app.key("c");
  for (let i = 0; i < 3; i++) app.key("j");
  enter();
  await submit(base.name);
  app.key("", { name: "escape" });
  assert.equal(state.prompt, null);
  assert.equal(state.models.length, 7);
});
