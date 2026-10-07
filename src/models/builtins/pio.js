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
    name: "RP2040 PIO",
    short: "PIO",
    tag: "I/O instruction engine",
    summary:
      "A short program controls shift registers, counters and mapped pin outputs.",
    writable: "Instructions + shift / pin / divider settings",
    pin: "State-machine OUT, SET and side-set logic",
    limit: "32 shared instruction words per block; local state; FIFO stalls",
    stressTitle: "Delay the first TX FIFO word",
    stressText:
      "The host supplies the word at tick 4. PULL holds PC and pins until data arrives.",
    fixed:
      "One of four state machines in a PIO block is shown. Each has local PC, X/Y, OSR/ISR and four-word TX/RX FIFOs; 32 instruction words are shared.",
    source: [
      [
        "RP2040 Datasheet · §§3.1–3.2, 3.4–3.5",
        "https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf#page=312",
      ],
    ],
    notes:
      "PULL, OUT, branching and side-set are summarized into semantic actions. The bounded ACK poll is an instruction loop; WAIT alone has no timeout.",
  },
  changes: (c) => [
    [
      "Payload",
      `Host writes ${hex(c.payload, Math.ceil(c.bits / 4))} to TX FIFO; OSR shifts right.`,
    ],
    ["Length", `Load X=${c.bits - 1}; finish after ${c.bits} output bits.`],
    [
      "Period",
      `Choose instruction delays / divider for H=${c.half}. Exact instruction costs require implementation.`,
    ],
    ["ACK", "Pin-test branch + bounded Y counter; budget 8 normalized ticks."],
  ],
};
export const topology = {
  nodes: [
    {
      id: "host",
      label: "Host / DMA",
      x: 18,
      y: 15,
      w: 154,
      h: 66,
      kind: "external",
      note: "",
    },
    {
      id: "imem",
      label: "Instruction memory",
      x: 243,
      y: 15,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
    {
      id: "fifo",
      label: "TX FIFO",
      x: 18,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "pc",
      label: "PC + control logic",
      x: 243,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "xy",
      label: "Scratch X / Y",
      x: 468,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "divider",
      label: "Clock divider",
      x: 18,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "osr",
      label: "OSR / shift logic",
      x: 243,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "pins",
      label: "Pin mapping / GPIO",
      x: 468,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
  ],
  edges: [
    ["host", "imem"],
    ["host", "fifo"],
    ["imem", "pc"],
    ["fifo", "osr"],
    ["xy", "pc"],
    ["divider", "pc"],
    ["pc", "osr"],
    ["osr", "pins"],
    ["pc", "pins"],
  ],
};
export function simulatePIO(c) {
  const out = [],
    s = base(c);
  s.osr = c.stress ? 0 : c.payload >>> 1;
  s.x = c.stress ? 0 : c.bits - 1;
  s.y = 8;
  s.delay = 0;
  s.tx = c.stress ? 0 : 1;
  s.start = c.stress ? 4 : 0;
  if (c.stress) {
    s.phase = "load";
    s.data = 0;
  }
  for (let t = 0; t <= frameEnd(c) + c.budget + c.ackDelay + 16; t++) {
    s.t = t;
    s.active = [];
    if (finalized(s)) terminal(s, c);
    else if (t < s.start) {
      s.phase = "load";
      s.line = 1;
      s.active = ["fifo", "pc"];
      s.event = "PULL stalls: TX FIFO is empty.";
      s.detail =
        "PC does not advance. CLK stays low until the host writes a word.";
    } else if (t === s.start) {
      s.phase = "send";
      s.data = bit(c, 0);
      s.osr = c.payload >>> 1;
      s.x = c.bits - 1;
      s.tx = 0;
      s.line = 2;
      s.active = ["host", "fifo", "pc", "osr", "pins"];
      s.event = "PULL loads OSR; OUT presents bit 0.";
      s.detail = `OSR becomes ${hex(s.osr, 8)} after shifting right; X=${s.x}.`;
    } else if (s.phase === "send") {
      const p = t - s.start,
        within = p % (2 * c.half);
      s.delay = (c.half - (p % c.half)) % c.half;
      s.active = ["divider", "pc"];
      if (p === frameEnd(c)) {
        s.clock = 0;
        endFrame(s, c);
        s.line = 5;
        s.active = ["pc", "xy", "pins"];
        s.event = "Final CLK falling edge; enter bounded ACK poll.";
        s.detail = "Y represents the remaining modeled polling budget.";
      } else if (within === c.half) {
        s.clock = 1;
        sample(s);
        s.line = 3;
        s.active = ["divider", "pc", "pins"];
        s.event = "SET / side-set raises CLK.";
        s.detail = `The receiver samples DATA=${s.data}; ${s.samples}/${c.bits} bits sampled.`;
      } else if (within === 0) {
        s.bitIndex++;
        s.x = c.bits - 1 - s.bitIndex;
        s.data = s.osr & 1;
        s.osr >>>= 1;
        s.clock = 0;
        s.line = 2;
        s.active = ["pc", "xy", "osr", "pins"];
        s.event = "Loop branch, OUT and low CLK phase.";
        s.detail = "OSR supplies the next bit; X retains progress.";
      } else {
        s.line = s.clock ? 3 : 2;
        s.event = "Instruction-controlled hold interval.";
        s.detail =
          "Divider enables and encoded delays determine actual state-machine timing.";
      }
    } else {
      s.line = 6;
      s.active = ["pc", "xy", "pins"];
      s.y = Math.max(0, s.deadline - t);
      s.event = "Test ACK and update the bounded counter.";
      s.detail = `${s.y} normalized ticks remain; WAIT alone would have no timeout.`;
      if (resolveAck(s, c)) {
        s.line = 7;
        s.active = ["pc", "xy"];
      }
    }
    ackInput(s, c);
    s.values = {
      host: ["host / DMA", t < s.start ? "word withheld" : "word supplied"],
      fifo: [
        `${s.tx}/4 TX words`,
        t < s.start ? "empty → stall" : "PULL consumed word",
      ],
      imem: ["short program", "32 shared words / block"],
      pc: [`recipe line ${s.line + 1}`, s.phase],
      xy: [`X=${s.x}; Y=${s.y}`, "local scratch state"],
      osr: [hex(s.osr, 8), "32-bit right shifter"],
      divider: [`H=${c.half} (abstract)`, "enable + delay"],
      pins: [`D=${s.data} C=${s.clock} A=${s.ack}`, "mapped GPIO"],
    };
    add(out, s);
  }
  return out;
}
export const simulate = simulatePIO;
