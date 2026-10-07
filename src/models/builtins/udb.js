import { hex } from "../../core/values.js";
import {
  copy,
  bit,
  frameEnd,
  edges,
  base,
  sample,
  endFrame,
  ackInput,
  resolveAck,
  add,
  finalized,
  terminal,
} from "../../core/protocol.js";
export const metadata = {
  ...{
    name: "PSoC UDB",
    short: "UDB",
    tag: "Configured logic network",
    summary:
      "PLD state and routed conditions select datapath operations and pin levels.",
    writable: "PLD equations + control words + routing",
    pin: "Configured logic / datapath outputs through routes",
    limit: "Logic terms, datapath width, routes and clocks",
    stressTitle: "Gate the protocol clock",
    stressText:
      "At ticks 4–7, the configured clock enable is low. FSM and counters retain their state.",
    fixed:
      "A composed UDB network is shown. PLDs, 8-bit datapaths, local control RAM and digital routing are manufactured blocks. This complete link is not claimed to fit one UDB.",
    source: [
      [
        "PSoC 5LP Architecture TRM · Chapters 21–22",
        "https://www.infineon.com/assets/row/public/documents/30/57/infineon-psoc5lp-architecture-trm-additionaltechnicalinformation-en.pdf",
      ],
    ],
    notes:
      "The PLD state addresses eight-entry datapath configuration stores. They do not fetch a program or have a datapath PC. The model abstracts fitting, propagation delay and clock distribution.",
  },
  changes: (c) => [
    [
      "Payload",
      `Load datapath storage with ${hex(c.payload, Math.ceil(c.bits / 4))}.`,
    ],
    [
      "Length",
      `Set terminal count ${c.bits}; ${c.bits > 8 ? "chain wider data storage across 8-bit datapaths" : "one 8-bit data lane holds the payload"}.`,
    ],
    [
      "Period",
      `Compare the half-period counter with H=${c.half}; route compare into next-state logic.`,
    ],
    [
      "ACK",
      "PLD equations select DONE or TIMEOUT from routed ACK and deadline conditions.",
    ],
  ],
};
export const topology = {
  nodes: [
    {
      id: "config",
      label: "PLD / route definition",
      x: 18,
      y: 15,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
    {
      id: "pld",
      label: "PLD state / logic",
      x: 243,
      y: 15,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "clock",
      label: "Clock distribution",
      x: 18,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "ram",
      label: "Datapath control RAM",
      x: 243,
      y: 120,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
    {
      id: "pins",
      label: "Input / output pins",
      x: 468,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "fifo",
      label: "FIFO / input data",
      x: 18,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "datapath",
      label: "8-bit datapath network",
      x: 243,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "route",
      label: "Digital routing",
      x: 468,
      y: 245,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
  ],
  edges: [
    ["config", "pld"],
    ["clock", "pld"],
    ["pld", "ram"],
    ["ram", "datapath"],
    ["fifo", "datapath"],
    ["datapath", "route"],
    ["route", "pld"],
    ["route", "pins"],
    ["pins", "pld"],
  ],
};
export function simulateUDB(c) {
  const out = [],
    s = base(c);
  s.fsm = "LOW";
  s.counter = c.half;
  s.remaining = c.bits;
  s.shift = c.payload;
  s.enable = 1;
  for (let t = 0; t <= frameEnd(c) + c.budget + c.ackDelay + 16; t++) {
    s.t = t;
    const gated = c.stress && t >= 4 && t < 8;
    s.enable = gated ? 0 : 1;
    if (finalized(s)) terminal(s, c);
    else if (t === 0) {
      s.line = 1;
      s.active = ["config", "pld", "ram", "datapath", "route", "pins"];
      s.event = "Configured logic loads the payload and enters LOW.";
      s.detail =
        "PLD state selects datapath operations through control-store address inputs.";
    } else if (s.phase === "send" && gated) {
      s.line = s.clock ? 3 : 2;
      s.active = ["clock"];
      s.event = "Clock gated: FSM and timing counters hold.";
      s.detail =
        "Routing still reflects the stored output state; no state update occurs.";
    } else if (s.phase === "send") {
      s.counter--;
      s.line = s.fsm === "LOW" ? 2 : 3;
      s.active = ["clock", "pld", "ram", "datapath"];
      if (s.counter === 0) {
        s.counter = c.half;
        if (s.fsm === "LOW") {
          s.fsm = "HIGH";
          s.clock = 1;
          sample(s);
          s.line = 3;
          s.event = "Half-period compare selects HIGH; routed CLK rises.";
          s.detail =
            "PLD next-state equations and output logic produce the transition.";
        } else {
          s.clock = 0;
          s.remaining--;
          if (!s.remaining) {
            s.fsm = "ACK_WAIT";
            endFrame(s, c);
            s.line = 5;
            s.event = "Terminal bit count selects ACK_WAIT.";
            s.detail =
              "The same routed logic now evaluates ACK and timeout conditions.";
          } else {
            s.fsm = "LOW";
            s.shift >>>= 1;
            s.data = s.shift & 1;
            s.bitIndex++;
            s.line = 4;
            s.event =
              "Selected datapath shifts; remaining-bit counter decrements.";
            s.detail =
              "Control RAM contents select an operation; there is no datapath instruction PC.";
          }
        }
        s.active.push("route", "pins");
      } else {
        s.event = "Timing datapath counts enabled clock events.";
        s.detail = "Its compare output feeds the configured PLD equations.";
      }
    } else {
      s.line = 6;
      s.active = ["pld", "ram", "datapath", "pins"];
      s.event = "PLD evaluates routed ACK and deadline conditions.";
      s.detail =
        "Local state selects the result path without a CPU polling loop.";
      if (resolveAck(s, c)) {
        s.fsm = s.phase === "success" ? "DONE" : "TIMEOUT";
        s.line = 7;
      }
    }
    ackInput(s, c);
    const addr = { LOW: 0, HIGH: 1, ACK_WAIT: 2, DONE: 3, TIMEOUT: 4 }[s.fsm];
    s.values = {
      config: [`${c.bits}-bit composition`, "equations + routes"],
      pld: [s.fsm, "macrocell state"],
      ram: [`address=${addr}`, "8 control words / store"],
      clock: [`enable=${s.enable}`, "configured clock gate"],
      fifo: [hex(c.payload), "host-loaded data"],
      datapath: [
        `${hex(s.shift)}; left=${s.remaining}`,
        `8-bit lanes; half=${s.counter}`,
      ],
      route: ["state + compare → pin", "digital interconnect"],
      pins: [`D=${s.data} C=${s.clock} A=${s.ack}`, "configured outputs"],
    };
    add(out, s);
  }
  return out;
}
export const simulate = simulateUDB;
