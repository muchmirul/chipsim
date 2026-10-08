import test from "node:test";
import assert from "node:assert/strict";
import { compareTraces } from "../src/core/trace-diff.js";
import { TraceReview } from "../src/tui/trace-review.js";

const snapshot = (tick, values = {}) => ({
  tick,
  state: "run",
  phase: "running",
  signals: { q: 0 },
  registers: {},
  ...values,
});
test("read-only review preserves the captured numeric format and chooses return for identical experiments", () => {
  const trace = [snapshot(0)],
    session = { display: "binary", parameters: { initialOutputs: 0 } };
  let menu,
    returned = false;
  const app = {
    state: { trace, session: () => session },
    menu(title, items, select, selected) {
      menu = { title, items, select, selected };
    },
  };
  const review = new TraceReview(
    app,
    {
      trace: structuredClone(trace),
      model: {
        signals: [{ id: "q", width: 1 }],
        registers: [{ id: "word", width: 32 }],
      },
    },
    () => {
      returned = true;
    },
  );
  session.display = "hex";
  session.parameters.initialOutputs = 1;
  assert.equal(review.baseline.display, "binary");
  assert.equal(review.baseline.parameters.initialOutputs, 0);
  assert.equal(
    review.label({ field: "signal.q", before: "Z", after: 0 }),
    "signal.q: Z → 0b0",
  );
  assert.equal(review.value("reg.word", 4294967295), "0b" + "1".repeat(32));
  assert.equal(review.value("signal.q", null), "unavailable");
  review.menu();
  assert.equal(menu.selected, 0);
  assert.equal(menu.items[0].value, "back");
  menu.select(menu.items[menu.selected].value);
  assert.equal(returned, true);
});
test("comparison covers later changes even when the selected/initial tick is identical", () => {
  const before = [snapshot(0), snapshot(1), snapshot(2), snapshot(3)],
    after = structuredClone(before);
  after[2].signals.q = 1;
  after[3].signals.q = 1;
  after[3].registers.count = 4294967295;
  const comparison = compareTraces(before, after);
  assert.deepEqual(comparison, {
    ticks: 4,
    changedTicks: 2,
    firstDifference: 2,
    differences: [
      { tick: 2, changes: [{ field: "signal.q", before: 0, after: 1 }] },
      {
        tick: 3,
        changes: [
          { field: "signal.q", before: 0, after: 1 },
          { field: "reg.count", before: null, after: 4294967295 },
        ],
      },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(comparison)), comparison);
  assert.deepEqual(before, [
    snapshot(0),
    snapshot(1),
    snapshot(2),
    snapshot(3),
  ]);
});
test("comparison preserves released, zero, and unavailable values distinctly", () => {
  const before = [
      snapshot(0, {
        signals: { q: "Z", enable: 0 },
        registers: { pending: undefined },
      }),
    ],
    after = [
      snapshot(0, { signals: { q: 0, enable: 0 }, registers: { pending: 0 } }),
    ];
  assert.deepEqual(compareTraces(before, after).differences[0].changes, [
    { field: "signal.q", before: "Z", after: 0 },
    { field: "reg.pending", before: null, after: 0 },
  ]);
});
test("observable comparison ignores log wording, styling, change annotations, and object key order", () => {
  const before = [
      snapshot(0, {
        signals: { a: 0, b: 1 },
        message: "source row 1",
        active: ["a"],
      }),
    ],
    after = [
      snapshot(0, {
        signals: { b: 1, a: 0 },
        message: "source row 2",
        active: ["b"],
        changes: [],
      }),
    ];
  assert.deepEqual(compareTraces(before, after), {
    ticks: 1,
    changedTicks: 0,
    firstDifference: null,
    differences: [],
  });
});
test("state/phase changes and unequal trace lengths remain visible", () => {
  const result = compareTraces(
    [snapshot(0), snapshot(1)],
    [snapshot(0, { state: "fault", phase: "fault" })],
  );
  assert.equal(result.changedTicks, 2);
  assert.deepEqual(result.differences[0].changes, [
    { field: "state", before: "run", after: "fault" },
    { field: "phase", before: "running", after: "fault" },
  ]);
  assert.ok(
    result.differences[1].changes.some(
      (change) => change.field === "snapshot" && change.after === false,
    ),
  );
  assert.deepEqual(compareTraces([], []), {
    ticks: 0,
    changedTicks: 0,
    firstDifference: null,
    differences: [],
  });
});
test("comparison rejects unbounded or misaligned data instead of silently comparing different ticks", () => {
  for (const trace of [
    null,
    new Array(10002),
    [snapshot(1)],
    [null],
    [snapshot(0), snapshot(2)],
  ])
    assert.throws(() => compareTraces(trace, []), /Trace comparison/);
  assert.throws(
    () =>
      compareTraces(
        [
          snapshot(0, {
            signals: Object.fromEntries(
              Array.from({ length: 65 }, (_, at) => [at, 0]),
            ),
          }),
        ],
        [],
      ),
    /bounds/,
  );
});
