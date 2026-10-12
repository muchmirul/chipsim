import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModels, defaultParameters } from "../src/models/index.js";
import { simulateModel } from "../src/model/engine.js";
import { stateGraph } from "../src/visualization/state-graph.js";
import { flowFrame, valueBits } from "../src/visualization/flow.js";
import {
  captureExperiment,
  compareExperiments,
  recordedExperiment,
  comparisonJSON,
} from "../src/visualization/experiments.js";
import { exportJSON } from "../src/trace/export.js";
import { TuiState } from "../src/tui/state.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";
import { statesView, flowView, comparisonView } from "../src/ui/visuals.js";
const example = JSON.parse(
  await readFile(
    new URL("../examples/timer.model.json", import.meta.url),
    "utf8",
  ),
);
const pio = builtinModels.find((m) => m.id === "pio");

test("engine records executed priority, sequential transient reads, lazy selection and explicit self-transition", () => {
  const spec = structuredClone(example);
  spec.registers[0].width = 4;
  spec.signals.find((s) => s.id === "out").width = 4;
  spec.states = [
    {
      id: "counting",
      entry: [{ target: "reg.count", value: 2 }],
      tick: [],
      transitions: [
        {
          to: "counting",
          when: { op: "eq", args: ["tick", 1] },
          actions: [
            { target: "reg.count", value: 3 },
            {
              target: "reg.count",
              value: { op: "add", args: ["reg.count", 5] },
            },
            {
              target: "signal.out",
              value: {
                op: "select",
                args: [
                  "signal.enable",
                  "reg.count",
                  { op: "div", args: [1, 0] },
                ],
              },
            },
          ],
        },
        { to: "counting", when: false, actions: [] },
      ],
    },
  ];
  const trace = simulateModel(spec, {}, { ticks: 2, inputs: [] });
  assert.deepEqual(trace[1].transition, {
    from: "counting",
    to: "counting",
    index: 0,
  });
  assert.equal(trace[2].transition, null);
  assert.equal(trace[1].registers.count, 2);
  assert.equal(trace[1].signals.out, 8);
  assert.deepEqual(trace[1].operations[1].reads, [
    { field: "reg.count", value: 3 },
  ]);
  assert.deepEqual(trace[1].operations[2].reads, [
    { field: "signal.enable", value: 1 },
    { field: "reg.count", value: 8 },
  ]);
  assert.equal(trace[1].operations[3].stage, "state entry");
  const graph = stateGraph({ ...spec, kind: "document", spec }, trace, 1);
  assert.equal(graph.selectedTransition, "counting:0");
  assert.deepEqual(graph.edges.find((e) => e.id === "counting:0").ticks, [1]);
  assert.deepEqual(graph.edges.find((e) => e.hold).ticks, [2]);
  const old = structuredClone(trace);
  old.forEach((s) => delete s.transition);
  assert.equal(stateGraph({ ...spec, spec }, old, 1).selectedTransition, null);
});

test("recording remains bounded without skipping actions or losing fault prefixes", () => {
  const spec = structuredClone(example),
    assignments = Array.from({ length: 64 }, () => ({
      target: "reg.count",
      value: { op: "add", args: ["reg.count", 1] },
    }));
  spec.states[0].entry = assignments;
  spec.states[0].tick = assignments;
  spec.states[0].transitions = [
    { to: "counting", when: true, actions: assignments },
  ];
  const trace = simulateModel(spec, {}, { ticks: 1, inputs: [] });
  assert.equal(trace[1].operationCount, 192);
  assert.equal(trace[1].operations.length, 64);
  assert.equal(trace[1].registers.count, 256);
  spec.states[0].tick = [
    { target: "reg.count", value: 7 },
    { target: "reg.count", value: { op: "div", args: [1, 0] } },
  ];
  const fault = simulateModel(spec, {}, { ticks: 2, inputs: [] });
  assert.equal(fault[1].phase, "fault");
  assert.equal(fault[1].registers.count, 7);
  assert.equal(fault[1].operations.length, 1);
  assert.equal(fault[1].transition, null);
});

test("every supplied serial example shows captures of zero and one without inventing a tick-zero edge", () => {
  for (const model of builtinModels) {
    const parameters = { ...defaultParameters(model), payload: 2 },
      trace = model.simulate(parameters);
    assert.equal(flowFrame(model, trace, 0, parameters).sampled, false);
    const first = trace.find((s) => s.registers.samples === 1),
      second = trace.find((s) => s.registers.samples === 2);
    assert.equal(flowFrame(model, trace, first.tick, parameters).sampled, true);
    assert.equal(flowFrame(model, trace, first.tick, parameters).data, 0);
    assert.equal(flowFrame(model, trace, second.tick, parameters).data, 1);
    const graph = stateGraph(model, trace, 32);
    assert.ok(graph.edges.some((e) => e.to === "success" && e.ticks.length));
    assert.ok(graph.edges.some((e) => e.to === "timeout" && !e.ticks.length));
  }
  const params = { ...defaultParameters(pio), stress: true };
  assert.equal(flowFrame(pio, pio.simulate(params), 0, params).launched, false);
  assert.equal(valueBits("Z", 4), "ZZZZ");
  assert.equal(valueBits(0, 4), "0000");
  assert.equal(valueBits(undefined, 4), "????");
});

test("captured experiments freeze declarations, settings and trace, and comparison preserves coverage and configuration", () => {
  const model = {
      id: "m",
      signals: [{ id: "q", width: 1, triState: true }],
      registers: [],
    },
    trace = [
      {
        tick: 0,
        state: "run",
        phase: "running",
        signals: { q: "Z" },
        registers: {},
      },
    ],
    session = {
      parameters: { value: 0 },
      inputs: [{ tick: 0, signal: "q", value: 0 }],
      duration: 1,
    };
  const baseline = captureExperiment(model, trace, session);
  model.signals[0].width = 2;
  session.parameters.value = 1;
  trace[0].signals.q = 0;
  const current = {
    model,
    trace: [...trace, { ...trace[0], tick: 1 }],
    session: {
      ...session,
      inputs: [{ value: 0, signal: "q", tick: 0 }],
      duration: 2,
    },
  };
  const comparison = compareExperiments(baseline, current);
  assert.equal(baseline.model.signals[0].width, 1);
  assert.equal(baseline.session.parameters.value, 0);
  assert.equal(comparison.firstDifference, 0);
  assert.equal(comparison.changedTicks, 2);
  assert.deepEqual(comparison.inputChanges, []);
  assert.equal(comparison.widthChanges.length, 1);
  assert.ok(
    comparison.differences[1].changes.some(
      (c) => c.field === "signal.q" && c.before === null && c.after === 0,
    ),
  );
  assert.equal(comparisonJSON(baseline, current).version, 1);
});

test("recorded references validate observation bounds without executing definitions", () => {
  const params = defaultParameters(pio),
    exported = JSON.parse(exportJSON(pio, pio.simulate(params), params));
  const ref = recordedExperiment(exported);
  assert.equal(ref.trace.length, 60);
  assert.match(ref.origin, /not replay-verified/);
  for (const mutate of [
    (d) => (d.trace[2].tick = 99),
    (d) => (d.trace[1].signals.data = 2),
    (d) => (d.trace[0].signals.clock = "<script>"),
    (d) => (d.timing.unit = "ns"),
    (d) => (d.model.signals[0].width = 64),
  ]) {
    const bad = structuredClone(exported);
    mutate(bad);
    assert.throws(() => recordedExperiment(bad));
  }
});

test("terminal visuals fit both sizes; reference import is atomic and comparison cursor never extrapolates", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "chipsim-visuals-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const state = new TuiState({ workspace: path });
  await state.initialize();
  state.seek(32);
  state.pinExperiment();
  const before = structuredClone(state.session());
  await writeFile(
    join(path, "bad.json"),
    JSON.stringify({ ...before, modelId: "missing" }),
  );
  await assert.rejects(state.loadComparisonFile(join(path, "bad.json")));
  assert.deepEqual(state.session(), before);
  const recorded = JSON.parse(
    exportJSON(state.model, state.trace.slice(0, 5), state.parameters),
  );
  await writeFile(join(path, "reference.json"), JSON.stringify(recorded));
  await state.loadComparisonFile(join(path, "reference.json"));
  assert.deepEqual(state.session(), before);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    for (const view of ["states", "flow", "compare"]) {
      state.setView(view);
      const frame = render(state);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((line) => displayWidth(line.text) === columns));
    }
  }
  state.setView("compare");
  state.seek(32);
  assert.match(screenText(state), /unavailable/);
  state.reference.trace = pio.simulate(defaultParameters(pio));
  state.trace = state.trace.slice(0, 2);
  state.comparisonCache = null;
  state.seek(35);
  assert.equal(state.snapshot.state, "unavailable");
  state.setView("wave");
  assert.equal(state.tick, 1);
});

test("browser visual markup escapes imported labels, shows actual reads and unavailable coverage", () => {
  const spec = structuredClone(example);
  spec.states[0].label = '<img src=x onerror="alert(1)">';
  const trace = simulateModel(spec, {}, { ticks: 2 });
  const model = { ...spec, kind: "document", spec };
  const graph = statesView(model, trace, 1);
  assert.ok(!graph.includes("<img"));
  assert.match(graph, /&lt;img/);
  assert.match(graph, /fsm-edge/);
  assert.match(flowView(model, trace, 1, {}, "hex"), /reg.count/);
  const session = { parameters: {}, inputs: [], duration: 2 },
    ref = captureExperiment(model, trace.slice(0, 1), session),
    current = { model, trace, session };
  const html = comparisonView(
    ref,
    current,
    compareExperiments(ref, current),
    2,
    "hex",
  );
  assert.match(html, /unavailable/);
  assert.ok(!html.includes("NaN"));
});
