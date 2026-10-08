import test from "node:test";
import assert from "node:assert/strict";
import { buildScenario, suggestScenarios } from "../src/model/templates.js";
import { simulateModel, evaluate } from "../src/model/engine.js";
import { validateModel } from "../src/model/validate.js";
const text =
  "A 16-bit counter is incremented when enabled. The device contains a FIFO and an 8-bit shift register.";
const document = {
  id: "local-test",
  sha256: "a".repeat(64),
  filename: "local-test.pdf",
  pages: [{ number: 1, text }],
};
const settings = {
  name: "Example scenario",
  width: 8,
  depth: 4,
  value: 8,
  page: 1,
  quote: text,
  claim: "Source identifies the counter, FIFO, and shift register.",
};
function build(kind, options = {}) {
  return buildScenario(document, { ...settings, kind, ...options }).spec;
}
test("builders cover directions, boundaries, width extremes, and maximum FIFO depth", () => {
  for (const width of [1, 8, 16, 32])
    for (const direction of ["up", "down"])
      for (const match of ["repeat", "halt"]) {
        const result = buildScenario(document, {
          ...settings,
          kind: "counter",
          width,
          direction,
          match,
          value: 2,
        });
        assert.ok(result.checks.every((c) => c.passed));
      }
  for (const width of [1, 8, 32])
    for (const depth of [1, 4, 16])
      assert.ok(
        buildScenario(document, {
          ...settings,
          kind: "fifo",
          width,
          depth,
        }).checks.every((c) => c.passed),
      );
  for (const width of [1, 8, 32])
    for (const direction of ["lsb", "msb"])
      assert.ok(
        buildScenario(document, {
          ...settings,
          kind: "shifter",
          width,
          direction,
          value: Math.min(179, 2 ** width - 1),
        }).checks.every((c) => c.passed),
      );
});
test("FIFO data ordering survives overflow, pointer wrap, and full read/write replacement", () => {
  const spec = build("fifo", { depth: 2 }),
    inputs = [
      { tick: 1, signal: "write", value: 1 },
      { tick: 1, signal: "word_in", value: 17 },
      { tick: 2, signal: "word_in", value: 34 },
      { tick: 3, signal: "word_in", value: 99 },
      { tick: 4, signal: "read", value: 1 },
      { tick: 4, signal: "word_in", value: 51 },
      { tick: 5, signal: "write", value: 0 },
    ];
  const trace = simulateModel(spec, {}, { ticks: 7, inputs });
  assert.equal(trace[3].signals.overflow, 1);
  assert.equal(trace[3].registers.word0, 17);
  assert.equal(trace[4].signals.word_out, 17);
  assert.equal(trace[4].registers.level, 2);
  assert.equal(trace[5].signals.word_out, 34);
  assert.equal(trace[6].signals.word_out, 51);
  assert.equal(trace[7].signals.underflow, 1);
  assert.equal(trace[7].signals.word_out, 51);
});
test("counter enabled steps and reset priority are independent of direction", () => {
  for (const direction of ["up", "down"]) {
    const spec = build("counter", { direction, match: "halt" });
    const trace = simulateModel(
      spec,
      { period: 3 },
      {
        ticks: 9,
        inputs: [
          { tick: 2, signal: "enable", value: 0 },
          { tick: 4, signal: "enable", value: 1 },
          { tick: 8, signal: "reset", value: 1 },
        ],
      },
    );
    assert.equal(trace[3].registers.count, direction === "up" ? 1 : 1);
    assert.equal(trace[5].state, "halted");
    assert.equal(trace[7].signals.out, 1);
    assert.equal(trace[8].signals.out, 0);
    assert.equal(trace[9].registers.count, direction === "up" ? 0 : 2);
  }
});
test("serial edges present and sample the selected bit order", () => {
  for (const direction of ["lsb", "msb"]) {
    const spec = build("shifter", { width: 8, direction, value: 0xb3 });
    const trace = simulateModel(
      spec,
      {},
      { ticks: 33, inputs: [{ tick: 1, signal: "start", value: 1 }] },
    );
    const bits = trace
      .filter(
        (s, i) =>
          i && s.signals.clock === 1 && trace[i - 1].signals.clock === 0,
      )
      .map((s) => s.signals.data);
    assert.deepEqual(
      bits,
      direction === "lsb" ? [1, 1, 0, 0, 1, 1, 0, 1] : [1, 0, 1, 1, 0, 0, 1, 1],
    );
    assert.equal(trace.at(-1).registers.sampled, 0xb3);
  }
});
test("source suggestions expose exact context and do not invent register widths", () => {
  const suggestions = suggestScenarios(document);
  assert.equal(suggestions.find((s) => s.kind === "counter").width, 16);
  assert.equal(suggestions.find((s) => s.kind === "shifter").width, 8);
  assert.equal(suggestions.find((s) => s.kind === "fifo").width, null);
  assert.deepEqual(
    suggestScenarios({
      pages: [
        {
          number: 1,
          text: "An analog voltage reference with three terminals.",
        },
      ],
    }),
    [],
  );
  assert.throws(
    () => build("counter", { quote: "Absent quote about a different chip" }),
    /quote does not occur/,
  );
});
test("conditional select evaluates only the chosen branch", () => {
  assert.equal(
    evaluate(
      { op: "select", args: [true, 7, { op: "div", args: [1, 0] }] },
      {},
    ),
    7,
  );
  assert.equal(
    evaluate(
      { op: "select", args: [false, { op: "div", args: [1, 0] }, 9] },
      {},
    ),
    9,
  );
  const spec = build("counter");
  spec.states[0].tick = [
    { target: "reg.count", value: { op: "select", args: [true, 1] } },
  ];
  assert.throws(() => validateModel(spec), /3 arguments/);
});
test("example stimulus is validated and used by a normal run", () => {
  const spec = build("fifo");
  const trace = simulateModel(spec);
  assert.equal(trace[1].registers.level, 1);
  assert.equal(trace[5].signals.overflow, 1);
  spec.exampleInputs = [{ tick: 1, signal: "word_out", value: 3 }];
  assert.throws(() => validateModel(spec), /Unknown input/);
});
