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
    name: "NXP eTPU",
    short: "eTPU",
    tag: "Service + match hardware",
    summary:
      "Armed match registers change pins at a target time. Shared service code refills the consumed slots.",
    writable: "Service routines + modes + match / event registers",
    pin: "Channel comparator, capture and pin-action logic",
    limit: "Two action units per channel; rearming latency",
    stressTitle: "Delay microengine service",
    stressText:
      "At ticks 4–9, no channel is serviced. Armed matches still fire; a consumed slot needs rearming.",
    fixed:
      "Separate CLK, DATA and ACK channels share the microengine and timebase. Each channel has two match/capture action units. The CLK channel can hold at most two imminent edges.",
    source: [
      [
        "NXP AN2933 · §2, §§5.1–5.3",
        "https://www.nxp.com/docs/en/user-guide/AN2933.pdf#page=3",
      ],
      [
        "NXP AN2353 · §§3–5",
        "https://www.nxp.com/docs/en/user-guide/AN2353.pdf",
      ],
    ],
    notes:
      "CLK rearming is modeled; separate DATA-channel setup and refill are assumed timely. The DATA actions shown at falling-edge boundaries stand for independently armed DATA-channel actions. Consumed CLK matches clear recognition enables and set latches. Service clears handled latches and rearms. ACK is captured at its arrival time and serviced two normalized ticks later; its timestamp, not service time, is tested against the deadline.",
  },
  changes: (c) => [
    [
      "Payload",
      `Service prepares DATA actions from ${hex(c.payload, Math.ceil(c.bits / 4))}.`,
    ],
    [
      "Length",
      `Service finishes after ${2 * c.bits} CLK actions; only two CLK targets are armed at once.`,
    ],
    [
      "Period",
      `Add 2H=${2 * c.half} when reusing a rising or falling match slot.`,
    ],
    [
      "ACK",
      "Enable capture for the ACK window, arm its deadline, and inspect captured time during service.",
    ],
  ],
};
export const topology = {
  nodes: [
    {
      id: "code",
      label: "Code / parameter RAM",
      x: 18,
      y: 15,
      w: 154,
      h: 66,
      kind: "config",
      note: "",
    },
    {
      id: "engine",
      label: "Shared microengine",
      x: 243,
      y: 15,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "time",
      label: "Shared TCR timebase",
      x: 468,
      y: 15,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "events",
      label: "Event latches / service",
      x: 18,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "clk",
      label: "CLK channel: A / B",
      x: 243,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "pins",
      label: "Channel pin logic",
      x: 468,
      y: 120,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "data",
      label: "DATA channel",
      x: 243,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
    {
      id: "ack",
      label: "ACK channel",
      x: 468,
      y: 245,
      w: 154,
      h: 66,
      kind: "fixed",
      note: "",
    },
  ],
  edges: [
    ["code", "engine"],
    ["events", "engine"],
    ["engine", "clk"],
    ["time", "clk"],
    ["clk", "pins"],
    ["clk", "events"],
    ["engine", "data"],
    ["data", "pins"],
    ["time", "ack"],
    ["pins", "ack"],
    ["ack", "events"],
  ],
};
export function simulateETPU(c) {
  const out = [],
    s = base(c),
    plan = edges(c);
  s.matches = [copy(plan[0]), copy(plan[1])];
  s.latches = [null, null];
  s.next = 2;
  s.capture = null;
  s.tdl = 0;
  s.deadlineLatch = 0;
  s.service = "setup";
  for (let t = 0; t <= frameEnd(c) + c.budget + c.ackDelay + 16; t++) {
    s.t = t;
    const busy = c.stress && t >= 4 && t < 10;
    if (finalized(s)) terminal(s, c);
    else if (t === 0) {
      s.line = 1;
      s.active = ["code", "engine", "clk", "data", "time"];
      s.event = "Service arms CLK match A and B and initializes DATA.";
      s.detail =
        "CLK holds two target edges; separate channel resources handle DATA and ACK.";
    } else if (s.phase === "send") {
      s.active = ["time", "clk"];
      s.line = 2;
      s.service = busy ? "delayed" : "idle";
      let fired = false;
      for (let slot = 0; slot < 2; slot++) {
        const e = s.matches[slot];
        if (e && e.at === t) {
          fired = true;
          s.data = e.data;
          s.clock = e.clock;
          if (s.clock) sample(s);
          s.matches[slot] = null;
          s.latches[slot] = { at: t, index: e.index };
          s.event = `CLK match ${slot ? "B" : "A"} fires at ${t}; recognition enable clears.`;
          s.detail =
            "Pin-action hardware applies the armed edge; MRL retains the event for service.";
          s.active = ["time", "clk", "pins", "events"];
          if (!e.clock) s.active.push("data");
          if (e.index === plan.length - 1) {
            endFrame(s, c);
            s.line = 5;
            s.active.push("ack");
            s.detail =
              "The ACK channel is enabled for this held-high-after-frame example.";
          }
        }
      }
      if (s.phase === "send") {
        const due = plan.find((e) => e.at === t);
        if (due && !fired) {
          s.phase = "fault";
          s.fault = `CLK target ${t} has no armed match: shared service did not refill a consumed slot. The trace stops.`;
          s.event = "Match rearming deadline missed.";
          s.detail = s.fault;
          s.active = ["events", "engine", "clk"];
          s.line = 4;
        } else if (!busy) {
          let slot = s.latches.findIndex((l) => l && l.at < t);
          if (slot >= 0) {
            const old = s.latches[slot];
            s.latches[slot] = null;
            s.service = `service ${slot ? "B" : "A"}`;
            if (s.next < plan.length) s.matches[slot] = copy(plan[s.next++]);
            s.line = 4;
            s.active.push("engine", "events", "clk", "data");
            if (!fired)
              s.event = `Microengine clears MRL ${slot ? "B" : "A"} and rearms its slot.`;
            s.detail += ` Handled target ${old.at}; next slot value ${s.matches[slot] ? s.matches[slot].at : "none"}.`;
          } else if (!fired) {
            s.event = "Channel comparators wait on shared timebase values.";
            s.detail =
              "No instruction is needed when a prearmed match produces its pin action.";
          }
        } else if (!fired) {
          s.event = "Shared microengine service is delayed.";
          s.detail =
            "Already armed targets remain usable; consumed match slots stay empty.";
        }
      }
    } else {
      ackInput(s, c);
      s.active = ["time", "ack"];
      s.line = 6;
      s.service = "idle";
      const finalSlot = s.latches.findIndex((l) => l && l.at < t);
      if (finalSlot >= 0) {
        s.latches[finalSlot] = null;
        s.service = "final CLK service";
        s.line = 5;
        s.active = ["engine", "events", "clk", "ack"];
        s.event = "Service clears the final CLK match latch.";
        s.detail =
          "CLK transfer bookkeeping is complete; ACK capture and its deadline remain armed.";
      } else if (s.ack && s.capture === null) {
        s.capture = t;
        s.tdl = 1;
        s.event = `ACK transition captured at ${t}; TDL is set.`;
        s.detail =
          "The timestamp preserves arrival time until the shared engine services it.";
      } else if (s.capture !== null && t >= s.capture + 2) {
        s.phase = s.capture <= s.deadline ? "success" : "timeout";
        s.tdl = 0;
        s.line = 7;
        s.active = ["events", "engine", "ack"];
        s.service = "ACK service";
        s.event = `Service reads capture=${s.capture}; result is ${s.phase}.`;
        s.detail = `Decision uses captured time, not current service time ${t}.`;
      } else if (t >= s.deadline) {
        if (!s.deadlineLatch) {
          s.deadlineLatch = t;
          s.event = `Deadline match recognized at ${t}.`;
          s.detail = "The match event is latched for service.";
        } else if (t >= s.deadlineLatch + 2) {
          s.phase = "timeout";
          s.line = 7;
          s.active = ["events", "engine", "ack"];
          s.event = "Service sees the deadline event with no timely ACK.";
          s.detail = "Timeout remains latched.";
        } else {
          s.event = "Deadline event is waiting for shared service.";
          s.detail = "Recognition time and software result time are distinct.";
        }
      } else if (s.tdl) {
        s.event = "ACK timestamp is latched; service is pending.";
        s.detail = "Input transition evidence survives the service delay.";
      } else {
        s.event = "ACK channel waits for transition or deadline match.";
        s.detail = "Capture detection was enabled at the frame boundary.";
      }
    }
    ackInput(s, c);
    if (s.phase === "wait" && s.ack && s.capture === null) {
      s.capture = t;
      s.tdl = 1;
      s.detail +=
        " ACK capture hardware latches the arrival independently of CLK bookkeeping service.";
    }
    s.values = {
      code: [`${c.bits}-bit service routine`, "code + parameters"],
      engine: [s.service, "shared microengine"],
      time: [`TCR=${t}`, "normalized timebase"],
      events: [
        `MRL=${s.latches.map(Boolean).map(Number).join("")}; TDL=${s.tdl}`,
        "latched service requests",
      ],
      clk: [
        s.matches.map((e, i) => `${i ? "B" : "A"}:${e ? e.at : "—"}`).join(" "),
        "two CLK match units",
      ],
      data: [`DATA=${s.data}`, "separate DATA channel"],
      ack: [
        s.capture !== null
          ? `capture=${s.capture}`
          : s.deadline !== null
            ? `deadline=${s.deadline}`
            : "window not started",
        "separate ACK channel",
      ],
      pins: [`D=${s.data} C=${s.clock} A=${s.ack}`, "channel pin actions"],
    };
    add(out, s);
  }
  return out;
}
export const simulate = simulateETPU;
