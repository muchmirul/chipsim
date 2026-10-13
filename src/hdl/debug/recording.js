import { createHash } from "node:crypto";
import { timeScale, timeLabel } from "../time.js";

export const debugLimits = Object.freeze({
  events: 100000,
  signals: 512,
  width: 4096,
  eventBytes: 64 * 1048576,
  sourceBytes: 16 * 1048576,
  fileBytes: 96 * 1048576,
  objects: 16384,
  connections: 65536,
  checkpointInterval: 256,
});
const kinds = new Set([
  "instance",
  "process",
  "signal",
  "port",
  "operation",
  "net",
]);
const eventKinds = new Set([
  "initialize",
  "process",
  "signal",
  "boundary",
  "assertion",
  "finish",
  "diagnostic",
]);
const connectionKinds = new Set([
  "reads",
  "writes",
  "alias",
  "sensitivity",
  "posedge",
  "negedge",
  "contains",
  "port",
  "shares-bits",
]);
const formats = new Set(["hex", "binary", "decimal", "octal"]);
const panes = new Set(["source", "hardware", "signals"]);
const own = (obj, key) => Object.hasOwn(obj, key);
const fail = (message) => {
  throw new Error("HDL debug: " + message);
};
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v, max = 2048) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\x00-\x1f]/.test(v);
const integer = (v, min, max) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const exactTime = (v) =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,39})$/.test(v);
export const sourceDigest = (text) =>
  createHash("sha256").update(text).digest("hex");

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Imported recordings are data. This validator never reads a source path or
 *  invokes a compiler, and rejects dangling references before any TUI mutation. */
export function validateDebugRecording(data) {
  if (data?.format !== "chipsim-hdl-debug" || data.version !== 1)
    fail("expected version-1 chipsim-hdl-debug recording.");
  // Bound extension metadata too, before recursively cloning/freezing imported
  // data. This also rejects cycles in programmatically supplied recordings.
  const pending = [[data, 0]],
    seen = new Set();
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (depth > 32) fail("excessively nested recording.");
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value))
      if (child && typeof child === "object") pending.push([child, depth + 1]);
  }
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    fail("recording is not JSON data.");
  }
  if (Buffer.byteLength(serialized) > debugLimits.fileBytes)
    fail("recording exceeds 96 MiB.");
  if (
    !plain(data.run) ||
    !text(data.run.id, 128) ||
    !text(data.run.name) ||
    !["verilog", "vhdl"].includes(data.run.language)
  )
    fail("invalid run identity.");
  if (!plain(data.timescale)) fail("missing exact timescale.");
  timeScale(data.timescale.magnitude + data.timescale.unit);
  if (!Array.isArray(data.sources) || data.sources.length > 256)
    fail("invalid source snapshots.");
  let sourceBytes = 0;
  const sources = new Map();
  const lineCounts = new Map();
  for (const source of data.sources) {
    if (
      !text(source.id) ||
      sources.has(source.id) ||
      !text(source.path) ||
      typeof source.text !== "string" ||
      source.text.length > 4 * 1048576 ||
      source.sha256 !== sourceDigest(source.text)
    )
      fail("invalid source snapshot or fingerprint.");
    sourceBytes += Buffer.byteLength(source.text);
    sources.set(source.id, source);
    lineCounts.set(source.id, source.text.split("\n").length);
  }
  if (sourceBytes > debugLimits.sourceBytes)
    fail("source snapshots exceed 16 MiB.");
  const location = (loc) => {
    if (loc == null) return;
    if (
      !plain(loc) ||
      !sources.has(loc.file) ||
      !integer(loc.line, 1, lineCounts.get(loc.file)) ||
      (loc.column !== undefined && !integer(loc.column, 1, 1048576))
    )
      fail("invalid source location or missing snapshot.");
  };
  if (
    !plain(data.design) ||
    !Array.isArray(data.design.objects) ||
    data.design.objects.length > debugLimits.objects ||
    !Array.isArray(data.design.connections) ||
    data.design.connections.length > debugLimits.connections
  )
    fail("invalid or oversized elaborated design.");
  const objects = new Map();
  let observed = 0;
  for (const object of data.design.objects) {
    if (
      !plain(object) ||
      !text(object.id) ||
      objects.has(object.id) ||
      !kinds.has(object.kind) ||
      !text(object.label)
    )
      fail("invalid or duplicate design object.");
    if (object.kind === "signal" || object.kind === "port") {
      if (
        !integer(object.width, 1, debugLimits.width) ||
        typeof object.observed !== "boolean"
      )
        fail("invalid signal width or observation flag.");
      if (object.observed) observed++;
      if (object.signed !== undefined && typeof object.signed !== "boolean")
        fail("invalid signed signal declaration.");
    }
    if (object.path !== undefined && !text(object.path))
      fail("invalid object path.");
    location(object.source);
    objects.set(object.id, object);
  }
  if (observed > debugLimits.signals) fail("more than 512 observed signals.");
  for (const obj of objects.values()) {
    if (obj.parent != null && !objects.has(obj.parent))
      fail("missing parent object.");
    const seen = new Set([obj.id]);
    let parent = obj.parent;
    while (parent != null) {
      if (seen.has(parent)) fail("cyclic design hierarchy.");
      seen.add(parent);
      parent = objects.get(parent)?.parent;
    }
  }
  const connectionIds = new Set();
  for (const edge of data.design.connections) {
    if (
      !text(edge.id) ||
      connectionIds.has(edge.id) ||
      !objects.has(edge.from) ||
      !objects.has(edge.to) ||
      !connectionKinds.has(edge.kind)
    )
      fail("invalid connection or missing endpoint.");
    connectionIds.add(edge.id);
  }
  if (!Array.isArray(data.events) || data.events.length > debugLimits.events)
    fail("invalid event array or event limit exceeded.");
  let previous = 0n,
    eventBytes = 0;
  for (const [i, event] of data.events.entries()) {
    if (
      !plain(event) ||
      event.seq !== i ||
      !eventKinds.has(event.kind) ||
      !exactTime(event.time) ||
      BigInt(event.time) < previous
    )
      fail("invalid event sequence, kind or timestamp at event " + i);
    previous = BigInt(event.time);
    if (
      event.delta !== undefined &&
      !integer(event.delta, 0, Number.MAX_SAFE_INTEGER)
    )
      fail("invalid delta cycle.");
    if (event.phase !== undefined && !text(event.phase, 128))
      fail("invalid scheduler phase.");
    if (
      event.kind === "process" &&
      objects.get(event.process)?.kind !== "process"
    )
      fail("process event lacks an elaborated process.");
    if (event.process != null && objects.get(event.process)?.kind !== "process")
      fail("missing event process.");
    if (event.writer != null && objects.get(event.writer)?.kind !== "process")
      fail("missing observed writer.");
    if (event.changes !== undefined) {
      if (!plain(event.changes)) fail("invalid signal changes.");
      for (const [id, bits] of Object.entries(event.changes)) {
        const sig = objects.get(id);
        if (
          !sig?.observed ||
          !["signal", "port"].includes(sig.kind) ||
          typeof bits !== "string" ||
          bits.length !== sig.width ||
          !/^[01XZUWLH-]+$/.test(bits)
        )
          fail("invalid or unmapped signal value at event " + i);
      }
    }
    location(event.source);
    eventBytes += Buffer.byteLength(JSON.stringify(event));
  }
  if (eventBytes > debugLimits.eventBytes) fail("event data exceeds 64 MiB.");
  if (
    !plain(data.status) ||
    typeof data.status.complete !== "boolean" ||
    !text(data.status.reason)
  )
    fail("missing capture completeness.");
  if (
    data.status.limits !== undefined &&
    (!Array.isArray(data.status.limits) ||
      data.status.limits.length > 4096 ||
      data.status.limits.some((s) => !text(s)) ||
      (data.status.complete && data.status.limits.length))
  )
    fail("invalid capture limit status.");
  if (
    !plain(data.capabilities) ||
    !Array.isArray(data.diagnostics) ||
    data.diagnostics.length > 4096 ||
    data.diagnostics.some((s) => typeof s !== "string" || s.length > 65536)
  )
    fail("invalid capabilities or diagnostics.");
  for (const name of [
    "processActivations",
    "signalUpdates",
    "schedulerPhases",
    "deltaCycles",
    "sourceStatements",
    "observedWriters",
    "liveControl",
  ])
    if (
      data.capabilities[name] !== undefined &&
      typeof data.capabilities[name] !== "boolean"
    )
      fail("invalid capability flag.");
  return data;
}

/** One cursor, immutable after-event snapshots; bounded sparse checkpoints.
 * There is deliberately no dense events × signals table. */
export class HDLRecording {
  constructor(data) {
    validateDebugRecording(data);
    this.data = freeze(structuredClone(data));
    this.objects = new Map(
      this.data.design.objects.map((obj) => [obj.id, obj]),
    );
    this.sources = new Map(this.data.sources.map((s) => [s.id, s]));
    this.signals = this.data.design.objects.filter(
      (s) => ["signal", "port"].includes(s.kind) && s.observed,
    );
    this.checkpoints = new Map([[-1, Object.freeze({})]]);
    this.cache = new Map();
    let values = Object.create(null);
    this.data.events.forEach((event, i) => {
      for (const [id, value] of Object.entries(event.changes || {}))
        Object.defineProperty(values, id, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      if (i % debugLimits.checkpointInterval === 0)
        this.checkpoints.set(i, Object.freeze({ ...values }));
    });
    // The existing waveform renderer accepts an array-like trace. A lazy array
    // retains that interface without allocating 51 million signal cells.
    const length = this.data.events.length;
    this.trace = new Proxy(new Array(length), {
      get: (target, key, receiver) =>
        typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)
          ? Number(key) < length
            ? this.snapshot(Number(key))
            : undefined
          : Reflect.get(target, key, receiver),
      has: (target, key) =>
        typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)
          ? Number(key) < length
          : Reflect.has(target, key),
      set: () => {
        throw new Error("HDL recordings are read-only.");
      },
    });
  }
  valuesAt(index) {
    if (index < 0) return Object.create(null);
    const base =
      Math.floor(index / debugLimits.checkpointInterval) *
      debugLimits.checkpointInterval;
    const values = Object.assign(
      Object.create(null),
      this.checkpoints.get(base),
    );
    for (let i = base + 1; i <= index; i++)
      for (const [id, value] of Object.entries(
        this.data.events[i].changes || {},
      ))
        Object.defineProperty(values, id, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    return values;
  }
  snapshot(index) {
    if (!integer(index, 0, this.data.events.length - 1))
      throw new Error("Event cursor is outside this recording.");
    if (this.cache.has(index)) return this.cache.get(index);
    const event = this.data.events[index],
      signals = this.valuesAt(index),
      before = this.valuesAt(index - 1);
    const changes = Object.entries(event.changes || {})
      .filter(([id, after]) => before[id] !== after)
      .map(([id, after]) => ({
        kind: "signals",
        id,
        before: before[id],
        after,
      }));
    const active = event.kind === "process" ? [event.process] : [];
    const snapshot = freeze({
      runId: this.data.run.id,
      eventIndex: index,
      event,
      tick: index,
      time: event.time,
      state: "HDL",
      phase: event.phase || "unreported",
      delta: event.delta,
      signals,
      registers: {},
      values: {},
      evidence: [],
      changes,
      active,
      executed: active,
      changed: changes.map((c) => c.id),
      message:
        `${event.kind} · ${timeLabel(event.time, this.data.timescale)}` +
        (event.process ? " · " + this.objects.get(event.process).label : ""),
    });
    this.cache.set(index, snapshot);
    if (this.cache.size > 128)
      this.cache.delete(this.cache.keys().next().value);
    return snapshot;
  }
  related(id) {
    const edges = this.data.design.connections.filter(
      (e) => e.from === id || e.to === id,
    );
    const ids = new Set([id, ...edges.flatMap((e) => [e.from, e.to])]);
    const obj = this.objects.get(id);
    for (const item of this.objects.values())
      if (item.parent === id) ids.add(item.id);
    if (obj?.parent) ids.add(obj.parent);
    return {
      objects: [...ids].map((key) => this.objects.get(key)).filter(Boolean),
      connections: edges,
    };
  }
  nextMatch(index, stop) {
    validateReplayStop(stop, this);
    for (let i = index + 1; i < this.data.events.length; i++)
      if (this.matches(i, stop)) return i;
    return null;
  }
  matches(index, stop) {
    const event = this.data.events[index];
    if (stop.kind === "assertion") return event.kind === "assertion";
    if (stop.kind === "process")
      return event.kind === "process" && event.process === stop.object;
    if (!own(event.changes || {}, stop.object)) return false;
    const after = event.changes[stop.object],
      before = this.valuesAt(index - 1)[stop.object];
    if (before === after) return false;
    if (stop.kind === "change") return true;
    if (stop.kind === "value") return after === stop.value;
    // Four-/nine-state X transitions do not silently count as binary edges.
    return stop.kind === "rising"
      ? before === "0" && after === "1"
      : before === "1" && after === "0";
  }
}

export function validateReplayStop(stop, recording) {
  if (
    !plain(stop) ||
    !["process", "change", "value", "rising", "falling", "assertion"].includes(
      stop.kind,
    )
  )
    fail("invalid replay stop.");
  if (stop.kind === "assertion") return stop;
  const obj = recording.objects.get(stop.object);
  if (stop.kind === "process") {
    if (obj?.kind !== "process") fail("replay stop requires a process.");
  } else {
    if (!obj?.observed || !["signal", "port"].includes(obj.kind))
      fail("replay stop requires an observed signal.");
    if (["rising", "falling"].includes(stop.kind) && obj.width !== 1)
      fail("edge stop requires a one-bit signal.");
    if (
      stop.kind === "value" &&
      (typeof stop.value !== "string" ||
        stop.value.length !== obj.width ||
        !/^[01XZUWLH-]+$/.test(stop.value))
    )
      fail("stop value must preserve the signal's full bit width.");
  }
  return stop;
}

export function validateDebugSession(session) {
  if (session?.format !== "chipsim-hdl-debug-session" || session.version !== 1)
    fail("unsupported debug session.");
  const recording = new HDLRecording(session.recording),
    ui = session.ui;
  if (
    !plain(ui) ||
    !integer(ui.eventIndex, 0, Math.max(0, recording.data.events.length - 1)) ||
    !panes.has(ui.focus) ||
    typeof ui.maximized !== "boolean" ||
    !formats.has(ui.format) ||
    !Array.isArray(ui.signals) ||
    ui.signals.length > debugLimits.signals ||
    new Set(ui.signals).size !== ui.signals.length ||
    ui.signals.some((id) => !recording.objects.get(id)?.observed)
  )
    fail("invalid debug session cursor or display.");
  if (ui.scope != null && recording.objects.get(ui.scope)?.kind !== "instance")
    fail("invalid debug scope.");
  if (ui.selection != null && !recording.objects.has(ui.selection))
    fail("invalid linked selection.");
  if (ui.follow !== undefined && typeof ui.follow !== "boolean")
    fail("invalid source follow mode.");
  if (ui.sourceFile != null && !recording.sources.has(ui.sourceFile))
    fail("missing browsed source snapshot.");
  if (
    ui.sourceLine !== undefined &&
    !integer(
      ui.sourceLine,
      1,
      recording.sources.get(ui.sourceFile)?.text.split("\n").length || 1,
    )
  )
    fail("invalid browsed source line.");
  if (
    ui.selectedSignal != null &&
    !recording.objects.get(ui.selectedSignal)?.observed
  )
    fail("invalid selected signal.");
  if (
    ui.zoom !== undefined &&
    (typeof ui.zoom !== "number" ||
      !Number.isFinite(ui.zoom) ||
      ui.zoom <= 0 ||
      ui.zoom > 64)
  )
    fail("invalid zoom.");
  if (
    ui.offset !== undefined &&
    !integer(ui.offset, 0, Math.max(0, recording.data.events.length - 1))
  )
    fail("invalid offset.");
  if (!Array.isArray(ui.stops) || ui.stops.length > 32)
    fail("invalid replay stops.");
  for (const stop of ui.stops) validateReplayStop(stop, recording);
  return { recording, ui: structuredClone(ui) };
}
