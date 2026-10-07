import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateModel, ModelError } from "../src/model/validate.js";
import { simulateModel, runChecks } from "../src/model/engine.js";
import { registerModel } from "../src/models/index.js";
import {
  recognizeDocument,
  searchDocument,
  sourceBundle,
} from "../src/documents/recognize.js";
const example = JSON.parse(
  await readFile(
    new URL("../examples/timer.model.json", import.meta.url),
    "utf8",
  ),
);
const clone = () => structuredClone(example);
test("declarative timer acceptance cases and counter trace", () => {
  assert.ok(runChecks(example).every((c) => c.passed));
  const model = registerModel(example);
  const trace = model.simulate({ period: 3 }, { ticks: 7 });
  assert.equal(trace[2].registers.count, 2);
  assert.equal(trace[3].signals.out, 1);
  assert.equal(trace[6].signals.out, 0);
  assert.equal(trace[7].registers.count, 1);
});
test("input events apply before transitions and reset overrides enable", () => {
  const trace = simulateModel(
    example,
    { period: 3 },
    {
      ticks: 6,
      inputs: [
        { tick: 2, signal: "enable", value: 0 },
        { tick: 4, signal: "reset", value: 1 },
        { tick: 5, signal: "reset", value: 0 },
        { tick: 6, signal: "enable", value: 1 },
      ],
    },
  );
  assert.equal(trace[3].registers.count, 1);
  assert.equal(trace[4].registers.count, 0);
  assert.equal(trace[6].registers.count, 1);
});
test("assignments wrap at declared width and execute sequentially", () => {
  const spec = clone();
  spec.registers[0].width = 2;
  spec.states[0].transitions = [
    {
      to: "counting",
      when: true,
      actions: [
        { target: "reg.count", value: { op: "add", args: ["reg.count", 1] } },
        {
          target: "signal.out",
          value: { op: "bitAnd", args: ["reg.count", 1] },
        },
      ],
    },
  ];
  const trace = simulateModel(spec, {}, { ticks: 4 });
  assert.equal(trace[1].signals.out, 1);
  assert.equal(trace[4].registers.count, 0);
});
test("terminal states latch while later external inputs remain observable", () => {
  const spec = clone();
  spec.states.push({
    id: "done",
    entry: [{ target: "signal.out", value: 1 }],
    tick: [],
    transitions: [],
    terminal: true,
  });
  spec.states[0].transitions = [{ to: "done", when: true, actions: [] }];
  const trace = simulateModel(
    spec,
    {},
    { ticks: 3, inputs: [{ tick: 2, signal: "reset", value: 1 }] },
  );
  assert.equal(trace[3].state, "done");
  assert.equal(trace[3].phase, "complete");
  assert.equal(trace[3].signals.reset, 1);
  assert.equal(trace[3].signals.out, 1);
});
test("invalid model structures consistently reject without execution", () => {
  const mutations = [
    (s) => (s.states[0].active = {}),
    (s) => (s.states[0].transitions[0].evidence = {}),
    (s) => (s.nodes[0].registers = {}),
    (s) => (s.edges = [null]),
    (s) => (s.checks = [null]),
    (s) => (s.registers[0].id = "constructor"),
    (s) => (s.states[0].tick = [{ target: "signal.reset", value: 1 }]),
    (s) => (s.initialState = "absent"),
    (s) =>
      (s.states[0].transitions[0].when = { op: "eval", args: ["alert(1)"] }),
    (s) => (s.nodes[0].x = '" onload="alert(1)'),
  ];
  for (const mutate of mutations) {
    const spec = clone();
    mutate(spec);
    assert.throws(() => validateModel(spec), ModelError);
  }
});
test("bad source quotes reject imports, missing documents stay explicitly unverified", () => {
  const source = example.sources[0],
    quote = example.evidence[0].quote;
  const documents = [
    {
      sha256: source.sha256,
      pages: [{ number: 3, text: quote.replaceAll(" ", "\n") }],
    },
  ];
  assert.deepEqual(validateModel(example, documents).warnings, []);
  assert.ok(validateModel(example).warnings.length);
  assert.throws(
    () =>
      validateModel(example, [
        {
          sha256: source.sha256,
          pages: [{ number: 3, text: "unrelated text" }],
        },
      ]),
    /quote does not occur/,
  );
});
test("arithmetic faults stop simulation and failed acceptance cases reject imports", () => {
  const spec = clone();
  spec.states[0].tick = [
    { target: "reg.count", value: { op: "div", args: [1, 0] } },
  ];
  assert.equal(simulateModel(spec).at(-1).phase, "fault");
  assert.throws(() => registerModel(spec), /Acceptance checks failed/);
});
test("stimulus and parameters validate unknown names, ranges and types", () => {
  assert.throws(() => simulateModel(example, { period: 0 }), /integer/);
  assert.throws(
    () => simulateModel(example, { unused: 3 }),
    /Unknown parameter/,
  );
  assert.throws(
    () =>
      simulateModel(
        example,
        {},
        { inputs: [{ tick: 1, signal: "out", value: 0 }] },
      ),
    /Unknown input/,
  );
  assert.throws(
    () =>
      simulateModel(
        example,
        {},
        { inputs: [{ tick: 1, signal: "reset", value: 2 }] },
      ),
    /Invalid/,
  );
});
test("document recognition is bounded; extraction bundles omit PDF bytes", () => {
  const document = {
    filename: "manual.pdf",
    sha256: "a".repeat(64),
    bytes: new Uint8Array([1]),
    pages: [
      { number: 1, text: "An unrelated chip with a FIFO" },
      { number: 2, text: "RP2040 programmable I/O PIO FIFO controls" },
    ],
  };
  assert.equal(recognizeDocument(document).modelId, "pio");
  assert.equal(searchDocument(document, "FIFO controls")[0].page, 2);
  assert.equal(sourceBundle([document]).documents[0].bytes, undefined);
  document.pages.pop();
  assert.equal(recognizeDocument(document), null);
});
