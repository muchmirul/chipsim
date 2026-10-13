import { basename, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { debugLimits, validateDebugRecording } from "./recording.js";

// The observer protocol uses a dedicated JSONL artifact, independent of HDL
// stdout/stderr. A killed process may leave one unterminated final line.
export function parseObserverStream(text, { partial = false } = {}) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > debugLimits.fileBytes
  )
    throw new Error("HDL observer stream exceeds 96 MiB.");
  const lines = text.split("\n"),
    records = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const record = JSON.parse(lines[i]);
      if (!record || typeof record.record !== "string")
        throw new Error("missing record type");
      records.push(record);
    } catch (error) {
      if (partial && i === lines.length - 1 && !text.endsWith("\n")) {
        truncated = true;
        break;
      }
      throw new Error(`Invalid HDL observer record ${i + 1}: ${error.message}`);
    }
  }
  return { records, truncated };
}

const processTypes = {
  0: "initial",
  1: "always",
  2: "final",
  3: "always_comb",
  4: "always_ff",
  5: "always_latch",
};
// Labels are ivl_target.h v12_0 elaborated operator enums, not inferred gates.
// Unknown operators remain explicitly numbered instead of acquiring semantics.
const operators = Object.fromEntries([
  ...Object.entries({
    0: "add",
    1: "compare ≥",
    2: "compare >",
    3: "flip-flop",
    4: "multiply",
    5: "mux",
    6: "shift left",
    7: "shift right",
    8: "subtract",
    10: "compare =",
    11: "compare ≠",
    12: "divide",
    13: "modulo",
    14: "function",
    15: "part select",
    16: "concatenate",
    17: "part assign",
    18: "case equality",
    19: "case inequality",
    20: "reduce AND",
    21: "reduce NAND",
    22: "reduce NOR",
    23: "reduce OR",
    24: "reduce XNOR",
    25: "reduce XOR",
    26: "repeat",
    27: "sign extend",
    29: "system function",
    30: "array",
    31: "power",
    32: "absolute",
    34: "integer cast",
    35: "2-state cast",
    36: "transparent concatenate",
    37: "casex equality",
    38: "casez equality",
    39: "substitute",
    40: "latch",
    41: "wild equality",
    42: "wild inequality",
  }).map(([key, value]) => ["lpm:" + key, value]),
  ...Object.entries({
    1: "AND",
    2: "buffer",
    3: "buffer enable low",
    4: "buffer enable high",
    5: "buffer Z",
    6: "NAND",
    7: "NMOS",
    8: "NOR",
    9: "NOT",
    10: "inverter enable low",
    11: "inverter enable high",
    12: "OR",
    13: "pull down",
    14: "pull up",
    15: "resistive NMOS",
    16: "resistive PMOS",
    17: "PMOS",
    18: "XNOR",
    19: "XOR",
    21: "user primitive",
    22: "CMOS",
    23: "resistive CMOS",
    24: "transparent buffer",
    25: "equivalence",
    26: "implication",
  }).map(([key, value]) => ["logic:" + key, value]),
]);

export function collectDebugRecording({
  project,
  sourceRoot,
  sources,
  tools,
  stages,
  stream,
  design = "",
  runId = randomUUID(),
}) {
  const raw = parseObserverStream(stream, { partial: true });
  const staticRaw = design
    ? parseObserverStream(design, { partial: true })
    : { records: [], truncated: false };
  const header = raw.records[0];
  if (
    !header ||
    header.protocol !== 1 ||
    header.instrumentation !== "chipsim-1" ||
    header.record !== "header" ||
    header.backend !==
      (project.language === "verilog" ? "iverilog-12.0" : "ghdl-4.1.0") ||
    raw.records.filter((r) => r.record === "header").length !== 1
  )
    throw new Error(
      "Missing or incompatible ChipSim simulator instrumentation header.",
    );
  if (
    project.language === "verilog" &&
    (staticRaw.records[0]?.record !== "design" ||
      staticRaw.records[0].protocol !== 1 ||
      staticRaw.records[0].instrumentation !== "chipsim-1")
  )
    throw new Error("Missing or incompatible elaborated design header.");
  const all = [...staticRaw.records, ...raw.records];
  const diagnostics = [];
  const sourceMap = new Map(
    sources.map((s) => [resolve(sourceRoot, s.path), s]),
  );
  const unmappedSources = new Set();
  const source = (loc) => {
    if (!loc || !loc.file || !loc.line) return null;
    const saved = sourceMap.get(resolve(sourceRoot, loc.file));
    if (!saved) {
      unmappedSources.add(loc.file);
      return null;
    }
    return {
      file: saved.id,
      line: loc.line,
      ...(loc.column ? { column: loc.column } : {}),
    };
  };
  const objects = new Map(),
    scopeMap = new Map(),
    observed = new Set(),
    observedWidths = new Map();
  for (const record of all) {
    if (record.record === "observe") {
      observed.add(record.id);
      observedWidths.set(record.id, record.width);
    }
    if (record.record === "object") {
      if (objects.has(record.id))
        throw new Error("Duplicate elaborated object " + record.id);
      const obj = { ...record };
      delete obj.record;
      obj.source = source(obj.source);
      obj.label =
        obj.path ||
        (obj.kind === "process"
          ? `${obj.scope}.${processTypes[obj.processType] || "process"}@${record.source?.line || "?"} (${obj.id})`
          : operators[obj.operation] || obj.operation || obj.id);
      if (["signal", "port"].includes(obj.kind)) {
        if (obj.dataType !== undefined && ![3, 4].includes(obj.dataType)) {
          obj.kind = "net";
          obj.omitted = "non-digital signal type";
        } else if (
          !Number.isInteger(obj.width) ||
          obj.width < 1 ||
          obj.width > debugLimits.width
        ) {
          // Keep a structural node for omitted signals, with an explicit reason.
          obj.kind = "net";
          obj.omitted = "width outside the 1–4096-bit capture range";
          diagnostics.push(obj.label + ": " + obj.omitted);
        } else obj.observed = project.language === "vhdl";
      }
      objects.set(obj.id, obj);
      if (obj.path && ["instance", "process"].includes(obj.kind))
        scopeMap.set(obj.path, obj.id);
    }
  }
  for (const id of observed) {
    const object = objects.get(id);
    if (!object || !["signal", "port"].includes(object.kind))
      throw new Error("Observed signal has no elaborated mapping: " + id);
    object.observed = true;
    if (object.width !== observedWidths.get(id)) {
      if (
        !object.constant ||
        !Number.isInteger(observedWidths.get(id)) ||
        observedWidths.get(id) < 1 ||
        observedWidths.get(id) > object.width
      )
        throw new Error(
          "Observed signal width differs from elaboration: " + id,
        );
      // Icarus stores generated integer constants in a narrowed VPI handle.
      // Restore their compiler-declared width with its signedness metadata.
      object.runtimeWidth = observedWidths.get(id);
    }
  }
  for (const object of objects.values()) {
    if (["signal", "port"].includes(object.kind)) object.observed ??= false;
    if (object.scope && scopeMap.has(object.scope))
      object.parent = scopeMap.get(object.scope);
    if (!object.parent && object.path) {
      const parents = [...scopeMap.keys()].filter((p) =>
        object.path.startsWith(p + "."),
      );
      parents.sort((a, b) => b.length - a.length);
      if (parents.length) object.parent = scopeMap.get(parents[0]);
    }
    delete object.scope;
  }
  const connections = [],
    edgeIds = new Set();
  for (const object of [...objects.values()]) {
    if (object.kind !== "signal" || !object.mode) continue;
    const direction =
      project.language === "verilog"
        ? { 1: "input", 2: "output", 3: "inout" }[object.mode]
        : { 1: "linkage", 2: "buffer", 3: "output", 4: "inout", 5: "input" }[
            object.mode
          ];
    if (!direction) throw new Error("Unknown elaborated port direction.");
    const port = {
      ...object,
      id: "port:" + object.id,
      kind: "port",
      observed: false,
      direction,
    };
    objects.set(port.id, port);
    connections.push({
      id: "e:" + connections.length,
      from: port.id,
      to: object.id,
      kind: "port",
    });
  }
  for (const record of all.filter((r) => r.record === "edge")) {
    if (!objects.has(record.from) || !objects.has(record.to))
      throw new Error(
        `Elaborated connection has a missing endpoint: ${record.from} → ${record.to}`,
      );
    const key = JSON.stringify([record.from, record.to, record.kind]);
    if (edgeIds.has(key)) continue;
    edgeIds.add(key);
    connections.push({
      id: "e:" + connections.length,
      from: record.from,
      to: record.to,
      kind: record.kind,
    });
  }
  const events = [];
  let bytes = 0,
    normalizerLimit;
  for (const record of raw.records.filter((r) => r.record === "event")) {
    const event = { ...record };
    delete event.record;
    if (event.source) event.source = source(event.source);
    if (event.arguments && !event.message)
      event.message = event.arguments.join(" · ");
    for (const [id, bits] of Object.entries(event.changes || {})) {
      const object = objects.get(id);
      if (
        object?.constant &&
        object.runtimeWidth &&
        typeof bits === "string" &&
        bits.length === object.runtimeWidth
      )
        event.changes[id] = bits.padStart(
          object.width,
          object.signed ? bits[0] : "0",
        );
    }
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (bytes > debugLimits.eventBytes || events.length >= debugLimits.events) {
      normalizerLimit = "event data limit";
      break;
    }
    events.push(event);
  }
  let timescale = { magnitude: "1", unit: "fs" };
  if (header.precision !== undefined) {
    if (
      !Number.isInteger(header.precision) ||
      header.precision < -15 ||
      header.precision > 0
    )
      throw new Error("Unsupported simulator time precision.");
    const [unit, power] = Object.entries({
      s: 0,
      ms: -3,
      us: -6,
      ns: -9,
      ps: -12,
      fs: -15,
    }).find(([, power]) => header.precision >= power);
    timescale = {
      magnitude: (10n ** BigInt(header.precision - power)).toString(),
      unit,
    };
  }
  const limits = all.filter((r) => r.record === "limit").map((r) => r.reason);
  if (normalizerLimit) limits.push(normalizerLimit);
  const omissions = all.filter((r) => r.record === "unsupported");
  for (const record of omissions)
    diagnostics.push(`${record.path}: ${record.reason}`);
  for (const file of unmappedSources)
    diagnostics.push(
      `Source outside the project snapshot: ${relative(sourceRoot, resolve(sourceRoot, file)) || basename(file)}`,
    );
  const failed = stages.find((stage) => !stage.ok);
  for (const stage of stages.filter((stage) => !stage.ok)) {
    diagnostics.push(`${stage.stage}: ${stage.reason || "exit " + stage.code}`);
    for (const channel of ["stdout", "stderr"]) {
      if (!stage[channel]) continue;
      diagnostics.push(
        `${stage.stage} ${channel}: ${stage[channel].slice(0, 65000)}${stage[channel].length > 65000 ? "\n[diagnostic truncated; full stage output is in diagnostics.json]" : ""}`,
      );
    }
  }
  const ended = raw.records.some((r) => r.record === "end");
  const designEnded =
    project.language !== "verilog" ||
    staticRaw.records.some((r) => r.record === "design-end");
  const end = raw.records.find((r) => r.record === "end");
  if (
    end &&
    end.events !== raw.records.filter((r) => r.record === "event").length
  )
    throw new Error("Observer end count differs from recorded events.");
  const complete =
    !failed &&
    ended &&
    designEnded &&
    !raw.truncated &&
    !staticRaw.truncated &&
    !limits.length &&
    !omissions.length;
  const result = {
    format: "chipsim-hdl-debug",
    version: 1,
    run: {
      id: runId,
      name: project.name || project.top,
      language: project.language,
      project,
      tools,
      instrumentation: header.instrumentation,
    },
    timescale,
    sources,
    design: { objects: [...objects.values()], connections },
    events,
    capabilities: {
      processActivations: true,
      signalUpdates: true,
      schedulerPhases: true,
      deltaCycles: project.language === "vhdl",
      sourceStatements: false,
      sourceLocations: [...objects.values()]
        .filter((o) => o.kind === "process")
        .every((p) => p.source)
        ? "complete"
        : "partial",
      connectivity: "elaborated RTL",
      observedWriters: false,
      liveControl: false,
      signalCoverage:
        omissions.length || limits.length
          ? "partial"
          : "supported digital signals",
    },
    status: {
      complete,
      reason:
        failed?.reason ||
        (failed ? `simulator exited with code ${failed.code}` : null) ||
        limits[0] ||
        (omissions.length ? "unsupported signal type or width" : null) ||
        (!ended || !designEnded || raw.truncated || staticRaw.truncated
          ? "interrupted recording"
          : "finished"),
      limits,
    },
    diagnostics,
  };
  return validateDebugRecording(result);
}

// Compilation/transport failures still produce an inspectable source/diagnostic
// artifact. No values, execution locations or timestamps are invented.
export function failedDebugRecording({
  project,
  sources,
  tools,
  stages,
  reason,
}) {
  return validateDebugRecording({
    format: "chipsim-hdl-debug",
    version: 1,
    run: {
      id: randomUUID(),
      name: project.name || project.top,
      language: project.language,
      project,
      tools,
    },
    timescale: { magnitude: "1", unit: "fs" },
    sources,
    design: { objects: [], connections: [] },
    events: [],
    capabilities: {
      processActivations: false,
      signalUpdates: false,
      schedulerPhases: false,
      deltaCycles: false,
      sourceStatements: false,
      sourceLocations: "unavailable",
      connectivity: "unavailable",
      observedWriters: false,
      liveControl: false,
      signalCoverage: "unavailable",
    },
    status: {
      complete: false,
      reason:
        "No validated event stream: " +
        reason.slice(0, 1800).replace(/[\x00-\x1f]/g, " "),
      limits: [],
    },
    diagnostics: [
      reason,
      ...stages.flatMap((s) => [s.reason, s.stdout, s.stderr].filter(Boolean)),
    ].map((s) => String(s).slice(0, 65536)),
  });
}
