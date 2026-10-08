import {
  op,
  assign,
  signal,
  register,
  parameter,
  and,
  input,
} from "../builders/shared.js";

// Reviewed TRM v1.2, §§7.5.2–3 and registers 7.1–6, 7.16.
// Logical simple-output path only. Package/IO MUX configuration is not executed.
export function esp32c6Gpio(source) {
  const eq = (a, b) => op("eq", a, b),
    choose = (condition, yes, no) => op("select", condition, yes, no),
    reset = "signal.reset",
    word = op("bitAnd", "signal.write_data", 0x7fffffff),
    write = and("signal.valid", "signal.write", op("not", "signal.error"));
  const map = [
    {
      address: 4,
      name: "GPIO_OUT_REG",
      access: "rw",
      value: "reg.gpio_out",
      evidence: ["out"],
    },
    {
      address: 8,
      name: "GPIO_OUT_W1TS_REG",
      access: "wo",
      evidence: ["out-set"],
    },
    {
      address: 12,
      name: "GPIO_OUT_W1TC_REG",
      access: "wo",
      evidence: ["out-clear"],
    },
    {
      address: 32,
      name: "GPIO_ENABLE_REG",
      access: "rw",
      value: "reg.gpio_enable",
      evidence: ["enable"],
    },
    {
      address: 36,
      name: "GPIO_ENABLE_W1TS_REG",
      access: "wo",
      evidence: ["enable-set"],
    },
    {
      address: 40,
      name: "GPIO_ENABLE_W1TC_REG",
      access: "wo",
      evidence: ["enable-clear"],
    },
  ];
  const readable = op("or", eq("signal.address", 4), eq("signal.address", 32)),
    mapped = map
      .map((entry) => eq("signal.address", entry.address))
      .reduce((a, b) => op("or", a, b));
  const latch = (id, address) =>
    assign(
      "reg." + id,
      choose(
        reset,
        0,
        choose(
          write,
          choose(
            eq("signal.address", address),
            word,
            choose(
              eq("signal.address", address + 4),
              op("bitOr", "reg." + id, word),
              choose(
                eq("signal.address", address + 8),
                op("bitAnd", "reg." + id, op("bitXor", word, 0x7fffffff)),
                "reg." + id,
              ),
            ),
          ),
          "reg." + id,
        ),
      ),
    );
  const outputs = [
    assign("signal.output_latch", "reg.gpio_out"),
    assign("signal.enable_mask", "reg.gpio_enable"),
    assign(
      "signal.selected_driver",
      choose(
        op(
          "bitAnd",
          op("shiftRight", "reg.gpio_enable", "param.watch_gpio"),
          1,
        ),
        op("bitAnd", op("shiftRight", "reg.gpio_out", "param.watch_gpio"), 1),
        "Z",
      ),
    ),
  ];
  const step = [
    assign(
      "signal.valid",
      and(op("not", reset), op("ne", "signal.request", "reg.previous_request")),
    ),
    assign(
      "signal.error",
      and("signal.valid", op("not", choose("signal.write", mapped, readable))),
    ),
    latch("gpio_out", 4),
    latch("gpio_enable", 32),
    assign(
      "signal.read_data",
      choose(
        reset,
        0,
        choose(
          and(
            "signal.valid",
            op("not", "signal.write"),
            op("not", "signal.error"),
          ),
          choose(eq("signal.address", 4), "reg.gpio_out", "reg.gpio_enable"),
          "signal.read_data",
        ),
      ),
    ),
    ...outputs,
    assign("reg.previous_request", "signal.request"),
  ];
  const transition = (when, message, evidence) => ({
    to: "operating",
    when,
    message,
    evidence,
    actions: [],
    active: ["bus", "latches", "driver"],
  });
  const transitions = [
    transition(
      reset,
      "Scenario reset restores the two latch defaults; no access accepted.",
      ["out", "enable"],
    ),
    transition(
      "signal.error",
      "Unsupported address/read rejected by the tool adapter; latches and previous read data retained.",
      ["out", "enable"],
    ),
    ...map.map((entry) =>
      transition(
        and(write, eq("signal.address", entry.address)),
        entry.name +
          (entry.access === "wo"
            ? ": written ones act on corresponding latch bits; zeros preserve them."
            : ": replaced bits 0–30; inspect selected logical driver."),
        entry.evidence,
      ),
    ),
    transition(
      and("signal.valid", op("not", "signal.write")),
      "Read retained latch value; output enable determines whether the selected driver is released.",
      ["out", "enable", "routing"],
    ),
  ];
  const access = (tick, address, value = 0, write = 1, token = tick % 2) => [
    input(tick, "address", address),
    input(tick, "write_data", value),
    input(tick, "write", write),
    input(tick, "request", token),
  ];
  return {
    schemaVersion: 1,
    id: "esp32c6-gpio",
    name: "ESP32-C6 · GPIO output registers",
    fidelity: "behavioral",
    summary:
      "Simple GPIO output latches, atomic set/clear masks and a selected logical output driver.",
    scope:
      "ESP32-C6 TRM v1.2 GPIO_OUT/ENABLE and their W1TS/W1TC aliases, bits 0–30, in a preconfigured simple-output path. One completed 32-bit word per request change. No CPU/APB timing, input reads, interrupts, ETM, open drain, matrix/IO MUX programming, LP GPIO, sleep/hold, package mapping or electrical behavior. Alias reads are unsupported tool operations, not simulated bus faults.",
    parameters: [parameter("watch_gpio", "Observe logical GPIO bit", 0, 0, 30)],
    signals: [
      {
        ...signal("selected_driver", 1, "output", "Z"),
        triState: true,
        label: "Selected GPIO driver",
      },
      {
        ...signal("output_latch", 32, "output"),
        label: "GPIO_OUT retained bits",
      },
      {
        ...signal("enable_mask", 32, "output"),
        label: "GPIO_ENABLE mask",
      },
      { ...signal("reset", 1, "input"), label: "Scenario reset" },
      { ...signal("address", 16, "input"), label: "GPIO-relative offset" },
      signal("write_data", 32, "input"),
      signal("write", 1, "input"),
      signal("request", 1, "input"),
      signal("read_data", 32, "output"),
      signal("valid", 1, "output"),
      signal("error", 1, "output"),
    ],
    registers: [
      register("gpio_out", 32),
      register("gpio_enable", 32),
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
        label: "Completed word / relative offset",
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
        id: "latches",
        label: "OUT / ENABLE + set-clear aliases",
        registers: ["gpio_out", "gpio_enable"],
        signals: ["output_latch", "enable_mask"],
      },
      {
        id: "driver",
        label: "Selected simple-output driver",
        signals: ["selected_driver"],
      },
    ],
    edges: [
      { from: "bus", to: "latches" },
      { from: "latches", to: "bus" },
      { from: "latches", to: "driver" },
    ],
    initialState: "initialize",
    states: [
      {
        id: "initialize",
        label: "Latch defaults and request baseline",
        entry: [assign("reg.previous_request", "signal.request"), ...outputs],
        tick: step,
        transitions: [
          ...transitions,
          transition(
            true,
            "GPIO output experiment ready; tick zero establishes the request baseline.",
            ["out", "enable"],
          ),
        ],
      },
      {
        id: "operating",
        label: "Word accesses and logical output driver",
        entry: [],
        tick: step,
        transitions,
        active: ["latches", "driver"],
      },
    ],
    duration: 24,
    exampleInputs: [
      ...access(2, 4, 179, 1, 1),
      ...access(4, 32, 15, 1, 0),
      ...access(6, 8, 256, 1, 1),
      ...access(8, 36, 256, 1, 0),
      ...access(10, 12, 3, 1, 1),
      ...access(12, 40, 1, 1, 0),
      ...access(14, 4, 0, 0, 1),
      ...access(16, 32, 0, 0, 0),
      ...access(18, 8, 0, 1, 1),
      input(20, "reset", 1),
      input(21, "reset", 0),
    ],
    sources: [
      {
        ...source,
        id: "manual",
        filename: source.path.split("/").at(-1),
        url: source.source_url,
      },
    ],
    evidence: [
      {
        id: "routing",
        page: 280,
        quote: "128: Bit n of GPIO_OUT_REG and GPIO_ENABLE_REG",
        claim:
          "Simple GPIO selects OUT and ENABLE. Output/enable inversion are separate configuration, held disabled in this experiment.",
      },
      {
        id: "setup",
        page: 251,
        quote: "7.5.3 Simple GPIO Output",
        claim:
          "The scenario assumes GPIO routing, normal push-pull drive and peripheral index 128 are already configured; it does not execute these setup writes.",
      },
      {
        id: "out",
        page: 270,
        quote: "Register 7.1. GPIO_OUT_REG (0x0004)",
        claim:
          "Relative offset 4 stores output bits 0–30 with zero reset; bit 31 is invalid.",
      },
      {
        id: "out-set",
        page: 271,
        quote: "1: The corresponding bit in GPIO_OUT_REG will be set to 1",
        claim:
          "OUT_W1TS offset 8 sets written-one bits and preserves written-zero bits.",
      },
      {
        id: "out-clear",
        page: 271,
        quote: "1: The corresponding bit in GPIO_OUT_REG will be cleared.",
        claim:
          "OUT_W1TC offset 12 clears written-one bits and preserves written-zero bits.",
      },
      {
        id: "enable",
        page: 272,
        quote: "Register 7.4. GPIO_ENABLE_REG (0x0020)",
        claim:
          "Relative offset 32 stores output-enable bits 0–30, reset zero; one enables, zero disables.",
      },
      {
        id: "enable-set",
        page: 272,
        quote: "1: The corresponding bit in GPIO_ENABLE_REG will be set to 1",
        claim: "ENABLE_W1TS offset 36 sets written-one enable bits.",
      },
      {
        id: "enable-clear",
        page: 273,
        quote: "1: The corresponding bit in GPIO_ENABLE_REG will be cleared",
        claim: "ENABLE_W1TC offset 40 clears written-one enable bits.",
      },
      {
        id: "package",
        page: 244,
        quote: "GPIO14 is not led out to any chip pins",
        claim:
          "Package variants expose different GPIOs and may dedicate pins to in-package flash. Logical bit observation does not establish package availability.",
      },
    ].map((entry) => ({ ...entry, sourceId: "manual" })),
    assumptions: [
      "GPIO_FUNCn_OUT_SEL is fixed at 128, with output and enable inversion disabled, normal push-pull output, GPIO IO MUX routing and no other controller/hold override. These are scenario preconditions, not a whole-chip reset configuration. watch_gpio selects a logical register bit, not a guaranteed available package pin; consult the variant's pin/flash restrictions.",
      "The adapter uses GPIO-relative byte offsets and 32-bit completed words, not absolute CPU addresses or APB cycles. A request-token change after tick zero performs one access. valid/error are tool observations. Held requests and requests during scenario reset are consumed without replay. read_data retains the last successful read until reset.",
      "Only OUT and ENABLE reads and writes to all six listed offsets are supported. WT alias reads and all other offsets produce a tool error and preserve latches/read_data. wo metadata describes this restricted adapter, not an asserted silicon read-fault response. Written bit 31 is discarded and canonical readback bit 31 is normalized to zero by the model; the manual labels it invalid, not a guaranteed hardware read value.",
      "Scenario reset restores only the two documented zero latch defaults and adapter state while retaining the routing preconditions. It is not a physical reset pin, reset-domain sequence, boot ROM execution, or power event simulation.",
      "selected_driver follows the chosen latch bit when enabled and is Z when disabled. Z means a released driver, not a measured voltage. No input buffer, GPIO_IN, pulls, contention, current, timing, open drain or external pad resolution is simulated. Changing watch_gpio selects a new observation run without writing hardware registers.",
      "The demonstration writes 179 (0xB3), enables four outputs, sets bit 8 in each latch, clears output bits 0–1, releases driver 0, reads both canonical latches, writes a zero set-mask, then resets. These are explicit test transactions.",
    ],
    checks: [
      {
        name: "Zero defaults and released driver",
        ticks: 1,
        expect: {
          "reg.gpio_out": 0,
          "reg.gpio_enable": 0,
          "signal.selected_driver": "Z",
        },
      },
      {
        name: "Output latch write does not enable its driver",
        ticks: 1,
        inputs: access(1, 4, 179),
        expect: { "reg.gpio_out": 179, "signal.selected_driver": "Z" },
      },
      {
        name: "Enable exposes stored output",
        ticks: 2,
        inputs: [...access(1, 4, 179), ...access(2, 32, 15)],
        expect: { "signal.selected_driver": 1, "reg.gpio_enable": 15 },
      },
      {
        name: "Set alias preserves unrelated bits",
        ticks: 2,
        inputs: [...access(1, 4, 179), ...access(2, 8, 256)],
        expect: { "reg.gpio_out": 435 },
      },
      {
        name: "Clear alias preserves unrelated bits",
        ticks: 2,
        inputs: [...access(1, 4, 435), ...access(2, 12, 3)],
        expect: { "reg.gpio_out": 432 },
      },
      {
        name: "Enable set alias preserves other enables",
        ticks: 2,
        inputs: [...access(1, 32, 15), ...access(2, 36, 256)],
        expect: { "reg.gpio_enable": 271 },
      },
      {
        name: "Enable clear releases selected driver",
        ticks: 2,
        inputs: [...access(1, 32, 271), ...access(2, 40, 1)],
        expect: { "reg.gpio_enable": 270, "signal.selected_driver": "Z" },
      },
      {
        name: "Zero masks have no effect",
        ticks: 3,
        inputs: [...access(1, 4, 435), ...access(2, 8, 0), ...access(3, 12, 0)],
        expect: { "reg.gpio_out": 435 },
      },
      {
        name: "Canonical reads return retained values",
        ticks: 2,
        inputs: [...access(1, 4, 435), ...access(2, 4, 0, 0)],
        expect: {
          "signal.read_data": 435,
          "signal.valid": 1,
          "signal.error": 0,
        },
      },
      {
        name: "Bit 31 is normalized out of the modeled word",
        ticks: 1,
        inputs: access(1, 4, 0xffffffff),
        expect: { "reg.gpio_out": 0x7fffffff },
      },
      {
        name: "Highest valid bit has an observable driver",
        ticks: 2,
        parameters: { watch_gpio: 30 },
        inputs: [...access(1, 4, 0x40000000), ...access(2, 36, 0x40000000)],
        expect: { "signal.selected_driver": 1 },
      },
      {
        name: "Held token cannot replay changed bus fields",
        ticks: 2,
        inputs: [...access(1, 4, 179), input(2, "write_data", 0)],
        expect: { "reg.gpio_out": 179, "signal.valid": 0 },
      },
      {
        name: "Tick zero initializes the request baseline",
        ticks: 1,
        inputs: access(0, 4, 179, 1, 1),
        expect: { "reg.gpio_out": 0, "signal.valid": 0 },
      },
      {
        name: "Reset dominates writes without replay on release",
        ticks: 3,
        inputs: [
          ...access(1, 4, 179),
          input(2, "reset", 1),
          ...access(2, 32, 15),
          input(3, "reset", 0),
        ],
        expect: { "reg.gpio_out": 0, "reg.gpio_enable": 0, "signal.valid": 0 },
      },
      {
        name: "Unmapped writes are rejected by the adapter",
        ticks: 1,
        inputs: access(1, 16, 255),
        expect: { "signal.error": 1, "reg.gpio_out": 0 },
      },
      {
        name: "Alias reads are unsupported and retain prior read data",
        ticks: 3,
        inputs: [
          ...access(1, 4, 179),
          ...access(2, 4, 0, 0),
          ...access(3, 8, 0, 0),
        ],
        expect: {
          "signal.error": 1,
          "signal.read_data": 179,
          "reg.gpio_out": 179,
        },
      },
    ],
  };
}
