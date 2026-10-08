import {
  op,
  assign,
  signal,
  register,
  and,
  input,
} from "../builders/shared.js";

// TI SCPS131J, pages 14–16 and 19–21. Each request-token change abstracts
// one already addressed byte transaction; these are not physical I2C pins.
export function pca9555(source) {
  const eq = (a, b) => op("eq", a, b);
  const select = (condition, yes, no) => op("select", condition, yes, no);
  const reset = "signal.power_reset";
  const accepted = and(
    op("not", reset),
    op("ne", "signal.request", "reg.previous_request"),
  );
  const read = and("signal.valid", op("not", "signal.write"));
  const writable = [
    "output0",
    "output1",
    "polarity0",
    "polarity1",
    "configuration0",
    "configuration1",
  ];
  const defaults = [255, 255, 0, 0, 255, 255];
  const pins = [0, 1].flatMap((port) => {
    const config = "reg.configuration" + port;
    return [
      assign(
        "reg.pins" + port,
        op(
          "bitOr",
          op("bitAnd", "signal.external" + port, config),
          op("bitAnd", "reg.output" + port, op("bitXor", config, 255)),
        ),
      ),
      assign(
        "signal.input" + port,
        op(
          "bitXor",
          "reg.pins" + port,
          op("bitAnd", "reg.polarity" + port, config),
        ),
      ),
      ...Array.from({ length: 8 }, (_, bit) =>
        assign(
          `signal.p${port}${bit}_driver`,
          select(
            op("bitAnd", config, 2 ** bit),
            "Z",
            op("bitAnd", op("shiftRight", "reg.output" + port, bit), 1),
          ),
        ),
      ),
    ];
  });
  const irq = [
    assign(
      "signal.interrupt_pending",
      op(
        "or",
        ...[0, 1].map((port) =>
          op(
            "ne",
            op(
              "bitAnd",
              op("bitXor", "reg.pins" + port, "reg.sampled" + port),
              "reg.configuration" + port,
            ),
            0,
          ),
        ),
      ),
    ),
    assign("signal.int_driver", select("signal.interrupt_pending", 0, "Z")),
  ];
  const map = [
    ["Input port 0", "signal.input0", "ro", "input"],
    ["Input port 1", "signal.input1", "ro", "input"],
    ["Output port 0", "reg.output0", "rw", "output"],
    ["Output port 1", "reg.output1", "rw", "output"],
    ["Polarity inversion 0", "reg.polarity0", "rw", "polarity"],
    ["Polarity inversion 1", "reg.polarity1", "rw", "polarity"],
    ["Configuration 0", "reg.configuration0", "rw", "configuration"],
    ["Configuration 1", "reg.configuration1", "rw", "configuration"],
  ].map(([name, value, access, evidence], address) => ({
    name,
    value,
    access,
    address,
    evidence: ["addresses", evidence],
  }));
  const readValue = map.reduceRight(
    (rest, item) =>
      select(eq("signal.address", item.address), item.value, rest),
    0,
  );
  const step = [
    assign("signal.valid", accepted),
    assign("signal.error", and("signal.valid", op("gt", "signal.address", 7))),
    ...writable.map((id, index) =>
      assign(
        "reg." + id,
        select(
          reset,
          defaults[index],
          select(
            and(
              "signal.valid",
              "signal.write",
              eq("signal.address", index + 2),
            ),
            "signal.write_data",
            "reg." + id,
          ),
        ),
      ),
    ),
    ...pins,
    assign(
      "signal.read_data",
      select(
        reset,
        0,
        select(
          and(read, op("not", "signal.error")),
          readValue,
          "signal.read_data",
        ),
      ),
    ),
    ...[0, 1].map((port) =>
      assign(
        "reg.sampled" + port,
        select(
          op("or", reset, and(read, eq("signal.address", port))),
          "reg.pins" + port,
          "reg.sampled" + port,
        ),
      ),
    ),
    ...irq,
    assign("reg.previous_request", "signal.request"),
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
      reset,
      "Abstract power reset restores defaults and the scenario interrupt baseline; no bus access is accepted.",
      ["reset"],
    ),
    transition(
      "signal.error",
      "Unmapped register address: scenario access rejected; this is not an I2C NACK simulation.",
      ["addresses"],
    ),
    transition(
      and("signal.valid", "signal.write", op("lt", "signal.address", 2)),
      "Write to input port has no effect; input sampling and interrupt baseline are retained.",
      ["input"],
    ),
    transition(
      and("signal.valid", "signal.write"),
      "Addressed register write completed; inspect address, write_data, latches, and pin drivers.",
      ["addresses", "output", "polarity", "configuration"],
    ),
    transition(
      and(read, op("lt", "signal.address", 2)),
      "Input port read completed; read_data captures the port and acknowledges that port's interrupt.",
      ["input", "interrupt"],
    ),
    transition(
      read,
      "Register latch read completed; read_data retains the returned byte.",
      ["addresses", "output"],
    ),
  ];
  const access = (tick, address, write, value, token) => [
    input(tick, "address", address),
    input(tick, "write", write),
    input(tick, "write_data", value),
    input(tick, "request", token),
  ];
  const checks = [
    {
      name: "Power-on register defaults and released drivers",
      ticks: 1,
      inputs: [],
      expect: {
        "reg.output0": 255,
        "reg.output1": 255,
        "reg.configuration0": 255,
        "reg.configuration1": 255,
        "reg.polarity0": 0,
        "reg.polarity1": 0,
        "signal.p00_driver": "Z",
        "signal.int_driver": "Z",
      },
    },
    {
      name: "Output latch write does not drive input-configured pins",
      ticks: 2,
      inputs: access(1, 2, 1, 179, 1),
      expect: {
        "reg.output0": 179,
        "signal.p00_driver": "Z",
        "signal.input0": 255,
      },
    },
    {
      name: "Output direction publishes the stored byte; port one is independent",
      ticks: 3,
      inputs: [...access(1, 2, 1, 179, 1), ...access(2, 6, 1, 0, 0)],
      expect: {
        "signal.input0": 179,
        "signal.p02_driver": 0,
        "signal.p07_driver": 1,
        "reg.configuration1": 255,
        "signal.p10_driver": "Z",
        "signal.interrupt_pending": 0,
      },
    },
    {
      name: "Latch readback is retained across idle ticks",
      ticks: 4,
      inputs: [...access(1, 3, 1, 165, 1), ...access(2, 3, 0, 0, 0)],
      expect: {
        "signal.read_data": 165,
        "signal.valid": 0,
        "reg.output0": 255,
      },
    },
    {
      name: "Read-only writes have no effect and do not acknowledge interrupt",
      ticks: 2,
      inputs: [input(1, "external0", 0), ...access(1, 0, 1, 255, 1)],
      expect: {
        "signal.input0": 0,
        "reg.sampled0": 255,
        "signal.interrupt_pending": 1,
        "signal.error": 0,
      },
    },
    {
      name: "Reading the other bank does not clear the pending bank",
      ticks: 2,
      inputs: [input(1, "external0", 254), ...access(1, 1, 0, 0, 1)],
      expect: {
        "signal.read_data": 255,
        "signal.int_driver": 0,
        "reg.sampled0": 255,
      },
    },
    {
      name: "Reading the changed input bank acknowledges it",
      ticks: 3,
      inputs: [input(1, "external0", 254), ...access(2, 0, 0, 0, 1)],
      expect: {
        "signal.read_data": 254,
        "reg.sampled0": 254,
        "signal.int_driver": "Z",
      },
    },
    {
      name: "Restoring input levels clears the interrupt without a read",
      ticks: 3,
      inputs: [input(1, "external1", 0), input(2, "external1", 255)],
      expect: { "signal.interrupt_pending": 0, "reg.sampled1": 255 },
    },
    {
      name: "Polarity inverts input reads but not physical interrupt comparison",
      ticks: 3,
      inputs: [...access(1, 4, 1, 255, 1), ...access(2, 0, 0, 0, 0)],
      expect: {
        "signal.input0": 0,
        "signal.read_data": 0,
        "reg.sampled0": 255,
        "signal.interrupt_pending": 0,
      },
    },
    {
      name: "Output pins do not cause interrupts or receive input polarity inversion",
      ticks: 4,
      inputs: [
        ...access(1, 6, 1, 0, 1),
        ...access(2, 4, 1, 255, 0),
        ...access(3, 2, 1, 0, 1),
      ],
      expect: { "signal.input0": 0, "signal.interrupt_pending": 0 },
    },
    {
      name: "Request held high cannot replay a changed write value",
      ticks: 3,
      inputs: [...access(1, 2, 1, 179, 1), input(2, "write_data", 0)],
      expect: { "reg.output0": 179, "signal.valid": 0 },
    },
    {
      name: "Tick-zero request establishes baseline without inventing a transaction",
      ticks: 1,
      inputs: access(0, 2, 1, 0, 1),
      expect: { "reg.output0": 255, "signal.valid": 0 },
    },
    {
      name: "Reset dominates access and request release does not replay it",
      ticks: 4,
      inputs: [
        ...access(1, 2, 1, 0, 1),
        input(2, "power_reset", 1),
        ...access(2, 6, 1, 0, 0),
        input(3, "power_reset", 0),
      ],
      expect: {
        "reg.output0": 255,
        "reg.configuration0": 255,
        "signal.valid": 0,
        "signal.int_driver": "Z",
      },
    },
    {
      name: "Unmapped address leaves latches and read data intact",
      ticks: 1,
      inputs: access(1, 8, 1, 0, 1),
      expect: { "signal.error": 1, "reg.output0": 255, "signal.read_data": 0 },
    },
    {
      name: "Changing output to input compares with its last-read baseline",
      ticks: 3,
      inputs: [
        ...access(1, 6, 1, 0, 1),
        input(2, "external0", 0),
        ...access(2, 6, 1, 255, 0),
      ],
      expect: { "signal.interrupt_pending": 1, "signal.p00_driver": "Z" },
    },
  ];
  return {
    schemaVersion: 1,
    id: "pca9555",
    name: "PCA9555 · register-level I/O expander",
    fidelity: "behavioral",
    summary:
      "Two independent eight-bit GPIO ports with addressed register access, input inversion, direction control, and open-drain interrupt observation.",
    scope:
      "TI PCA9555 SCPS131J ideal register-level behavior, with one explicitly addressed byte per request-token change. No physical I2C serialization, register-pointer persistence, multi-byte paired alternation, other bus devices, ACK/NACK timing, analog supply thresholds, propagation delays, external loading, or bus contention. The page-16 shared-bus interrupt erratum is outside this single-device transaction abstraction.",
    parameters: [],
    signals: [
      ...[0, 1].map((port) => ({
        ...signal("external" + port, 8, "input", 255),
        label: "P" + port + " input scenario levels",
      })),
      signal("power_reset", 1, "input"),
      signal("address", 8, "input"),
      signal("write_data", 8, "input"),
      signal("write", 1, "input"),
      signal("request", 1, "input"),
      signal("read_data", 8, "output"),
      signal("valid", 1, "output"),
      signal("error", 1, "output"),
      ...[0, 1].flatMap((port) => [
        signal("input" + port, 8, "output", 255),
        ...Array.from({ length: 8 }, (_, bit) => ({
          ...signal(`p${port}${bit}_driver`, 1, "output", "Z"),
          triState: true,
        })),
      ]),
      signal("interrupt_pending", 1, "output"),
      {
        ...signal("int_driver", 1, "output", "Z"),
        triState: true,
        label: "INT open-drain driver · 0 / Z",
      },
    ],
    registers: [
      ...writable.map((id, index) => register(id, 8, defaults[index])),
      ...[0, 1].flatMap((port) => [
        register("pins" + port, 8, 255),
        register("sampled" + port, 8, 255),
      ]),
      register("previous_request", 1),
    ],
    registerInterface: {
      kind: "toggle-word-v1",
      address: "address",
      writeData: "write_data",
      write: "write",
      request: "request",
      readData: "read_data",
      valid: "valid",
      error: "error",
    },
    registerMap: map,
    nodes: [
      {
        id: "bus",
        label: "Abstract addressed byte access",
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
        label: "Output / polarity / configuration latches",
        registers: writable,
      },
      {
        id: "ports",
        label: "P0 / P1 drivers and observed levels",
        signals: ["external0", "external1", "input0", "input1"],
        registers: ["pins0", "pins1"],
      },
      {
        id: "interrupt",
        label: "Per-port last-read comparison",
        signals: ["int_driver", "interrupt_pending"],
        registers: ["sampled0", "sampled1"],
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
        label:
          "Power-on defaults; establish input and request baselines without a transaction.",
        entry: [
          ...pins,
          ...[0, 1].map((port) =>
            assign("reg.sampled" + port, "reg.pins" + port),
          ),
          ...irq,
          assign("reg.previous_request", "signal.request"),
        ],
        tick: step,
        transitions: [
          ...transitions,
          transition(
            true,
            "Register interface ready; held request tokens do not generate accesses.",
            ["addresses"],
          ),
        ],
      },
      {
        id: "operating",
        label:
          "Evaluate explicit request changes, port drivers, and independent input interrupt baselines.",
        entry: [],
        tick: step,
        transitions,
        active: ["registers", "ports", "interrupt"],
      },
    ],
    duration: 24,
    exampleInputs: [
      ...access(2, 2, 1, 179, 1),
      ...access(4, 6, 1, 240, 0),
      ...access(6, 2, 0, 0, 1),
      input(8, "external1", 254),
      ...access(10, 0, 0, 0, 0),
      ...access(12, 1, 0, 0, 1),
      ...access(14, 5, 1, 255, 0),
      ...access(16, 1, 0, 0, 1),
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
        quote: "Command Byte",
        claim:
          "Addresses 0–7 select input, output, polarity, and configuration registers in two banks; Table 8-3 gives access and reset values.",
      },
      {
        id: "input",
        page: 20,
        quote: "no effect",
        claim:
          "Input-port reads observe pins regardless of direction; input writes are ignored and initial pin readings depend on applied levels.",
      },
      {
        id: "output",
        page: 20,
        quote: "not the actual pin value",
        claim:
          "Output register reads return stored output selection; only output-configured pins are driven. Table 8-5 specifies all-one reset values.",
      },
      {
        id: "polarity",
        page: 20,
        quote: "polarity inversion",
        claim:
          "Input-configured bits can be inverted in input readings; polarity defaults to zero in Table 8-6.",
      },
      {
        id: "configuration",
        page: 20,
        quote: "high-impedance",
        claim:
          "Configuration one releases the output driver; zero drives the output latch. Table 8-7 defaults to all inputs.",
      },
      {
        id: "interrupt",
        page: 16,
        quote: "read of port 1",
        claim:
          "Input changes interrupt until original levels return or that port is read; output pins cannot interrupt; output-to-input changes can expose a mismatch.",
      },
      {
        id: "open-drain",
        page: 16,
        quote: "open-drain structure",
        claim:
          "INT drives low for pending input mismatch and otherwise releases its driver; a pull-up is required in hardware.",
      },
      {
        id: "reset",
        page: 15,
        quote: "default values",
        claim:
          "Power-on reset restores specified register defaults; power_reset is an abstract scenario control, not a chip pin.",
      },
      {
        id: "erratum",
        page: 16,
        quote: "R/W bit set",
        claim:
          "The documented shared-bus interrupt erratum requires another slave and is omitted, as are ACK/NACK pulse races.",
      },
      {
        id: "pairs",
        page: 21,
        quote: "register pairs",
        claim:
          "Real multi-byte bus transactions alternate within register pairs; this model exposes only individually addressed byte transactions.",
      },
    ].map((item) => ({ ...item, sourceId: "datasheet" })),
    assumptions: [
      "Each request-token change after tick zero denotes one completed addressed byte transaction in one normalized tick. Address, write_data, and write are scenario signals, not device pins. Held request levels do not replay accesses. valid/error are tool status, not I2C ACK/NACK pins; unmapped addresses are rejected by this scenario.",
      "At startup and abstract power reset, the interrupt comparison baseline is the currently supplied pin levels. Both external port-level inputs default to 255 as a chosen driven-high scenario, not a specified numeric Input Port power-on value. power_reset models a completed power reset, not a physical reset pin or VCC voltage ramp.",
      "Uncontended output-configured pins follow their latch; input-configured pins follow the explicit external byte. External inputs do not override driven outputs. No pull-up, floating voltage, analog feedback, load, or contention resolution is inferred. Individual driver signals release to Z for input-configured bits.",
      "Input readings apply polarity only to input-configured bits as stated in the register description. Interrupt comparison uses non-inverted pin levels and independent last-read baselines, masked by configuration. Input reads capture and acknowledge the current tick's levels instantaneously; timing races and the page-16 interrupt erratum are outside scope.",
      "The default demonstration writes port-zero latch and direction, reads it, changes port-one inputs, shows the wrong-bank read retaining INT, acknowledges the right bank, applies input inversion, then power-resets. It is developer-selected stimulus, not autonomous chip behavior.",
    ],
    checks,
  };
}
