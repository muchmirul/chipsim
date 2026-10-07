import { hex } from "./values.js";
const copy = (x) => JSON.parse(JSON.stringify(x));
function normalize(raw = {}) {
  let p = typeof raw.payload === "string" ? Number(raw.payload) : raw.payload;
  p = Number.isFinite(p) ? Math.floor(p) : 179;
  const bits = Number(raw.bits) === 12 ? 12 : 8,
    half = Math.max(1, Math.min(6, Math.round(Number(raw.half) || 2)));
  return {
    payload: Math.max(0, p) & (2 ** bits - 1),
    bits,
    half,
    ack: raw.ack === "missing" ? "missing" : "present",
    budget: Math.max(1, Math.min(32, Math.round(Number(raw.budget) || 8))),
    ackDelay: Math.max(0, Math.min(32, Math.round(Number(raw.ackDelay ?? 3)))),
    stress: !!raw.stress,
    inputEvents: raw.inputEvents || [],
  };
}
const bit = (c, i) => (c.payload >>> i) & 1;
const frameEnd = (c) => c.bits * 2 * c.half;
const edges = (c) =>
  Array.from({ length: 2 * c.bits }, (_, i) => ({
    at: (i + 1) * c.half,
    clock: i % 2 === 0 ? 1 : 0,
    data: bit(c, Math.min(c.bits - 1, Math.floor((i + 1) / 2))),
    index: i,
  }));
function base(c) {
  return {
    t: 0,
    data: bit(c, 0),
    clock: 0,
    ack: 0,
    phase: "send",
    actualEnd: null,
    deadline: null,
    samples: 0,
    decoded: 0,
    bitIndex: 0,
    line: 0,
    active: [],
    values: {},
    event: "",
    detail: "",
    fault: null,
    drift: 0,
    software: "ready",
  };
}
function sample(s) {
  s.decoded |= s.data << s.samples;
  s.samples++;
}
function endFrame(s, c) {
  s.actualEnd = s.t;
  s.deadline = s.t + c.budget;
  s.phase = "wait";
  s.drift = s.actualEnd - frameEnd(c);
}
function ackInput(s, c) {
  if (c.inputEvents?.length) {
    s.ack = 0;
    for (const event of c.inputEvents) {
      if (event.tick > s.t) break;
      if (event.signal === "ack") s.ack = event.value;
    }
  } else if (s.actualEnd !== null)
    s.ack = c.ack === "present" && s.t >= s.actualEnd + c.ackDelay ? 1 : 0;
}
function resolveAck(s, c) {
  ackInput(s, c);
  if (s.phase === "wait") {
    if (s.ack) {
      s.phase = "success";
      s.event = "ACK accepted; success remains latched.";
      return true;
    }
    if (s.t >= s.deadline) {
      s.phase = "timeout";
      s.event = "Deadline reached with ACK low; timeout remains latched.";
      return true;
    }
  }
  return false;
}
function add(out, s) {
  out.push(copy(s));
}
function finalized(s) {
  return ["success", "timeout", "fault"].includes(s.phase);
}
function terminal(s, c) {
  ackInput(s, c);
  s.active = [];
  s.event =
    s.phase === "fault"
      ? "Schedule stopped after the detected timing failure."
      : `Result remains ${s.phase}.`;
  s.detail = s.fault || "Later input changes do not restart this transfer.";
}
export {
  copy,
  bit,
  frameEnd,
  edges,
  normalize,
  base,
  sample,
  endFrame,
  ackInput,
  resolveAck,
  add,
  finalized,
  terminal,
};
