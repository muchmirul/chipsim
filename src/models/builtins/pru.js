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
    name: "TI PRU",
    short: "PRU",
    tag: "Coprocessor firmware",
    summary:
      "Register operations and branches execute firmware that writes every direct-GPIO edge.",
    writable: "Firmware + payload + pin multiplexing",
    pin: "R30 direct-output path",
    limit: "Instruction path length and blocking data transfers",
    stressTitle: "Pause firmware for four ticks",
    stressText:
      "At ticks 4–7, no R30 write executes. The current pin levels persist; later edges move.",
    fixed:
      "A complete scalar, in-order 32-bit processor is shown. AM335x PRU has no instruction pipeline. Direct R30 output mode is selected for this example.",
    source: [
      [
        "AM335x TRM · §4.4.1, §4.4.1.2, Table 4-21",
        "https://www.ti.com/lit/ug/spruh73q/spruh73q.pdf#page=208",
      ],
    ],
    notes:
      "A semantic step may include extraction, a register write and branch overhead. R31 reads input status; writing R31 serves a separate event interface. Optional PRU shift-output hardware is outside this direct-mode example.",
  },
  changes: (c) => [
    [
      "Payload",
      `Firmware loads ${hex(c.payload, Math.ceil(c.bits / 4))} and extracts (word >> i) & 1.`,
    ],
    ["Length", `The software loop condition becomes i < ${c.bits}.`],
    [
      "Period",
      `Change delay / scheduling instructions for H=${c.half}; each executed path consumes time.`,
    ],
    ["ACK", "Read R31.ACK and check the firmware deadline."],
  ],
};
export const topology = {
  nodes: [
    {
      id: "code",
      label: "Firmware memory",
      x: 18,
      y: 15,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
    {
      id: "pc",
      label: "PC / decode",
      x: 243,
      y: 15,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "regs",
      label: "Register file",
      x: 18,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "alu",
      label: "Operand mux / ALU",
      x: 243,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "r31",
      label: "R31 input view",
      x: 468,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "bus",
      label: "Data-transfer paths",
      x: 18,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "r30",
      label: "R30 output register",
      x: 243,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "pins",
      label: "Direct GPIO / mux",
      x: 468,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
  ],
  edges: [
    ["code", "pc"],
    ["pc", "alu"],
    ["regs", "alu"],
    ["alu", "regs"],
    ["alu", "r30"],
    ["r30", "pins"],
    ["pins", "r31"],
    ["r31", "alu"],
    ["bus", "regs"],
  ],
};
export function simulatePRU(c) {
  const out = [],
    s = base(c);
  s.progress = 0;
  s.r30 = s.data;
  for (let t = 0; t <= frameEnd(c) + c.budget + c.ackDelay + 16; t++) {
    s.t = t;
    const busy = c.stress && t >= 4 && t < 8;
    s.software = busy ? "paused" : "executing";
    if (finalized(s)) terminal(s, c);
    else if (t === 0) {
      s.line = 0;
      s.active = ["code", "pc", "regs", "alu", "r30", "pins"];
      s.event = "Firmware loads the word and writes the initial DATA bit.";
      s.detail =
        "R30 direct output is selected; the pin multiplexer was initialized.";
    } else if (s.phase === "send" && busy) {
      s.line = s.clock ? 4 : 3;
      s.active = ["bus"];
      s.event = "Firmware paused: no R30 write executes.";
      s.detail =
        "Existing output levels persist. This instruction delay stretches the pin waveform.";
    } else if (s.phase === "send") {
      s.progress++;
      const q = s.progress % (2 * c.half);
      if (s.progress === frameEnd(c)) {
        s.clock = 0;
        endFrame(s, c);
        s.line = 6;
        s.active = ["pc", "r30", "r31", "pins"];
        s.event = "Firmware clears CLK after the last bit.";
        s.detail = "The code enters ACK polling and deadline checks.";
      } else if (q === 0) {
        s.bitIndex++;
        s.data = bit(c, s.bitIndex);
        s.clock = 0;
        s.line = 2;
        s.active = ["pc", "regs", "alu", "r30", "pins"];
        s.event = "Shift/mask extracts the next bit; firmware writes R30.";
        s.detail = `i=${s.bitIndex}; (word >> i) & 1 = ${s.data}.`;
      } else if (q === c.half) {
        s.clock = 1;
        sample(s);
        s.line = 4;
        s.active = ["pc", "r30", "pins"];
        s.event = "Firmware sets the R30 CLK bit.";
        s.detail = `The receiver samples DATA=${s.data}. This edge requires the instruction to execute.`;
      } else {
        s.line = s.clock ? 4 : 3;
        s.active = ["pc", "regs"];
        s.event = "Firmware executes interval and loop work.";
        s.detail =
          "All branches and register operations must fit the chosen physical timing budget.";
      }
    } else {
      s.line = 6;
      s.active = ["pc", "alu", "r31"];
      s.event = "Firmware reads R31.ACK and checks its deadline.";
      s.detail = "R31 input is sampled by the executing program.";
      if (resolveAck(s, c)) s.line = 7;
    }
    s.r30 = s.data | (s.clock << 1);
    ackInput(s, c);
    s.values = {
      code: [`${c.bits}-bit firmware`, "arithmetic + branches"],
      pc: [`recipe line ${s.line + 1}`, s.software],
      regs: [`${hex(c.payload)}; i=${s.bitIndex}`, "payload + loop state"],
      alu: [
        s.phase === "send" ? `extract bit ${s.bitIndex}` : "compare deadline",
        "shift / mask / ALU",
      ],
      r30: [hex(s.r30, 8), "direct output register"],
      r31: [`ACK=${s.ack}`, "input status read"],
      bus: [busy ? "blocking interval" : "available", "transfer waits matter"],
      pins: [`D=${s.data} C=${s.clock} A=${s.ack}`, "device pin mux"],
    };
    add(out, s);
  }
  return out;
}
export const simulate = simulatePRU;
