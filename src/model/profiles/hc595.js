import {
  op,
  assign,
  signal,
  register,
  parameter,
  and,
  input,
} from "../builders/shared.js";

// Reviewed against Nexperia Rev. 12, Figure 4 and Table 3. These rules are
// trusted repository code; no executable behavior is extracted from PDF text.
export function hc595(source) {
  const rise = (pin) =>
    and(op("eq", "signal." + pin, 1), op("eq", "reg.previous_" + pin, 0));
  const shiftEdge = rise("shcp"),
    latchEdge = rise("stcp");
  const reset = op("eq", "signal.mr_n", 0);
  const publications = [
    assign("signal.q7s", op("shiftRight", "reg.shift", 7)),
    assign("signal.parallel_latch", "reg.storage"),
    assign("signal.outputs_enabled", op("eq", "signal.oe_n", 0)),
    assign(
      "signal.parallel_pins",
      op("select", "signal.outputs_enabled", "reg.storage", "Z"),
    ),
  ];
  const step = [
    assign("reg.reset_active", reset),
    assign("reg.shift_edge", shiftEdge),
    assign("reg.latch_edge", latchEdge),
    // Latch the old shift value before updating it for simultaneous clock edges.
    // MR clears shift data even when there is no SHCP edge.
    assign(
      "reg.storage",
      op(
        "select",
        "reg.latch_edge",
        op("select", reset, 0, "reg.shift"),
        "reg.storage",
      ),
    ),
    assign(
      "reg.shift",
      op(
        "select",
        reset,
        0,
        op(
          "select",
          "reg.shift_edge",
          op("bitOr", op("shiftLeft", "reg.shift", 1), "signal.ds"),
          "reg.shift",
        ),
      ),
    ),
    ...publications,
    assign("reg.previous_shcp", "signal.shcp"),
    assign("reg.previous_stcp", "signal.stcp"),
  ];
  const transition = (condition, message, evidence, active) => ({
    to: "operating",
    when: condition,
    actions: [],
    message,
    evidence,
    active,
  });
  const inputs = (byte) =>
    Array.from({ length: 8 }, (_, index) => [
      input(2 + index * 2, "ds", (byte >>> (7 - index)) & 1),
      input(2 + index * 2, "shcp", 1),
      input(3 + index * 2, "shcp", 0),
    ]).flat();
  const example = [
    input(0, "mr_n", 0),
    input(1, "mr_n", 1),
    ...inputs(0xb3),
    input(18, "stcp", 1),
    input(19, "stcp", 0),
    input(20, "oe_n", 0),
    input(24, "oe_n", 1),
    input(26, "mr_n", 0),
    input(28, "stcp", 1),
    input(30, "oe_n", 0),
  ];
  return {
    schemaVersion: 1,
    id: "hc595",
    name: "74HC595 / 74HCT595",
    fidelity: "behavioral",
    summary:
      "Datasheet-backed eight-bit shift register, independent storage latch, serial output, and active-low control pins.",
    scope:
      "Ideal digital behavior of Nexperia 74HC595/74HCT595 Rev. 12. parallel_pins reports stored data when enabled and Z when its drivers are released; parallel_latch always reports retained storage data. Analog thresholds, high-impedance voltage, setup/hold times, propagation delays, supply behavior, and bus contention are outside scope.",
    parameters: [
      parameter(
        "initial_shift",
        "Scenario initial shift value · not power-on reset",
        0,
        0,
        255,
      ),
      parameter(
        "initial_storage",
        "Scenario initial storage value · not power-on reset",
        0,
        0,
        255,
      ),
    ],
    signals: [
      signal("ds", 1, "input"),
      signal("shcp", 1, "input"),
      signal("stcp", 1, "input"),
      { ...signal("mr_n", 1, "input"), initial: 1 },
      { ...signal("oe_n", 1, "input"), initial: 1 },
      { ...signal("q7s", 1, "output"), label: "Q7S · serial output" },
      {
        ...signal("parallel_latch", 8, "output"),
        label: "Q latch · valid when enabled",
      },
      {
        ...signal("outputs_enabled", 1, "output"),
        label: "Q driven · 0 means high-Z",
      },
      {
        ...signal("parallel_pins", 8, "output"),
        initial: "Z",
        triState: true,
        label: "Q0–Q7 · pins / Z",
      },
    ],
    registers: [
      register("shift", 8),
      register("storage", 8),
      register("previous_shcp", 1),
      register("previous_stcp", 1),
      register("shift_edge", 1),
      register("latch_edge", 1),
      register("reset_active", 1),
    ],
    nodes: [
      {
        id: "serial",
        label: "DS / SHCP",
        kind: "external",
        signals: ["ds", "shcp"],
      },
      {
        id: "shift",
        label: "8-stage shift register",
        registers: ["shift"],
        signals: ["mr_n"],
      },
      {
        id: "cascade",
        label: "Serial cascade output",
        kind: "external",
        signals: ["q7s"],
      },
      {
        id: "latch",
        label: "8-bit storage latch",
        registers: ["storage"],
        signals: ["stcp"],
      },
      {
        id: "gate",
        label: "Active-low OE gate",
        signals: ["oe_n", "outputs_enabled"],
      },
      {
        id: "parallel",
        label: "Parallel latch Q0–Q7",
        kind: "external",
        signals: ["parallel_pins", "parallel_latch", "outputs_enabled"],
      },
    ],
    edges: [
      { from: "serial", to: "shift" },
      { from: "shift", to: "cascade" },
      { from: "shift", to: "latch" },
      { from: "latch", to: "parallel" },
      { from: "gate", to: "parallel" },
    ],
    initialState: "initialize",
    states: [
      {
        id: "initialize",
        label:
          "Apply chosen initial scenario values and tick-zero reset; clocks establish baseline without inventing an edge.",
        entry: [
          assign("reg.shift", op("select", reset, 0, "param.initial_shift")),
          assign("reg.storage", "param.initial_storage"),
          ...publications,
          assign("reg.previous_shcp", "signal.shcp"),
          assign("reg.previous_stcp", "signal.stcp"),
        ],
        tick: [],
        transitions: [
          {
            to: "operating",
            when: true,
            actions: step,
            message: "Controls evaluated; clock history initialized.",
            evidence: ["reset", "shift", "latch"],
            active: ["serial", "shift", "latch", "gate"],
          },
        ],
      },
      {
        id: "operating",
        label:
          "Reset is asynchronous to SHCP; STCP captures old shift data before simultaneous shifting.",
        entry: [],
        tick: step,
        active: ["gate", "parallel"],
        transitions: [
          transition(
            and("reg.reset_active", "reg.latch_edge"),
            "MR clears shift; STCP transfers the cleared shift register to storage.",
            ["reset", "latch"],
            ["shift", "latch", "parallel"],
          ),
          transition(
            and("reg.shift_edge", "reg.latch_edge"),
            "Both clocks rise: storage captures the previous shift data, then DS shifts into stage 0.",
            ["simultaneous", "shift", "latch"],
            ["serial", "shift", "latch", "parallel"],
          ),
          transition(
            "reg.reset_active",
            "MR is LOW: shift register clears; storage is retained without a latch edge.",
            ["reset"],
            ["shift", "cascade"],
          ),
          transition(
            "reg.latch_edge",
            "STCP rises: shift data transfers to the storage latch.",
            ["latch"],
            ["latch", "parallel"],
          ),
          transition(
            "reg.shift_edge",
            "SHCP rises: DS enters stage 0; previous stage 6 reaches Q7S.",
            ["shift", "serial"],
            ["serial", "shift", "cascade"],
          ),
        ],
      },
    ],
    duration: 32,
    exampleInputs: example,
    sources: [
      {
        ...source,
        id: "datasheet",
        filename: source.path.split("/").at(-1),
        url: source.source_url,
      },
    ],
    evidence: [
      {
        id: "width",
        page: 1,
        quote: "8-bit serial-in",
        claim:
          "The chip contains eight shift stages and eight storage bits; see Figure 4.",
      },
      {
        id: "shift",
        page: 1,
        quote: "transitions of the SHCP input",
        claim:
          "SHCP rising edges shift DS into stage 0; Figure 4 and Table 3 define bit direction.",
      },
      {
        id: "latch",
        page: 1,
        quote: "transition of the STCP input",
        claim:
          "STCP rising edges capture shift-register data in independent storage.",
      },
      {
        id: "reset",
        page: 5,
        quote: "only affects the shift registers",
        claim:
          "Active-low MR clears the shift register without clearing the storage latch.",
      },
      {
        id: "simultaneous",
        page: 5,
        quote: "previous contents",
        claim:
          "With both clocks rising, storage captures old shift data; see the last row of Table 3.",
      },
      {
        id: "gate",
        page: 1,
        quote: "high-impedance OFF-state",
        claim:
          "OE HIGH disables parallel drive and does not alter either register.",
      },
      {
        id: "serial",
        page: 1,
        quote: "serial output (Q7S)",
        claim:
          "Q7S exposes shift stage 7 independently of parallel output enable.",
      },
    ].map((item) => ({ ...item, sourceId: "datasheet" })),
    assumptions: [
      "Pins are sampled at normalized ticks with instantaneous ideal logic. Input events at the same tick are simultaneous; no setup/hold, metastability, or physical delay is inferred.",
      "Initial shift/storage values are developer-selected scenario parameters, not guaranteed silicon power-on values. Tick-zero clock levels establish a baseline and do not generate a clock edge.",
      "parallel_pins reports Z when outputs_enabled=0; parallel_latch reports retained storage data independently. Z means released drivers, not a resolved external bus voltage. Electrical high impedance, external pulls, and contention are not simulated.",
      "The default stimulus is a demonstration: reset, shift 0xB3 MSB first, latch, enable/disable outputs, then clear and latch zeros. It is not behavior generated by the chip itself.",
    ],
    checks: [
      {
        name: "Eight DS bits reach shift register while storage holds",
        ticks: 17,
        inputs: inputs(0xb3),
        expect: { "reg.shift": 179, "reg.storage": 0, "signal.q7s": 1 },
      },
      {
        name: "Storage changes only on STCP rising",
        ticks: 19,
        inputs: [...inputs(0xb3), input(18, "stcp", 1), input(19, "stcp", 0)],
        expect: { "reg.storage": 179, "signal.parallel_latch": 179 },
      },
      {
        name: "MR clears shift without clearing nonzero storage",
        parameters: { initial_shift: 255, initial_storage: 165 },
        ticks: 2,
        inputs: [input(1, "mr_n", 0)],
        expect: { "reg.shift": 0, "reg.storage": 165, "signal.q7s": 0 },
      },
      {
        name: "MR LOW and STCP rising latch zero",
        parameters: { initial_shift: 255, initial_storage: 165 },
        ticks: 2,
        inputs: [input(1, "mr_n", 0), input(1, "stcp", 1)],
        expect: { "reg.shift": 0, "reg.storage": 0 },
      },
      {
        name: "Simultaneous clocks capture previous shift contents",
        parameters: { initial_shift: 165 },
        ticks: 2,
        inputs: [input(1, "ds", 1), input(1, "shcp", 1), input(1, "stcp", 1)],
        expect: { "reg.shift": 75, "reg.storage": 165, "signal.q7s": 0 },
      },
      {
        name: "OE never clears registers or serial output",
        parameters: { initial_shift: 255, initial_storage: 179 },
        ticks: 3,
        inputs: [input(1, "oe_n", 0), input(2, "oe_n", 1)],
        expect: {
          "reg.shift": 255,
          "reg.storage": 179,
          "signal.parallel_latch": 179,
          "signal.outputs_enabled": 0,
          "signal.parallel_pins": "Z",
          "signal.q7s": 1,
        },
      },
      {
        name: "Holding SHCP high shifts only once; falling edge holds",
        parameters: { initial_shift: 1 },
        ticks: 3,
        inputs: [input(1, "shcp", 1), input(3, "shcp", 0)],
        expect: { "reg.shift": 2, "reg.storage": 0 },
      },
      {
        name: "Reset dominates SHCP with DS high",
        parameters: { initial_shift: 255 },
        ticks: 2,
        inputs: [input(1, "mr_n", 0), input(1, "ds", 1), input(1, "shcp", 1)],
        expect: { "reg.shift": 0, "signal.q7s": 0 },
      },
    ],
  };
}
