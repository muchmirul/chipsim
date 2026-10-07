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
    name: "XMOS xCORE",
    short: "xCORE",
    tag: "Task + timed resources",
    summary:
      "A task issues a timed port operation; port hardware applies it when its condition is met.",
    writable: "Task code + resource setup + target times",
    pin: "Port hardware and its clock / transfer condition",
    limit: "Shared task service and timely transfer submission",
    stressTitle: "Delay the task after an armed write",
    stressText:
      "At ticks 4–9, the task cannot submit another write. One already pending write can still complete.",
    fixed:
      "Hardware-thread contexts share the execution unit and scheduler. This example uses one pending unbuffered timed write and a port with DATA/CLK bits.",
    source: [
      [
        "XMOS XS3 Architecture · Resources, ports and timers",
        "https://www.xmos.com/file/the-xmos-xs3-architecture?version=latest",
      ],
      [
        "AN03001 · §§1, 3 and 5",
        "https://www.xmos.com/documentation/XM-015254-AN/html/doc/rst/an03001.html",
      ],
    ],
    notes:
      "The displayed CLK is a programmed output bit. The underlying port clock is a different resource. Port-target and timer-deadline domains are normalized here; a real program must convert units and handle counter wrap.",
  },
  changes: (c) => [
    [
      "Payload",
      `Task packs DATA/CLK values from ${hex(c.payload, Math.ceil(c.bits / 4))}.`,
    ],
    [
      "Length",
      `Generate ${2 * c.bits} timed edge writes; at most one is pending in this example.`,
    ],
    [
      "Period",
      `Successive targets differ by H=${c.half} normalized port-time units.`,
    ],
    [
      "ACK",
      "After output completion, select between an ACK input and a timer deadline.",
    ],
  ],
};
export const topology = {
  nodes: [
    {
      id: "thread",
      label: "Task / thread context",
      x: 18,
      y: 15,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
    {
      id: "sched",
      label: "Hardware scheduler",
      x: 243,
      y: 15,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "clock",
      label: "Port clock block",
      x: 18,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "exec",
      label: "Shared execution unit",
      x: 243,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "timer",
      label: "Timer resource",
      x: 468,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "input",
      label: "ACK input resource",
      x: 18,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "port",
      label: "Timed output port",
      x: 243,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "pins",
      label: "Package pins",
      x: 468,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
  ],
  edges: [
    ["thread", "sched"],
    ["sched", "exec"],
    ["exec", "port"],
    ["clock", "port"],
    ["port", "pins"],
    ["port", "sched"],
    ["timer", "sched"],
    ["input", "sched"],
    ["pins", "input"],
  ],
};
export function simulateXMOS(c) {
  const out = [],
    s = base(c),
    plan = edges(c);
  s.pending = copy(plan[0]);
  s.next = 1;
  s.thread = "blocked on output";
  for (let t = 0; t <= frameEnd(c) + c.budget + c.ackDelay + 16; t++) {
    s.t = t;
    const busy = c.stress && t >= 4 && t < 10;
    if (finalized(s)) terminal(s, c);
    else if (t === 0) {
      s.line = 2;
      s.active = ["thread", "exec", "port", "clock"];
      s.event = `Task submits one timed write for t=${s.pending.at}.`;
      s.detail =
        "The port holds one pending value. The task can block until completion.";
    } else if (s.phase === "send") {
      s.line = 3;
      s.active = ["clock", "port"];
      s.thread = busy ? "not scheduled" : "blocked on output";
      if (s.pending && s.pending.at === t) {
        const e = s.pending;
        s.data = e.data;
        s.clock = e.clock;
        if (s.clock) sample(s);
        s.pending = null;
        s.line = 4;
        s.active = ["clock", "port", "pins", "sched"];
        s.event = `Port condition meets target ${t}; hardware applies the packed value.`;
        s.detail =
          "Completion makes the task runnable; the port produced the pin event.";
        if (e.index === plan.length - 1) {
          endFrame(s, c);
          s.thread = "waiting in select";
          s.line = 6;
        } else if (!busy) {
          s.pending = copy(plan[s.next++]);
          s.line = 5;
          s.thread = "submits then blocks";
          s.active.push("thread", "exec");
          s.detail += ` Task submits the next target ${s.pending.at}; still only one is pending.`;
        }
      } else if (!s.pending) {
        const e = plan[s.next];
        if (e && e.at <= t) {
          s.phase = "fault";
          s.fault = `No timed write was submitted before required target ${e.at}. The trace stops; held pin state is shown.`;
          s.event = "Timed submission deadline missed.";
          s.detail = s.fault;
          s.line = 2;
          s.active = ["thread", "sched", "port"];
        } else if (!busy && e) {
          s.pending = copy(e);
          s.next++;
          s.thread = "submits then blocks";
          s.line = 2;
          s.active = ["thread", "exec", "port"];
          s.event = `Task submits pending target ${e.at}.`;
          s.detail = "A finite resource accepts one timed operation.";
        } else {
          s.event = "Task is unavailable; no next write is pending.";
          s.detail =
            "Port hardware can only execute an operation already submitted.";
        }
      } else {
        s.event = busy
          ? "Task unavailable; the already armed port write remains valid."
          : "Port waits for its timed transfer condition.";
        s.detail = `Only target ${s.pending.at} is held in port hardware.`;
      }
    } else {
      s.thread = "waiting in select";
      s.line = 6;
      s.active = ["thread", "timer", "input"];
      s.event = "Task selects ACK readiness or a timer deadline.";
      s.detail =
        "A blocked thread retains state; runnable work shares the tile execution unit.";
      if (resolveAck(s, c)) {
        s.thread = "event selected";
        s.line = 7;
        s.active = ["sched", "thread", "exec"];
      }
    }
    ackInput(s, c);
    s.values = {
      thread: [s.thread, `next software edge ${s.next}/${plan.length}`],
      sched: [
        busy ? "task delayed" : "resource-aware ready set",
        "shared execution",
      ],
      exec: [
        s.phase === "send" ? "pack / issue / block" : "event selection",
        "shared tile processor",
      ],
      clock: ["underlying port clock", `target spacing H=${c.half}`],
      port: [
        s.pending
          ? `target=${s.pending.at}; D${s.pending.data}C${s.pending.clock}`
          : "no pending write",
        "capacity used: " + (s.pending ? "1 / 1" : "0 / 1"),
      ],
      timer: [
        s.deadline === null ? "not yet armed" : `deadline=${s.deadline}`,
        "separate timer domain",
      ],
      input: [`ACK=${s.ack}`, "input condition"],
      pins: [`D=${s.data} C=${s.clock}`, "CLK is a port data bit"],
    };
    add(out, s);
  }
  return out;
}
export const simulate = simulateXMOS;
