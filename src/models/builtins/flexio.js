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
    name: "NXP FlexIO",
    short: "FlexIO",
    tag: "Configured peripheral",
    summary:
      "Selected timer events clock an active shifter; the host handles the custom ACK decision.",
    writable: "Shifter / timer / trigger registers + buffer",
    pin: "Configured timer and shifter output paths",
    limit: "Supported mode combinations and finite resources",
    stressTitle: "Keep the CPU busy during the frame",
    stressText:
      "At ticks 4–7 the host does no work. The configured timer and loaded shifter continue.",
    fixed:
      "Representative S32K144 resource budget: four 32-bit shifters, four timers and eight FlexIO pins. One TX shifter and one clock timer are used here.",
    source: [
      [
        "NXP AN12174 · §2 and §4.1.1",
        "https://www.nxp.com/docs/en/application-note/AN12174.pdf#page=3",
      ],
    ],
    notes:
      "This custom transfer uses logical LSB-first packing and disables automatic framing. Buffer aliases and raw TIMCMP bit fields are not emulated. Arbitrary ACK/timeout branching is explicitly host work.",
  },
  changes: (c) => [
    [
      "Payload",
      `Host packs ${hex(c.payload, Math.ceil(c.bits / 4))} into the software-visible buffer.`,
    ],
    [
      "Length",
      `Timer transfer length is configured for ${2 * c.bits} edges (${c.bits} bits).`,
    ],
    ["Period", `Timer rate / compare settings produce normalized H=${c.half}.`],
    [
      "ACK",
      "On completion, CPU reads ACK GPIO and checks a separate deadline.",
    ],
  ],
};
export const topology = {
  nodes: [
    {
      id: "host",
      label: "CPU firmware",
      x: 18,
      y: 15,
      w: 154,
      h: 66,
      kind: "external",
      note: "",
    },
    {
      id: "config",
      label: "Config registers",
      x: 243,
      y: 15,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
    {
      id: "buffer",
      label: "SHIFTBUF",
      x: 18,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "route",
      label: "Timer / pin selection",
      x: 243,
      y: 120,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
    {
      id: "timer",
      label: "Clock / length timer",
      x: 468,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "ack",
      label: "Host ACK handler",
      x: 18,
      y: 245,
      w: 154,
      h: 66,
      kind: "external",
      note: "",
    },
    {
      id: "shifter",
      label: "Active TX shifter",
      x: 243,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "pins",
      label: "DATA / CLK pins",
      x: 468,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
  ],
  edges: [
    ["host", "config"],
    ["host", "buffer"],
    ["config", "route"],
    ["route", "timer"],
    ["buffer", "shifter"],
    ["timer", "shifter"],
    ["timer", "pins"],
    ["shifter", "pins"],
    ["pins", "ack"],
    ["ack", "host"],
  ],
};
export function simulateFlexIO(c) {
  const out = [],
    s = base(c);
  s.shifter = c.payload;
  s.edgesLeft = 2 * c.bits;
  s.halfCount = 0;
  for (let t = 0; t <= frameEnd(c) + c.budget + c.ackDelay + 16; t++) {
    s.t = t;
    const busy = c.stress && t >= 4 && t < 8;
    s.software = busy
      ? "busy elsewhere"
      : s.phase === "send"
        ? "free for other work"
        : "ACK handler";
    if (finalized(s)) terminal(s, c);
    else if (t === 0) {
      s.line = 2;
      s.active = ["host", "config", "buffer", "timer", "shifter", "route"];
      s.event = "Host buffer write enables the configured transfer.";
      s.detail =
        "The first bit is preloaded; timer and shifter now generate the frame.";
    } else if (s.phase === "send") {
      s.halfCount++;
      s.line = 4;
      s.active = ["timer"];
      if (s.halfCount === c.half) {
        s.halfCount = 0;
        s.clock = 1 - s.clock;
        s.edgesLeft--;
        s.active = ["timer", "shifter", "route", "pins"];
        if (s.clock) {
          sample(s);
          s.event = "Timer raises CLK; the receiver samples DATA.";
          s.detail = "A configured hardware event produces this edge.";
        } else if (s.edgesLeft === 0) {
          endFrame(s, c);
          s.line = 5;
          s.active = ["timer", "host"];
          s.event = "Length compare disables the transfer.";
          s.detail = "The custom ACK decision is handed to the CPU.";
        } else {
          s.bitIndex++;
          s.shifter >>>= 1;
          s.data = s.shifter & 1;
          s.event = "Falling timer edge advances the TX shifter.";
          s.detail =
            "Timer selection and polarity connect the event to the shifter.";
        }
      } else {
        s.event = busy
          ? "CPU is busy; the autonomous timer continues."
          : "Timer counts toward its next configured edge.";
        s.detail = "No instruction stream is fetched inside this peripheral.";
      }
    } else {
      s.line = 6;
      s.active = ["host", "ack"];
      s.event = "CPU checks ACK GPIO and its deadline timer.";
      s.detail = "This arbitrary branch is implemented by host software.";
      if (resolveAck(s, c)) s.line = 7;
    }
    ackInput(s, c);
    s.values = {
      host: [s.software, "host firmware"],
      config: [`${c.bits} bits; H=${c.half}`, "mode / trigger fields"],
      buffer: [hex(c.payload, 8), "software-visible word"],
      timer: [`${s.edgesLeft} edges left`, `half count ${s.halfCount}`],
      route: ["timer 0 → shifter 0", "selected connections"],
      shifter: [hex(s.shifter, 8), "active 32-bit shift reg"],
      ack: [`ACK=${s.ack}`, "GPIO + host deadline"],
      pins: [`D=${s.data} C=${s.clock}`, "timer + shifter outputs"],
    };
    add(out, s);
  }
  return out;
}
export const simulate = simulateFlexIO;
