import {
  op,
  assign,
  signal,
  register,
  parameter,
  and,
  input,
} from "../builders/shared.js";

// ESP32-C6 TRM v1.2, Chapter 31. One unit, channel 0 only, filter disabled.
// Configuration is selected before the run; no live MMIO/interrupt semantics.
export function esp32c6Pcnt(source) {
  const eq = (a, b) => op("eq", a, b),
    choose = (condition, yes, no) => op("select", condition, yes, no),
    enabled = and(op("not", "signal.pause"), op("not", "signal.clear")),
    mode = choose("signal.pulse", "param.positive_mode", "param.negative_mode"),
    control = choose(
      "signal.control",
      "param.control_high_mode",
      "param.control_low_mode",
    ),
    direction = (normal, inverted) =>
      and(
        enabled,
        op(
          "or",
          and(eq("reg.control_mode", 0), eq("reg.edge_mode", normal)),
          and(eq("reg.control_mode", 1), eq("reg.edge_mode", inverted)),
        ),
      );
  const step = [
    assign(
      "reg.edge_mode",
      choose(op("ne", "signal.pulse", "reg.previous_pulse"), mode, 0),
    ),
    assign("reg.control_mode", control),
    assign("signal.count_up", direction(1, 2)),
    assign("signal.count_down", direction(2, 1)),
    assign(
      "reg.candidate_count",
      choose(
        "signal.count_up",
        op("add", "reg.pulse_count", 1),
        choose(
          "signal.count_down",
          op("sub", "reg.pulse_count", 1),
          "reg.pulse_count",
        ),
      ),
    ),
    assign(
      "signal.high_limit_hit",
      and("signal.count_up", eq("reg.candidate_count", "reg.high_limit")),
    ),
    assign(
      "signal.low_limit_hit",
      and("signal.count_down", eq("reg.candidate_count", "reg.low_limit")),
    ),
    assign(
      "reg.pulse_count",
      choose(
        op(
          "or",
          "signal.clear",
          op("or", "signal.high_limit_hit", "signal.low_limit_hit"),
        ),
        0,
        "reg.candidate_count",
      ),
    ),
    assign("signal.negative", op("ge", "reg.pulse_count", 32768)),
    assign(
      "signal.magnitude",
      choose(
        "signal.negative",
        op("sub", 65536, "reg.pulse_count"),
        "reg.pulse_count",
      ),
    ),
    assign("reg.previous_pulse", "signal.pulse"),
  ];
  const transition = (when, message, evidence, active) => ({
    to: "counting",
    when,
    message,
    evidence,
    active,
    actions: [],
  });
  const transitions = [
    transition(
      "signal.clear",
      "Counter clear asserted: count is zero; sampled pulse history still advances.",
      ["pause-clear"],
      ["counter"],
    ),
    transition(
      "signal.pause",
      "Counter paused: count retained; sampled pulse history still advances.",
      ["pause-clear"],
      ["counter"],
    ),
    transition(
      "signal.high_limit_hit",
      "Positive count reached the high limit: count cleared to zero.",
      ["limits"],
      ["counter", "limits"],
    ),
    transition(
      "signal.low_limit_hit",
      "Negative count reached the low limit: count cleared to zero.",
      ["limits"],
      ["counter", "limits"],
    ),
    transition(
      "signal.count_up",
      "Accepted pulse edge increments the signed counter.",
      ["modes"],
      ["edge", "control", "counter"],
    ),
    transition(
      "signal.count_down",
      "Accepted pulse edge decrements the signed counter.",
      ["modes"],
      ["edge", "control", "counter"],
    ),
    transition(
      op("ne", "reg.edge_mode", 0),
      "Selected edge/control modes produce no count operation.",
      ["control"],
      ["edge", "control"],
    ),
  ];
  const pulses = (count) =>
    Array.from({ length: count }, (_, i) => [
      input(1 + i * 2, "pulse", 1),
      input(2 + i * 2, "pulse", 0),
    ]).flat();
  const checks = [
    {
      name: "Initial pulse level establishes history without inventing an edge",
      ticks: 1,
      inputs: [input(0, "pulse", 1)],
      expect: { "reg.pulse_count": 0, "reg.previous_pulse": 1 },
    },
    {
      name: "Positive-edge increment",
      ticks: 3,
      inputs: pulses(2),
      expect: {
        "reg.pulse_count": 2,
        "signal.magnitude": 2,
        "signal.negative": 0,
      },
    },
    {
      name: "Negative-edge decrement uses signed two's-complement storage",
      ticks: 2,
      parameters: { positive_mode: 0, negative_mode: 2 },
      inputs: pulses(1),
      expect: {
        "reg.pulse_count": 65535,
        "signal.negative": 1,
        "signal.magnitude": 1,
      },
    },
    {
      name: "High control reverses increment",
      ticks: 1,
      inputs: [input(0, "control", 1), input(1, "pulse", 1)],
      expect: { "reg.pulse_count": 65535, "signal.count_down": 1 },
    },
    {
      name: "High control reverses decrement",
      ticks: 1,
      parameters: { positive_mode: 2 },
      inputs: [input(0, "control", 1), input(1, "pulse", 1)],
      expect: { "reg.pulse_count": 1, "signal.count_up": 1 },
    },
    {
      name: "Inhibit mode holds the counter",
      ticks: 5,
      parameters: { control_low_mode: 2 },
      inputs: pulses(3),
      expect: {
        "reg.pulse_count": 0,
        "signal.count_up": 0,
        "signal.count_down": 0,
      },
    },
    {
      name: "Reserved edge mode is no effect",
      ticks: 5,
      parameters: { positive_mode: 3, negative_mode: 3 },
      inputs: pulses(3),
      expect: { "reg.pulse_count": 0 },
    },
    {
      name: "Positive limit clears exactly at the reaching edge",
      ticks: 9,
      inputs: pulses(5),
      expect: { "reg.pulse_count": 0, "signal.high_limit_hit": 1 },
    },
    {
      name: "Negative limit clears exactly at the reaching edge",
      ticks: 9,
      parameters: { positive_mode: 2 },
      inputs: pulses(5),
      expect: { "reg.pulse_count": 0, "signal.low_limit_hit": 1 },
    },
    {
      name: "Limit observations are one-tick tool events, not interrupt latches",
      ticks: 10,
      inputs: pulses(5),
      expect: { "reg.pulse_count": 0, "signal.high_limit_hit": 0 },
    },
    {
      name: "Pause ignores an edge and release does not replay it",
      ticks: 3,
      inputs: [
        input(1, "pause", 1),
        input(2, "pulse", 1),
        input(3, "pause", 0),
      ],
      expect: { "reg.pulse_count": 0, "signal.count_up": 0 },
    },
    {
      name: "Clear dominates pause and an input edge",
      ticks: 3,
      inputs: [...pulses(2), input(3, "pause", 1), input(3, "clear", 1)],
      expect: {
        "reg.pulse_count": 0,
        "signal.count_up": 0,
        "signal.high_limit_hit": 0,
      },
    },
    {
      name: "Held clear keeps zero; release does not manufacture an edge",
      ticks: 4,
      inputs: [
        input(1, "pulse", 1),
        input(2, "clear", 1),
        input(4, "clear", 0),
      ],
      expect: { "reg.pulse_count": 0, "reg.previous_pulse": 1 },
    },
    {
      name: "Changing only the control level cannot count",
      ticks: 3,
      inputs: [
        input(0, "pulse", 1),
        input(1, "control", 1),
        input(2, "control", 0),
      ],
      expect: { "reg.pulse_count": 0 },
    },
    {
      name: "A count can return from negative one to zero",
      ticks: 3,
      parameters: { positive_mode: 2, negative_mode: 1 },
      inputs: pulses(1),
      expect: {
        "reg.pulse_count": 0,
        "signal.magnitude": 0,
        "signal.negative": 0,
      },
    },
    {
      name: "Unit limit one clears each accepted count",
      ticks: 1,
      parameters: { high_limit: 1 },
      inputs: pulses(1),
      expect: { "reg.pulse_count": 0, "signal.high_limit_hit": 1 },
    },
  ];
  return {
    schemaVersion: 1,
    id: "esp32c6-pcnt",
    name: "ESP32-C6 · PCNT channel 0",
    fidelity: "behavioral",
    summary:
      "Signed pulse counting with edge selection, control-level reversal/inhibition, pause, clear and high/low limit rollover.",
    scope:
      "One ESP32-C6 PCNT unit, channel 0, with channel 1 disabled and filtering disabled. Static pre-run configuration; normalized sampled edges. This is not an ESP32-C6 CPU/full-chip simulator. MMIO, interrupts/watchpoint latches, threshold comparators, GPIO routing, APB synchronization, glitch filtering, dynamic limit updates and other units/peripherals are omitted.",
    parameters: [
      parameter(
        "positive_mode",
        "Rising edge: 0/3 hold, 1 up, 2 down",
        1,
        0,
        3,
      ),
      parameter(
        "negative_mode",
        "Falling edge: 0/3 hold, 1 up, 2 down",
        0,
        0,
        3,
      ),
      parameter(
        "control_low_mode",
        "Control low: 0 keep, 1 reverse, 2/3 inhibit",
        0,
        0,
        3,
      ),
      parameter(
        "control_high_mode",
        "Control high: 0 keep, 1 reverse, 2/3 inhibit",
        1,
        0,
        3,
      ),
      parameter("high_limit", "Positive limit", 5, 1, 32767),
      parameter(
        "low_limit_magnitude",
        "Negative limit magnitude (5 means -5)",
        5,
        1,
        32768,
      ),
    ],
    signals: [
      { ...signal("pulse", 1, "input"), label: "CH0 pulse input" },
      { ...signal("control", 1, "input"), label: "CH0 control level" },
      { ...signal("pause", 1, "input"), label: "Applied counter pause" },
      { ...signal("clear", 1, "input"), label: "Applied counter clear" },
      { ...signal("negative", 1, "output"), label: "Count is negative" },
      { ...signal("magnitude", 16, "output"), label: "Absolute count" },
      {
        ...signal("count_up", 1, "output"),
        label: "Accepted increment (tool)",
      },
      {
        ...signal("count_down", 1, "output"),
        label: "Accepted decrement (tool)",
      },
      {
        ...signal("high_limit_hit", 1, "output"),
        label: "High limit hit (tool)",
      },
      {
        ...signal("low_limit_hit", 1, "output"),
        label: "Low limit hit (tool)",
      },
    ],
    registers: [
      register("pulse_count", 16),
      register("previous_pulse", 1),
      register("edge_mode", 2),
      register("control_mode", 2),
      register("candidate_count", 16),
      register("high_limit", 16),
      register("low_limit", 16),
    ],
    nodes: [
      {
        id: "edge",
        label: "CH0 sampled pulse edges",
        signals: ["pulse"],
        registers: ["previous_pulse", "edge_mode"],
      },
      {
        id: "control",
        label: "Keep / reverse / inhibit",
        signals: ["control", "count_up", "count_down"],
        registers: ["control_mode"],
      },
      {
        id: "counter",
        label: "Signed 16-bit pulse counter",
        signals: ["pause", "clear", "negative", "magnitude"],
        registers: ["pulse_count"],
      },
      {
        id: "limits",
        label: "High / low limits clear count",
        signals: ["high_limit_hit", "low_limit_hit"],
        registers: ["candidate_count", "high_limit", "low_limit"],
      },
    ],
    edges: [
      { from: "edge", to: "control" },
      { from: "control", to: "counter" },
      { from: "counter", to: "limits" },
      { from: "limits", to: "counter" },
    ],
    initialState: "initialize",
    states: [
      {
        id: "initialize",
        label: "Configured, cleared counter and input baseline",
        entry: [
          assign("reg.previous_pulse", "signal.pulse"),
          assign("reg.control_mode", control),
          assign("reg.high_limit", "param.high_limit"),
          assign(
            "reg.low_limit",
            op("sub", 65536, "param.low_limit_magnitude"),
          ),
        ],
        tick: step,
        transitions: [
          ...transitions,
          transition(
            true,
            "Pulse baseline sampled; counter retains its value.",
            ["adder"],
            ["edge"],
          ),
        ],
      },
      {
        id: "counting",
        label: "Pulse counting",
        entry: [],
        tick: step,
        transitions,
        active: ["edge", "counter"],
      },
    ],
    duration: 34,
    exampleInputs: [
      ...pulses(17),
      input(11, "control", 1),
      input(20, "control", 0),
      input(21, "pause", 1),
      input(25, "pause", 0),
      input(27, "clear", 1),
      input(31, "clear", 0),
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
        id: "channels",
        page: 1012,
        quote: "two channels (ch0 and ch1)",
        claim:
          "Each unit has two pulse/control channels sharing a counter; this profile selects channel 0 with channel 1 disabled.",
      },
      {
        id: "modes",
        page: 1014,
        quote: "Table 31.2-1.",
        claim:
          "Tables 31.2-1 through 31.2-4 specify edge modes and control-level keep/reverse/inhibit combinations.",
      },
      {
        id: "adder",
        page: 1015,
        quote: "16-bit wide signed register",
        claim:
          "The shared adder stores a signed 16-bit count; raw storage, sign and magnitude are exposed separately.",
      },
      {
        id: "control",
        page: 1021,
        quote: "Inhibit counter modification",
        claim:
          "Control codes 0 keep, 1 invert and 2/3 inhibit the selected edge operation. Edge codes 0/3 have no effect.",
      },
      {
        id: "limits",
        page: 1022,
        quote: "the counter will be cleared to 0",
        claim:
          "Reaching the configured high or low limit clears the counter. This model uses static positive/negative limits and exposes one-tick observations, not interrupt latches.",
      },
      {
        id: "pause-clear",
        page: 1023,
        quote: "Write 1 to freeze unit n",
        claim:
          "Pause freezes the counter and clear resets it to zero. These scenario inputs represent applied controls, not MMIO transactions.",
      },
      {
        id: "live-limits",
        page: 1015,
        quote: "the new configuration will take effect",
        claim:
          "Live limit changes have watchpoint-dependent behavior; they are excluded by using pre-run parameters only.",
      },
    ].map((item) => ({ ...item, sourceId: "manual" })),
    assumptions: [
      "One unit/channel 0 is configured before the run; channel 1 is disabled, the filter is disabled and the peripheral clock is available. Selected parameter defaults are demonstration settings, not register reset values. The counter begins cleared.",
      "Ticks are ideal observations of already-stable pulse/control levels, not APB cycles. Tick zero captures pulse history without counting. Control is sampled with the edge; simultaneous changes have this explicit ordering. Physical setup/hold, synchronization, metastability and glitch rejection are omitted.",
      "Pause freezes only the counter; pulse history still follows sampled input levels. Clear keeps the counter zero and dominates pause/counting. Releasing either control does not replay earlier edges. pause/clear are abstract applied controls, not physical pins or a bus interface.",
      "pulse_count stores the unsigned two's-complement bit pattern. negative and magnitude expose its signed meaning without changing the common numeric formatter. Low-limit magnitude 5 means -5 (raw 0xFFFB). Limits are restricted to positive high and negative low values surrounding zero.",
      "count_up/count_down and high_limit_hit/low_limit_hit are one-tick tool observations. They are not silicon interrupt bits. Interrupt enable/status/clear, five-watchpoint latches, thresholds, zero modes and live configuration timing are not modeled.",
      "The demo counts up to +5, reverses through control high down to -5, pauses, resumes and clears. CPU execution, remaining PCNT units, GPIO matrix and all other ESP32-C6 peripherals are outside this profile.",
    ],
    checks,
  };
}
