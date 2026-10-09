import { validateWaveform } from "./vcd.js";
import { timeLabel } from "./time.js";

export function waveformModel(wave, id = "hdl-waveform") {
  validateWaveform(wave);
  let values = Object.fromEntries(wave.signals.map((s) => [s.id, undefined]));
  const trace = wave.events.map((event, tick) => {
    const changes = Object.entries(event.changes)
      .filter(([id, value]) => values[id] !== value)
      .map(([id, after]) => ({
        kind: "signals",
        id,
        before: values[id],
        after,
      }));
    values = { ...values, ...event.changes };
    return {
      tick,
      time: event.time,
      state: "HDL",
      phase: "replay",
      signals: values,
      registers: {},
      changes,
      active: [],
      values: {},
      evidence: [],
      message: "Simulator time " + timeLabel(event.time, wave.timescale),
    };
  });
  return {
    id,
    name: wave.origin?.name || "HDL waveform",
    kind: "waveform",
    waveform: wave,
    summary: "Recorded digital signals",
    fidelity: "External simulator waveform; final dumped values per timestamp",
    scope: `${wave.signals.length} signals · ${wave.events.length} timestamp samples · ${wave.timescale.magnitude}${wave.timescale.unit} time units`,
    assumptions: [
      wave.semantics || "Recorded values only.",
      "Horizontal positions are timestamp sample indices, not uniformly spaced physical time. Inspect exact simulator time at the cursor.",
      "Replay is read-only; change inputs in the HDL testbench and run again.",
    ],
    sources: [],
    evidence: [],
    warnings: [],
    checks: [],
    parameters: [],
    registers: [],
    signals: wave.signals.map((s) => ({
      ...s,
      label: s.id,
      direction: "output",
      triState: true,
    })),
    topology: { nodes: [], edges: [] },
    recipe: () => [
      "HDL source + testbench → external simulator → recorded waveform",
    ],
    simulate: () => trace,
  };
}
