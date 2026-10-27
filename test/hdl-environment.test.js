import test from "node:test";
import assert from "node:assert/strict";
import {
  generateEnvironment,
  environmentSourceName,
} from "../src/hdl/environment.js";

const channel = (extra = {}) => ({
  name: "data",
  initial: 0,
  events: [],
  glitches: [],
  ...extra,
});
const profile = (channels = [channel()], extra = {}) => ({
  format: "chipsim-digital-environment",
  version: 1,
  timeUnit: "1ns",
  seed: 1,
  channels,
  ...extra,
});

// Independent timeline: base delayed by 3-1=2 ticks; glitches invert the
// delayed level on [2,5) and [7,8), never the nominal level.
test("delay, signed offset and half-open XOR glitches produce the hand-derived timeline", () => {
  const input = profile([
    channel({
      initial: 1,
      delayTicks: 3,
      offsetTicks: -1,
      events: [
        { tick: 2, value: 0 },
        { tick: 6, value: 1 },
      ],
      glitches: [
        { tick: 2, durationTicks: 3 },
        { tick: 7, durationTicks: 1 },
      ],
    }),
  ]);
  const original = structuredClone(input);
  const { source, report } = generateEnvironment(input);
  assert.equal(environmentSourceName, "chipsim_environment.sv");
  assert.equal(report.format, "chipsim-environment-result");
  assert.equal(report.version, 1);
  assert.deepEqual(report.channelBits, [{ name: "data", bit: 0 }]);
  assert.deepEqual(report.frames, [
    { tick: 0, nominal: "1", disturbed: "1" },
    { tick: 2, nominal: "0", disturbed: "0" },
    { tick: 4, nominal: "0", disturbed: "1" },
    { tick: 5, nominal: "0", disturbed: "0" },
    { tick: 6, nominal: "1", disturbed: "0" },
    { tick: 7, nominal: "1", disturbed: "1" },
    { tick: 8, nominal: "1", disturbed: "1" },
  ]);
  assert.deepEqual(
    report.edges.map(
      ({ requestedTick, delayTicks, arrivalTick, jitterTicks }) => ({
        requestedTick,
        delayTicks,
        arrivalTick,
        jitterTicks,
      }),
    ),
    [
      { requestedTick: 2, delayTicks: 2, arrivalTick: 4, jitterTicks: 0 },
      { requestedTick: 6, delayTicks: 2, arrivalTick: 8, jitterTicks: 0 },
    ],
  );
  assert.equal(report.rng.draws, 2);
  assert.deepEqual(
    report.edges.map((edge) => edge.rngState),
    [270369, 67634689],
  );
  assert.deepEqual(input, original);
  assert.equal(report.profile.channels[0].jitterTicks, 0);
  assert.match(source, /^`timescale 1ns\/1ns\nmodule chipsim_environment\(/);
  assert.equal((source.match(/initial begin/g) || []).length, 1);
  assert.doesNotMatch(source, /\b(force|always|forever)\b|\$(finish|dumpvars)/);
  assert.equal(
    source,
    `\`timescale 1ns/1ns
module chipsim_environment(
  output reg [0:0] nominal,
  output reg [0:0] disturbed
);
  // Digital test scenario: integer delays and XOR glitches, not analog behavior.
  initial begin
    {nominal, disturbed} = 2'b11;
    #2;
    if ($time != 2) $fatal(1, "ChipSim environment time overflow at tick 2; reduce the schedule duration or use coarser design precision.");
    {nominal, disturbed} = 2'b00;
    #2;
    if ($time != 4) $fatal(1, "ChipSim environment time overflow at tick 4; reduce the schedule duration or use coarser design precision.");
    {nominal, disturbed} = 2'b01;
    #1;
    if ($time != 5) $fatal(1, "ChipSim environment time overflow at tick 5; reduce the schedule duration or use coarser design precision.");
    {nominal, disturbed} = 2'b00;
    #1;
    if ($time != 6) $fatal(1, "ChipSim environment time overflow at tick 6; reduce the schedule duration or use coarser design precision.");
    {nominal, disturbed} = 2'b10;
    #1;
    if ($time != 7) $fatal(1, "ChipSim environment time overflow at tick 7; reduce the schedule duration or use coarser design precision.");
    {nominal, disturbed} = 2'b11;
    #1;
    if ($time != 8) $fatal(1, "ChipSim environment time overflow at tick 8; reduce the schedule duration or use coarser design precision.");
    {nominal, disturbed} = 2'b11;
  end
endmodule
`,
  );
});

test("seeded xorshift draws are reproducible, channel ordered, and consumed even without jitter", () => {
  const input = profile([
    channel({ name: "constant_delay", events: [{ tick: 10, value: 1 }] }),
    channel({
      name: "jittered",
      delayTicks: 5,
      jitterTicks: 5,
      events: [
        { tick: 20, value: 1 },
        { tick: 40, value: 0 },
        { tick: 60, value: 1 },
      ],
    }),
  ]);
  const first = generateEnvironment(input);
  assert.deepEqual(first, generateEnvironment(input));
  assert.equal(first.report.rng.id, "xorshift32-rejection-v1");
  assert.equal(first.report.seed, 1);
  assert.deepEqual(
    first.report.edges.map((edge) => edge.rngState),
    [270369, 67634689, 2647435461, 307599695],
  );
  assert.deepEqual(
    first.report.edges.map((edge) => edge.jitterTicks),
    [0, -5, 5, 1],
  );
  assert.deepEqual(
    first.report.edges.map((edge) => edge.arrivalTick),
    [10, 20, 50, 66],
  );
  assert.notDeepEqual(
    first.report.edges,
    generateEnvironment({ ...input, seed: 2 }).report.edges,
  );
  assert.equal(first.report.rng.draws, 4);
  assert.deepEqual(first.report.rng.rejections, []);
});

test("rejection sampling discards the high tail rather than applying biased modulo", () => {
  // Inverting one xorshift transition gives this seed's first state 0xffffffff.
  // With range 1000000001, states above 4000000004 reject; the next is 253983.
  const { report } = generateEnvironment(
    profile(
      [
        channel({
          delayTicks: 500000000,
          jitterTicks: 500000000,
          events: [{ tick: 1, value: 1 }],
        }),
      ],
      { seed: 1584200935 },
    ),
  );
  assert.equal(report.rng.draws, 2);
  assert.deepEqual(report.rng.rejections, [
    { channel: "data", bit: 0, eventIndex: 0, state: 4294967295 },
  ]);
  assert.deepEqual(report.edges, [
    {
      channel: "data",
      bit: 0,
      eventIndex: 0,
      requestedTick: 1,
      value: 1,
      jitterTicks: -499746018,
      delayTicks: 253982,
      arrivalTick: 253983,
      rngDraws: 2,
      rngState: 253983,
    },
  ]);
});

test("same-time channel, nominal, arrival and glitch changes are one complete atomic vector frame", () => {
  const { report, source } = generateEnvironment(
    profile([
      channel({
        name: "first",
        events: [{ tick: 5, value: 1 }],
        glitches: [{ tick: 5, durationTicks: 2 }],
      }),
      channel({
        name: "second",
        initial: 1,
        delayTicks: 2,
        events: [{ tick: 3, value: 0 }],
      }),
    ]),
  );
  assert.deepEqual(report.channelBits, [
    { name: "first", bit: 0 },
    { name: "second", bit: 1 },
  ]);
  assert.deepEqual(report.frames, [
    { tick: 0, nominal: "10", disturbed: "10" },
    { tick: 3, nominal: "00", disturbed: "10" },
    { tick: 5, nominal: "01", disturbed: "00" },
    { tick: 7, nominal: "01", disturbed: "01" },
  ]);
  assert.equal((source.match(/\{nominal, disturbed\} =/g) || []).length, 4);
  assert.match(source, /4'b0100/);
});

test("tick-zero initial state is settled and does not schedule a delayed initialization", () => {
  const { report, source } = generateEnvironment(
    profile([channel({ initial: 1, delayTicks: 100 })]),
  );
  assert.deepEqual(report.frames, [{ tick: 0, nominal: "1", disturbed: "1" }]);
  assert.deepEqual(report.edges, []);
  assert.equal(report.rng.draws, 0);
  assert.doesNotMatch(source, /#/);
  assert.deepEqual(
    report.profile.channels[0],
    channel({ initial: 1, delayTicks: 100, offsetTicks: 0, jitterTicks: 0 }),
  );
});

test("entire delay support must be causal and actual delayed edges may not collide or reorder", () => {
  assert.throws(
    () =>
      generateEnvironment(
        profile([channel({ delayTicks: 2, offsetTicks: -1, jitterTicks: 2 })]),
      ),
    /support.*advance/,
  );
  assert.throws(
    () => generateEnvironment(profile([channel({ offsetTicks: -1 })])),
    /support.*advance/,
  );
  // Seed 1 draws +1, -1: a two-tick nominal gap collides, a one-tick gap reorders.
  for (const secondTick of [11, 12]) {
    assert.throws(
      () =>
        generateEnvironment(
          profile([
            channel({
              delayTicks: 1,
              jitterTicks: 1,
              events: [
                { tick: 10, value: 1 },
                { tick: secondTick, value: 0 },
              ],
            }),
          ]),
        ),
      /arrivals collide or reorder/,
    );
  }
  const { report } = generateEnvironment(
    profile([
      channel({
        delayTicks: 1,
        jitterTicks: 1,
        events: [
          { tick: 10, value: 1 },
          { tick: 13, value: 0 },
        ],
      }),
    ]),
  );
  assert.deepEqual(
    report.edges.map((edge) => edge.arrivalTick),
    [12, 13],
  );
});

test("glitches can be unsorted or adjacent, but cannot overlap or wrap the tick bound", () => {
  const adjacent = profile([
    channel({
      glitches: [
        { tick: 5, durationTicks: 2 },
        { tick: 2, durationTicks: 3 },
      ],
    }),
  ]);
  assert.deepEqual(generateEnvironment(adjacent).report.frames, [
    { tick: 0, nominal: "0", disturbed: "0" },
    { tick: 2, nominal: "0", disturbed: "1" },
    { tick: 5, nominal: "0", disturbed: "1" },
    { tick: 7, nominal: "0", disturbed: "0" },
  ]);
  assert.throws(
    () =>
      generateEnvironment(
        profile([
          channel({
            glitches: [
              { tick: 4, durationTicks: 2 },
              { tick: 2, durationTicks: 3 },
            ],
          }),
        ]),
      ),
    /overlap/,
  );
  assert.throws(
    () =>
      generateEnvironment(
        profile([
          channel({ glitches: [{ tick: 1000000000, durationTicks: 1 }] }),
        ]),
      ),
    /end tick/,
  );
});

test("strict schemas reject unknown, missing and malformed fields at every level", () => {
  const invalid = [
    null,
    [],
    {},
    profile([], {}),
    profile(undefined, { format: "other" }),
    profile(undefined, { version: 2 }),
    profile(undefined, { extra: 1 }),
    profile(undefined, { timeUnit: 1 }),
    profile(undefined, { timeUnit: "2ns" }),
    profile(undefined, { timeUnit: "1tick" }),
    profile([channel({ unknown: 0 })]),
    profile([channel({ initial: true })]),
    profile([channel({ events: undefined })]),
    profile([channel({ glitches: null })]),
    profile([channel({ name: "module" })]),
    profile([channel({ name: "always_ff" })]),
    profile([channel({ name: "bad.name" })]),
    profile([channel({ name: "$bad" })]),
    profile([channel({ name: "1bad" })]),
    profile([channel(), channel()]),
    profile([channel({ name: "a".repeat(129) })]),
    profile([channel({ delayTicks: null })]),
    profile([channel({ offsetTicks: 0.5 })]),
    profile([channel({ jitterTicks: -1 })]),
    profile([channel({ events: [{ tick: 1, value: 1, extra: 0 }] })]),
    profile([channel({ events: [{ tick: 0, value: 1 }] })]),
    profile([channel({ events: [{ tick: 1.5, value: 1 }] })]),
    profile([channel({ events: [{ tick: 1, value: "1" }] })]),
    profile([channel({ events: [{ tick: 1, value: 0 }] })]),
    profile([
      channel({
        events: [
          { tick: 1, value: 1 },
          { tick: 2, value: 1 },
        ],
      }),
    ]),
    profile([
      channel({
        events: [
          { tick: 2, value: 1 },
          { tick: 1, value: 0 },
        ],
      }),
    ]),
    profile([
      channel({
        events: [
          { tick: 1, value: 1 },
          { tick: 1, value: 0 },
        ],
      }),
    ]),
    profile([channel({ glitches: [{ tick: 1, durationTicks: 1, value: 1 }] })]),
    profile([channel({ glitches: [{ tick: 0, durationTicks: 1 }] })]),
    profile([channel({ glitches: [{ tick: 1, durationTicks: 0 }] })]),
    profile([channel({ glitches: [{ tick: 1, durationTicks: 0.5 }] })]),
  ];
  for (const field of ["format", "version", "timeUnit", "seed", "channels"]) {
    const missing = profile();
    delete missing[field];
    invalid.push(missing);
  }
  for (const field of ["name", "initial", "events", "glitches"]) {
    const missing = channel();
    delete missing[field];
    invalid.push(profile([missing]));
  }
  for (const value of invalid) assert.throws(() => generateEnvironment(value));
});

test("uint32 seed, channel/event counts, delay support and tick bounds are enforced", () => {
  for (const seed of [
    0,
    -1,
    4294967296,
    0.5,
    NaN,
    Infinity,
    "1",
    null,
    undefined,
  ])
    assert.throws(
      () => generateEnvironment(profile(undefined, { seed })),
      /seed/,
    );
  for (const seed of [1, 4294967295])
    assert.equal(
      generateEnvironment(profile(undefined, { seed })).report.seed,
      seed,
    );
  for (const timeUnit of ["1fs", "10ps", "100ns", "1us", "10ms", "100s"])
    assert.equal(
      generateEnvironment(profile(undefined, { timeUnit })).report.profile
        .timeUnit,
      timeUnit,
    );
  assert.equal(
    generateEnvironment(profile(undefined, { timeUnit: " 10 ns " })).report
      .profile.timeUnit,
    "10ns",
  );
  const channels = Array.from({ length: 16 }, (_, i) =>
    channel({ name: "ch" + i }),
  );
  assert.equal(
    generateEnvironment(profile(channels)).report.channelBits.length,
    16,
  );
  assert.throws(
    () =>
      generateEnvironment(profile([...channels, channel({ name: "last" })])),
    /1–16/,
  );
  const events = Array.from({ length: 256 }, (_, i) => ({
    tick: i + 1,
    value: 1 - (i % 2),
  }));
  assert.equal(
    generateEnvironment(profile([channel({ events })])).report.edges.length,
    256,
  );
  assert.throws(
    () =>
      generateEnvironment(
        profile([channel({ events: [...events, { tick: 257, value: 1 }] })]),
      ),
    /256/,
  );
  assert.equal(
    generateEnvironment(
      profile([channel({ events: [{ tick: 1000000000, value: 1 }] })]),
    ).report.frames.at(-1).tick,
    1000000000,
  );
  assert.equal(
    generateEnvironment(
      profile([
        channel({ delayTicks: 999999999, events: [{ tick: 1, value: 1 }] }),
      ]),
    ).report.edges[0].arrivalTick,
    1000000000,
  );
  for (const extra of [
    { delayTicks: 1000000001 },
    { offsetTicks: -1000000001 },
    { jitterTicks: 1000000001 },
    { delayTicks: 1000000000, offsetTicks: 1 },
    { delayTicks: 1000000000, jitterTicks: 1 },
    { events: [{ tick: 1000000001, value: 1 }] },
    { delayTicks: 1, events: [{ tick: 1000000000, value: 1 }] },
  ])
    assert.throws(() => generateEnvironment(profile([channel(extra)])));
});

test("timeline endpoint budget is applied before coalescing, and source remains bounded", () => {
  const glitches = Array.from({ length: 10000 }, (_, i) => ({
    tick: 2 * i + 1,
    durationTicks: 1,
  }));
  const { source, report } = generateEnvironment(
    profile([channel({ glitches })]),
  );
  assert.equal(report.frames.length, 20001);
  assert.ok(Buffer.byteLength(source) < 4 * 1024 * 1024);
  assert.throws(
    () =>
      generateEnvironment(
        profile([
          channel({
            glitches: [...glitches, { tick: 20001, durationTicks: 1 }],
          }),
        ]),
      ),
    /20000 timeline endpoints/,
  );
});
