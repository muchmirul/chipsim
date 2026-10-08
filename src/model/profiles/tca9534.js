import { op, assign, signal, and, input } from "../builders/shared.js";
import { gpioRegisterCore } from "../registers/gpio-expander.js";

// SCPS197D pages 17, 19–23, reviewed against the original complete PDF.
// This is an addressed-byte abstraction, not a physical I2C implementation.
export function tca9534(source) {
  const core = gpioRegisterCore({
    addresses: { input: [0], output: [1], polarity: [2], configuration: [3] },
    names: {
      input: ["Input port"],
      output: ["Output port"],
      polarity: ["Polarity inversion"],
      configuration: ["Configuration"],
    },
    defaults: { output: [255], polarity: [0], configuration: [255] },
  });
  const access = (tick, address, write, value, token) => [
    input(tick, "address", address),
    input(tick, "write", write),
    input(tick, "write_data", value),
    input(tick, "request", token),
  ];
  const transition = (when, message, evidence) => ({
    to: "operating",
    when,
    message,
    evidence,
    actions: [],
    active: ["registers", "ports", "interrupt"],
  });
  const transitions = [
    transition(
      "signal.power_reset",
      "Abstract completed power reset: defaults restored; no byte access accepted.",
      ["reset"],
    ),
    transition(
      "signal.error",
      "Unmapped address rejected by the scenario adapter; physical NACK is outside scope.",
      ["addresses"],
    ),
    transition(
      and("signal.valid", "signal.write", op("eq", "signal.address", 0)),
      "Input register write ignored; interrupt remains pending until inputs return or are read.",
      ["input", "interrupt"],
    ),
    transition(
      and("signal.valid", "signal.write"),
      "Addressed byte write completed: inspect latch, direction, inversion, and drivers.",
      ["addresses", "output", "configuration", "polarity"],
    ),
    transition(
      and(core.read, op("eq", "signal.address", 0)),
      "Input port read: returned byte captured and physical input comparison acknowledged.",
      ["input", "interrupt"],
    ),
    transition(
      core.read,
      "Stored register byte read; input interrupt comparison is unchanged.",
      ["addresses", "output"],
    ),
  ];
  const checks = [
    {
      name: "Specified latch defaults, scenario input levels and released outputs",
      ticks: 1,
      expect: {
        "reg.output0": 255,
        "reg.polarity0": 0,
        "reg.configuration0": 255,
        "signal.input0": 255,
        "signal.p00_driver": "Z",
        "signal.int_driver": "Z",
      },
    },
    {
      name: "Output latch is retained while input drivers remain released",
      ticks: 2,
      inputs: access(1, 1, 1, 165, 1),
      expect: {
        "reg.output0": 165,
        "signal.input0": 255,
        "signal.p00_driver": "Z",
      },
    },
    {
      name: "Output direction drives the previously stored byte",
      ticks: 3,
      inputs: [...access(1, 1, 1, 165, 1), ...access(2, 3, 1, 0, 0)],
      expect: {
        "signal.input0": 165,
        "signal.p00_driver": 1,
        "signal.p01_driver": 0,
        "signal.p07_driver": 1,
        "signal.interrupt_pending": 0,
      },
    },
    {
      name: "Reading an output latch does not acknowledge changed inputs",
      ticks: 3,
      inputs: [
        input(1, "external0", 254),
        ...access(1, 1, 1, 165, 1),
        ...access(2, 1, 0, 0, 0),
      ],
      expect: {
        "signal.read_data": 165,
        "signal.valid": 0,
        "reg.sampled0": 255,
        "signal.int_driver": 0,
      },
    },
    {
      name: "Mixed directions invert input bits only and read the stored output byte",
      ticks: 5,
      inputs: [
        input(0, "external0", 170),
        ...access(1, 1, 1, 3, 1),
        ...access(2, 3, 1, 240, 0),
        ...access(3, 2, 1, 255, 1),
        ...access(4, 1, 0, 0, 0),
      ],
      expect: {
        "signal.input0": 83,
        "signal.read_data": 3,
        "signal.p00_driver": 1,
        "signal.p02_driver": 0,
        "signal.p04_driver": "Z",
      },
    },
    {
      name: "Read-only input writes neither store data nor acknowledge INT",
      ticks: 2,
      inputs: [input(1, "external0", 0), ...access(1, 0, 1, 255, 1)],
      expect: {
        "reg.sampled0": 255,
        "reg.output0": 255,
        "signal.input0": 0,
        "signal.interrupt_pending": 1,
      },
    },
    {
      name: "Input read captures current levels and acknowledges the interrupt",
      ticks: 3,
      inputs: [input(1, "external0", 254), ...access(2, 0, 0, 0, 1)],
      expect: {
        "signal.read_data": 254,
        "reg.sampled0": 254,
        "signal.int_driver": "Z",
      },
    },
    {
      name: "Restoring input levels clears INT without reading",
      ticks: 3,
      inputs: [input(1, "external0", 0), input(2, "external0", 255)],
      expect: { "reg.sampled0": 255, "signal.interrupt_pending": 0 },
    },
    {
      name: "Polarity changes do not manufacture a physical input mismatch",
      ticks: 3,
      inputs: [...access(1, 2, 1, 255, 1), ...access(2, 0, 0, 0, 0)],
      expect: {
        "signal.read_data": 0,
        "reg.sampled0": 255,
        "signal.interrupt_pending": 0,
      },
    },
    {
      name: "Output-configured pins ignore external levels and do not interrupt",
      ticks: 4,
      inputs: [
        ...access(1, 3, 1, 0, 1),
        ...access(2, 1, 1, 0, 0),
        input(2, "external0", 0),
        ...access(3, 2, 1, 255, 1),
      ],
      expect: {
        "signal.input0": 0,
        "signal.interrupt_pending": 0,
        "signal.p00_driver": 0,
      },
    },
    {
      name: "Output-to-input changes can expose a baseline mismatch",
      ticks: 3,
      inputs: [
        ...access(1, 3, 1, 0, 1),
        input(2, "external0", 0),
        ...access(2, 3, 1, 255, 0),
      ],
      expect: {
        "signal.input0": 0,
        "signal.int_driver": 0,
        "signal.p00_driver": "Z",
      },
    },
    {
      name: "Held request does not replay changed address/data",
      ticks: 3,
      inputs: [
        ...access(1, 1, 1, 165, 1),
        input(2, "address", 3),
        input(2, "write_data", 0),
      ],
      expect: {
        "reg.output0": 165,
        "reg.configuration0": 255,
        "signal.valid": 0,
      },
    },
    {
      name: "Tick-zero request supplies a baseline, not a write",
      ticks: 1,
      inputs: access(0, 1, 1, 0, 1),
      expect: { "reg.output0": 255, "signal.valid": 0 },
    },
    {
      name: "Reset dominates accesses without replay on release",
      ticks: 4,
      inputs: [
        ...access(1, 1, 1, 0, 1),
        input(2, "power_reset", 1),
        ...access(2, 3, 1, 0, 0),
        input(3, "power_reset", 0),
      ],
      expect: {
        "reg.output0": 255,
        "reg.configuration0": 255,
        "reg.polarity0": 0,
        "signal.valid": 0,
        "signal.int_driver": "Z",
      },
    },
    {
      name: "Unmapped writes preserve latches",
      ticks: 1,
      inputs: access(1, 4, 1, 0, 1),
      expect: { "signal.error": 1, "reg.output0": 255, "signal.read_data": 0 },
    },
    {
      name: "Unmapped reads preserve the preceding read value",
      ticks: 2,
      inputs: [...access(1, 1, 0, 0, 1), ...access(2, 255, 0, 0, 0)],
      expect: { "signal.error": 1, "signal.read_data": 255 },
    },
  ];
  return {
    schemaVersion: 1,
    id: "tca9534",
    name: "TCA9534 · register-level I/O expander",
    fidelity: "behavioral",
    summary:
      "Eight GPIOs with addressed register access, input-only inversion, per-pin direction and input mismatch interrupt observation.",
    scope:
      "TI TCA9534 SCPS197D ideal register-level behavior for individually addressed completed bytes. No physical I2C/SMBus signaling, slave address pins, persistent command pointer, repeated bus bytes, ACK interrupt-loss races, voltage thresholds, power ramps, timing, pulls, external loading or contention. Unmapped addresses are tool-level errors, not modeled silicon NACK behavior.",
    parameters: [],
    signals: [
      ...core.portSignals.map((item) => ({
        ...item,
        label:
          item.id === "external0"
            ? "P0–P7 external scenario levels"
            : item.id === "input0"
              ? "Input port read value"
              : "P" + item.id.slice(2, 3) + " output driver",
      })),
      signal("power_reset", 1, "input"),
      signal("address", 8, "input"),
      signal("write_data", 8, "input"),
      signal("write", 1, "input"),
      signal("request", 1, "input"),
      signal("read_data", 8, "output"),
      signal("valid", 1, "output"),
      signal("error", 1, "output"),
      signal("interrupt_pending", 1, "output"),
      {
        ...signal("int_driver", 1, "output", "Z"),
        triState: true,
        label: "INT open-drain driver · 0 / Z",
      },
    ],
    registers: core.registers,
    registerInterface: core.registerInterface,
    registerMap: core.map,
    nodes: [
      {
        id: "bus",
        label: "Abstract addressed byte",
        kind: "external",
        signals: [
          "address",
          "write_data",
          "write",
          "request",
          "read_data",
          "valid",
          "error",
        ],
      },
      {
        id: "registers",
        label: "Output / polarity / configuration",
        registers: core.writable,
      },
      {
        id: "ports",
        label: "P0–P7 drivers and observed levels",
        signals: ["external0", "input0"],
        registers: ["pins0"],
      },
      {
        id: "interrupt",
        label: "Physical input / last-read comparison",
        signals: ["interrupt_pending", "int_driver"],
        registers: ["sampled0"],
      },
    ],
    edges: [
      { from: "bus", to: "registers" },
      { from: "registers", to: "ports" },
      { from: "ports", to: "interrupt" },
      { from: "ports", to: "bus" },
    ],
    initialState: "initialize",
    states: [
      {
        id: "initialize",
        label: "Power defaults and explicit input/request baselines",
        entry: core.initialize,
        tick: core.step,
        transitions: [
          ...transitions,
          transition(
            true,
            "Register interface ready; held requests do not generate bytes.",
            ["addresses"],
          ),
        ],
      },
      {
        id: "operating",
        label: "Addressed bytes, per-pin drivers, inversion and interrupt",
        entry: [],
        tick: core.step,
        transitions,
        active: ["registers", "ports", "interrupt"],
      },
    ],
    duration: 24,
    exampleInputs: [
      ...access(2, 1, 1, 179, 1),
      ...access(4, 3, 1, 15, 0),
      ...access(6, 1, 0, 0, 1),
      input(8, "external0", 254),
      ...access(10, 1, 0, 0, 0),
      ...access(12, 0, 0, 0, 1),
      ...access(14, 2, 1, 15, 0),
      ...access(16, 0, 0, 0, 1),
      input(20, "power_reset", 1),
      input(21, "power_reset", 0),
    ],
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
        id: "addresses",
        page: 19,
        quote: "Table 3. Command Byte Table",
        claim:
          "Four register addresses, access types and specified output/polarity/configuration reset values; Input Port values depend on applied levels.",
      },
      {
        id: "input",
        page: 20,
        quote: "Writes to these registers have no effect",
        claim:
          "Input reads observe pins regardless of direction; writes do not store a byte. Initial X depends on applied levels.",
      },
      {
        id: "output",
        page: 20,
        quote: "not the actual pin value",
        claim:
          "Output reads return the stored latch; direction decides which pins it drives. Table 5 gives all-one reset values.",
      },
      {
        id: "polarity",
        page: 20,
        quote: "pins defined as inputs",
        claim:
          "Polarity inversion applies only to input-configured bits; Table 6 supplies zero defaults.",
      },
      {
        id: "configuration",
        page: 20,
        quote: "high-impedance output driver",
        claim:
          "Direction one releases the driver; zero selects output. Table 7 supplies all-input defaults.",
      },
      {
        id: "interrupt",
        page: 17,
        quote: "changed to the original setting",
        claim:
          "Input changes interrupt until original levels return or the Input Port is read; outputs cannot interrupt and output-to-input changes can expose mismatches. Physical ACK pulse races are omitted.",
      },
      {
        id: "open-drain",
        page: 17,
        quote: "open-drain structure",
        claim:
          "INT drives low for a pending mismatch and otherwise releases; an external pull-up is not resolved by this model.",
      },
      {
        id: "reset",
        page: 17,
        quote: "default states",
        claim:
          "Completed power-on reset restores specified register defaults. power_reset is an abstract scenario operation.",
      },
      {
        id: "pointer",
        page: 19,
        quote: "continues to be accessed by reads",
        claim:
          "The real device retains a command pointer; this individually addressed-byte abstraction does not model that bus history.",
      },
    ].map((item) => ({ ...item, sourceId: "datasheet" })),
    assumptions: [
      "A request-token change after tick zero denotes one completed addressed byte at this normalized tick. Tool signals address/write_data/write/request/valid/error are not physical I2C/SMBus pins or ACK/NACK. Held tokens do not replay accesses. Only mapped addresses 0–3 are accepted by the scenario adapter.",
      "Undriven external0 starts at 255 as a driven-high experiment, not a specified numeric Input Port reset value. At initialization and completed abstract power reset the interrupt baseline is the current observed pin byte. power_reset represents completed POR, not a physical reset pin or supply ramp.",
      "Uncontended outputs follow their latch and input-configured pins follow the explicit external byte. External levels do not override driven outputs. Z means a released driver; no floating voltage, pull-up, feedback, loading or contention is inferred.",
      "Input readings invert only input-configured bits; interrupt comparison uses physical non-inverted levels masked by direction. Reads sample and acknowledge instantaneously. Real ACK interrupt-loss races, bus delays and analog effects are outside scope.",
      "The demonstration writes the output latch and mixed direction, changes an input, reads a non-input register without acknowledging INT, reads the Input Port, changes inversion, reads again, then power-resets. This is chosen stimulus, not autonomous device behavior.",
    ],
    checks,
  };
}
