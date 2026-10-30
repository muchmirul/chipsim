import { readJSON } from "../agent/io.js";
import { digest } from "../hdl/io.js";
import { waveformModel } from "../hdl/trace.js";
import { readCircuit, readBundle, compilerIdentity } from "./files.js";
import { compileCircuit } from "./model.js";
import { checkCoverage, evaluateStep, initialSnapshot } from "./relation.js";

export function circuitViewModel(loaded, wave, id) {
  const { model, coverage, source, bytes, compiler, report, sourceStatus } =
    loaded;
  const initial = initialSnapshot(model),
    first = evaluateStep(model, initial),
    recorded = Boolean(wave && report?.native);
  if (!wave) {
    const signals = [],
      changes = {};
    for (const [entries, values, prefix] of [
      [model.inputs, first.inputs, "i_"],
      [model.state, first.state, "q_"],
      [model.outputs, first.outputsAfter, "o_"],
    ])
      for (const entry of entries) {
        const name = `circuit_tb.${prefix}${entry.id}`;
        signals.push({ id: name, width: entry.width });
        changes[name] = BigInt(values[entry.id])
          .toString(2)
          .padStart(entry.width, "0");
      }
    wave = {
      format: "chipsim-waveform",
      version: 1,
      timescale: { magnitude: "1", unit: "ns" },
      signals,
      events: [{ time: "0", changes }],
      semantics:
        "Authored initial relation probe; no HDL execution or recorded observation",
      origin: { name: model.spec.name },
    };
  }
  const adapter = waveformModel(wave, id);
  if (!recorded) {
    const trace = adapter.simulate().map((snapshot) => ({
      ...snapshot,
      state: "CONNECTED",
      phase: "probe",
      message:
        "Authored initial relation probe; no HDL execution or native observation",
    }));
    adapter.simulate = () => trace;
  }
  adapter.connected = {
    model,
    coverage,
    source,
    sourceBytes: bytes.toString("base64"),
    compiler,
    report,
    sourceStatus: sourceStatus || "authored-source",
    recorded,
    ui: { tab: "step", index: 0, scroll: 0, probe: null },
  };
  adapter.name = model.spec.name;
  adapter.kind = "circuit";
  adapter.fidelity =
    "Explicit connected binary transition relation; native observations are separate";
  adapter.scope = coverage.scope;
  adapter.assumptions = [
    "Designer-authored wiring, initial values and transition rules; no vendor PDF or physical accuracy claim.",
    "Only a single rising-edge clock, synchronous reset rules and finite unsigned binary vectors. Memories, async controls and four-state logic are unsupported.",
    "Static declarations, one-event evaluation and native recordings are separate views.",
  ];
  return adapter;
}

export async function loadCircuitView(path, id) {
  const json = await readJSON(path, 128 * 1048576);
  if (json.format === "chipsim-circuit-bundle") {
    const loaded = await readBundle(path);
    const wave = loaded.report.artifacts["waveform.json"]
      ? await readJSON(loaded.root + "/waveform.json", 64 * 1048576)
      : null;
    return circuitViewModel(
      { ...loaded, compiler: loaded.report.compiler },
      wave,
      id,
    );
  }
  if (json.format === "chipsim-circuit-session") {
    if (
      json.version !== 1 ||
      typeof json.recorded !== "boolean" ||
      json.waveform?.format !== "chipsim-waveform" ||
      typeof json.sourceBytes !== "string" ||
      json.sourceBytes.length > 1400000
    )
      throw new Error("Invalid connected circuit session");
    const bytes = Buffer.from(json.sourceBytes, "base64");
    if (
      bytes.toString("base64") !== json.sourceBytes ||
      digest(bytes) !== json.source?.sha256
    )
      throw new Error("Circuit session source fingerprint mismatch");
    const compiler = await compilerIdentity();
    if (compiler.sha256 !== json.compiler?.sha256)
      throw new Error("Stale connected session compiler; rebuild explicitly");
    if (
      json.waveform &&
      digest(JSON.stringify(json.waveform)) !== json.waveformSha256
    )
      throw new Error("Circuit session waveform fingerprint mismatch");
    if (json.lowering) {
      if (
        typeof json.lowering.sourceBytes !== "string" ||
        json.lowering.sourceBytes.length > 1400000
      )
        throw new Error("Invalid frozen HDL source in connected session");
      const original = Buffer.from(json.lowering.sourceBytes, "base64");
      if (
        original.toString("base64") !== json.lowering.sourceBytes ||
        digest(original) !== json.lowering.source?.sha256
      )
        throw new Error("Frozen HDL source fingerprint mismatch");
    }
    if (
      !Number.isInteger(json.tick) ||
      json.tick < 0 ||
      !["hex", "decimal", "binary", "octal"].includes(json.display)
    )
      throw new Error("Invalid connected session cursor/display");
    const model = compileCircuit(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ),
      coverage = checkCoverage(model);
    if (!coverage.ok)
      throw new Error("Connected session fails scoped rule coverage");
    const adapter = circuitViewModel(
      {
        model,
        bytes,
        coverage,
        source: json.source,
        compiler,
        report: {
          native: json.recorded ? {} : null,
          correspondence: json.correspondence,
          lowering: json.lowering,
        },
        sourceStatus: "portable frozen snapshot",
      },
      json.waveform,
      id,
    );
    if (json.tick >= adapter.waveform.events.length)
      throw new Error("Circuit session cursor outside recording");
    if (json.ui !== undefined) {
      const ui = json.ui;
      if (
        !ui ||
        typeof ui !== "object" ||
        Array.isArray(ui) ||
        Object.keys(ui).some(
          (key) => !["tab", "index", "scroll", "probe"].includes(key),
        ) ||
        !["step", "rules", "native", "source", "rtl"].includes(ui.tab) ||
        !Number.isInteger(ui.index) ||
        ui.index < 0 ||
        ui.index >= model.state.length ||
        !Number.isInteger(ui.scroll) ||
        ui.scroll < 0 ||
        ui.scroll > 1000000
      )
        throw new Error("Invalid connected session inspection state");
      if (ui.probe !== null) evaluateStep(model, ui.probe);
      adapter.connected.ui = structuredClone(ui);
    }
    adapter.connected.savedUI = { tick: json.tick, display: json.display };
    return adapter;
  }
  const loaded = await readCircuit(path),
    coverage = checkCoverage(loaded.model);
  if (!coverage.ok)
    throw new Error(
      "Connected circuit requires complete scoped rule coverage: " +
        coverage.status,
    );
  return circuitViewModel(
    { ...loaded, coverage, compiler: await compilerIdentity() },
    null,
    id,
  );
}

export function circuitSession(model, tick, display) {
  const circuit = model.connected;
  return {
    format: "chipsim-circuit-session",
    version: 1,
    source: circuit.source,
    sourceBytes: circuit.sourceBytes,
    compiler: circuit.compiler,
    waveform: model.waveform,
    waveformSha256: digest(JSON.stringify(model.waveform)),
    recorded: circuit.recorded,
    correspondence: circuit.report?.correspondence ?? null,
    lowering: circuit.report?.lowering ?? null,
    ui: structuredClone(circuit.ui),
    tick,
    display,
  };
}

export function observedStep(model, trace, index) {
  const circuit = model.connected.model,
    before = trace[Math.max(0, index - 1)],
    current = trace[index];
  const read = (snapshot, prefix, entry) => {
    const value = snapshot.signals[`circuit_tb.${prefix}${entry.id}`];
    if (
      typeof value !== "string" ||
      !/^[01]+$/.test(value) ||
      value.length !== entry.width
    )
      throw new Error("Observation is unavailable/nonbinary: " + entry.id);
    return "0b" + value;
  };
  const snapshot = {
    state: Object.fromEntries(
      circuit.state.map((entry) => [entry.id, read(before, "q_", entry)]),
    ),
    inputs: Object.fromEntries(
      circuit.inputs.map((entry) => [entry.id, read(current, "i_", entry)]),
    ),
    previousClock:
      index === 0
        ? 0
        : Number(
            BigInt(
              read(
                before,
                "i_",
                circuit.inputs.find((entry) => entry.id === circuit.clock),
              ),
            ),
          ),
  };
  const step = evaluateStep(circuit, snapshot),
    actual = Object.fromEntries(
      circuit.state.map((entry) => [entry.id, read(current, "q_", entry)]),
    );
  return {
    step,
    actual,
    matches: circuit.state.every(
      (entry) => actual[entry.id] === step.next[entry.id],
    ),
    harness: Boolean(model.connected.report?.correspondence),
  };
}
