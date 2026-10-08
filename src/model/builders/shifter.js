import {
  op,
  assign,
  signal,
  register,
  parameter,
  transition,
  and,
  input,
  widthFor,
} from "./shared.js";
export function shifter({ width, direction = "lsb", value = 179 }) {
  if (!["lsb", "msb"].includes(direction))
    throw new Error("Choose LSB first or MSB first.");
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** width)
    throw new Error(`Payload must fit ${width} bits.`);
  const bit = op(
    "bitAnd",
    direction === "lsb"
      ? "reg.shift"
      : op("shiftRight", "reg.shift", width - 1),
    1,
  );
  const clear = [
    ...["shift", "sampled", "samples"].map((id) => assign("reg." + id, 0)),
    ...["data", "clock", "done"].map((id) => assign("signal." + id, 0)),
  ];
  const reset = transition(
    "idle",
    op("eq", "signal.reset", 1),
    [],
    "Reset stops transfer",
    ["control", "pins"],
  );
  const elapsed = op("ge", "stateAge", "param.half");
  const decoded =
    direction === "lsb"
      ? op(
          "bitOr",
          "reg.sampled",
          op("shiftLeft", "signal.data", "reg.samples"),
        )
      : op("bitOr", op("shiftLeft", "reg.sampled", 1), "signal.data");
  const end = 1 + 4 * width,
    mask = 2 ** width - 1,
    testPayload = Math.min(179, mask);
  return {
    summary: `${width}-bit ${direction === "lsb" ? "LSB-first" : "MSB-first"} shift transfer with enable, clock edges, and decoded receiver data.`,
    scope:
      "A selected synchronous shift-register transfer, with one payload and a modeled receiver. This does not infer SPI mode, chip-select rules, ACK, bus timing, or instruction costs from the document.",
    parameters: [
      parameter("payload", "Payload", value, 0, mask),
      parameter("half", "Clock half-period · ticks", 2, 1, 16),
    ],
    signals: [
      signal("start", 1, "input"),
      signal("reset", 1, "input"),
      signal("data", 1, "output"),
      signal("clock", 1, "output"),
      signal("done", 1, "output"),
    ],
    registers: [
      register("shift", width),
      register("sampled", width),
      register("samples", widthFor(width)),
    ],
    nodes: [
      {
        id: "control",
        label: "Start / reset",
        kind: "external",
        signals: ["start", "reset", "done"],
      },
      {
        id: "shifter",
        label: `${width}-bit shift register`,
        registers: ["shift"],
      },
      {
        id: "clocking",
        label: "Clock phase control",
        kind: "config",
        signals: ["clock"],
      },
      { id: "pins", label: "Serial output", signals: ["data", "clock"] },
      {
        id: "receiver",
        label: "Modeled receiver",
        kind: "external",
        registers: ["sampled", "samples"],
      },
    ],
    edges: [
      { from: "control", to: "shifter" },
      { from: "shifter", to: "pins" },
      { from: "clocking", to: "pins" },
      { from: "pins", to: "receiver" },
    ],
    initialState: "idle",
    states: [
      {
        id: "idle",
        entry: clear,
        tick: [],
        active: ["control"],
        transitions: [
          reset,
          transition(
            "low",
            op("eq", "signal.start", 1),
            [assign("reg.shift", "param.payload")],
            "Load payload and present first bit",
            ["control", "shifter", "pins"],
          ),
        ],
      },
      {
        id: "low",
        entry: [assign("signal.clock", 0), assign("signal.data", bit)],
        tick: [],
        active: ["clocking"],
        transitions: [
          reset,
          transition("high", elapsed, [], "Rising edge samples DATA", [
            "clocking",
            "pins",
            "receiver",
          ]),
        ],
      },
      {
        id: "high",
        entry: [
          assign("signal.clock", 1),
          assign("reg.sampled", decoded),
          assign("reg.samples", op("add", "reg.samples", 1)),
        ],
        tick: [],
        active: ["clocking"],
        transitions: [
          reset,
          transition(
            "done",
            and(elapsed, op("eq", "reg.samples", width)),
            [],
            "Final falling edge; transfer done",
            ["clocking", "pins", "control"],
          ),
          transition(
            "low",
            elapsed,
            [
              assign(
                "reg.shift",
                op(
                  direction === "lsb" ? "shiftRight" : "shiftLeft",
                  "reg.shift",
                  1,
                ),
              ),
            ],
            "Falling edge shifts the next bit",
            ["clocking", "shifter", "pins"],
          ),
        ],
      },
      {
        id: "done",
        entry: [assign("signal.clock", 0), assign("signal.done", 1)],
        tick: [],
        active: ["control", "receiver"],
        transitions: [
          reset,
          transition(
            "idle",
            op("eq", "signal.start", 0),
            [],
            "Start released; ready for another transfer",
            ["control"],
          ),
        ],
      },
    ],
    assumptions: [
      `The modeled payload contains ${width} bits and transfers ${direction === "lsb" ? "least" : "most"} significant bit first. The receiver samples on CLK rising edges.`,
      `START loads at its first asserted step; each clock half-period lasts the chosen number of normalized ticks. RESET overrides every state.`,
      `DONE and decoded receiver data are held until START is released or RESET is asserted. Other serial protocol behavior is outside this scenario.`,
    ],
    duration: end + 6,
    exampleInputs: [input(1, "start", 1)],
    checks: [
      {
        name: "Receiver reconstructs payload",
        parameters: { payload: testPayload, half: 2 },
        ticks: end,
        inputs: [input(1, "start", 1)],
        expect: {
          state: "done",
          "signal.done": 1,
          "signal.clock": 0,
          "reg.samples": width,
          "reg.sampled": testPayload,
        },
      },
      {
        name: "Clock divider changes schedule, not data",
        parameters: { payload: mask, half: 1 },
        ticks: 1 + 2 * width,
        inputs: [input(1, "start", 1)],
        expect: { "reg.sampled": mask, "reg.samples": width, state: "done" },
      },
      {
        name: "Reset interrupts an active transfer",
        ticks: 5,
        inputs: [input(1, "start", 1), input(4, "reset", 1)],
        expect: {
          state: "idle",
          "reg.samples": 0,
          "signal.clock": 0,
          "signal.done": 0,
        },
      },
      {
        name: "Releasing start clears held result",
        ticks: end + 1,
        inputs: [input(1, "start", 1), input(end + 1, "start", 0)],
        expect: { state: "idle", "reg.samples": 0, "signal.done": 0 },
      },
    ],
  };
}
