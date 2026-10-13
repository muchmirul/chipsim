import { HDLRecording } from "./recording.js";
import { waveformVCD } from "../vcd.js";

export const projectionLoss =
  "Timestamp projection: process activations, source locations, RTL connectivity, scheduler phases, delta cycles and intermediate same-time values are omitted. Each timestamp holds its final recorded values; a partial run may end before settling.";

export function debugWaveform(data) {
  const events = [];
  for (const event of data.events) {
    let sample = events.at(-1);
    if (!sample || sample.time !== event.time) {
      sample = { time: event.time, changes: {} };
      events.push(sample);
    }
    Object.assign(sample.changes, event.changes);
  }
  return {
    format: "chipsim-waveform",
    version: 1,
    timescale: data.timescale,
    signals: data.design.objects
      .filter((s) => ["signal", "port"].includes(s.kind) && s.observed)
      .map((s, i) => ({
        id: s.id,
        width: s.width,
        type: s.variable ? "reg" : "wire",
        code: "v" + i,
      })),
    events,
    origin: { name: data.run.name, runId: data.run.id, projection: true },
    semantics: projectionLoss,
  };
}

export function debugModel(recording, id) {
  const debug =
    recording instanceof HDLRecording ? recording : new HDLRecording(recording);
  const data = debug.data;
  let projection;
  return {
    id,
    name: data.run.name,
    kind: "waveform",
    debugRecording: debug,
    get waveform() {
      return (projection ||= debugWaveform(data));
    },
    summary: "HDL source, elaborated RTL and signals at one recorded event",
    fidelity:
      "Read-only simulator observer; snapshots after the selected event",
    scope: `${debug.signals.length} observed signals · ${data.events.length} ordered events · ${data.status.complete ? "complete" : "partial"} capture`,
    assumptions: [
      "Horizontal positions are event sequence numbers; exact physical time and backend-provided phase/delta appear at the cursor.",
      "Process execution, signal changes and static connections have separate markers. A static driver is not proof of the writer of a particular event.",
      "Replay and stop conditions inspect a saved run. Change the testbench and explicitly run again to change its behavior.",
      ...data.diagnostics,
    ],
    sources: [],
    evidence: [],
    warnings: [],
    checks: [],
    parameters: [],
    registers: [],
    signals: debug.signals.map((s) => ({
      ...s,
      direction: "output",
      triState: true,
    })),
    topology: { nodes: [], edges: [] },
    recipe: () => [
      "Original HDL → instrumented simulator → immutable recording → shared event cursor",
    ],
    simulate: () => debug.trace,
  };
}

export function debugCSV(data) {
  const quote = (v) => '"' + String(v ?? "").replaceAll('"', '""') + '"';
  const rows = [
    [
      "run_id",
      "event_index",
      "time",
      "time_unit",
      "delta",
      "phase",
      "kind",
      "process",
      "writer",
      "changes",
      "source",
      "message",
    ],
  ];
  for (const event of data.events)
    rows.push([
      data.run.id,
      event.seq,
      event.time,
      data.timescale.magnitude + data.timescale.unit,
      event.delta,
      event.phase,
      event.kind,
      event.process,
      event.writer,
      JSON.stringify(event.changes || {}),
      event.source ? JSON.stringify(event.source) : "",
      event.message,
    ]);
  return rows.map((r) => r.map(quote).join(",")).join("\n") + "\n";
}

export function debugVCD(data) {
  if (!data.events.length)
    throw new Error("This recording contains no simulation events.");
  return (
    "$comment " + projectionLoss + " $end\n" + waveformVCD(debugWaveform(data))
  );
}
