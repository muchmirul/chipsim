import { compareTraces } from "../core/trace-diff.js";
import { validateInputs } from "../model/engine.js";

export function captureExperiment(model, trace, session, label = "Reference") {
  if (model.waveform)
    throw new Error(
      "Use HDL comparison with explicit signal mappings and time units for recorded waveforms.",
    );
  return {
    label,
    model: JSON.parse(
      JSON.stringify(model, (key, value) =>
        typeof value === "function" ? undefined : value,
      ),
    ),
    trace: structuredClone(trace),
    session: structuredClone(session),
    origin: "captured",
  };
}

export function compareExperiments(reference, current) {
  if (reference.model.waveform || current.model.waveform)
    throw new Error(
      "Model experiments use normalized ticks; HDL comparison requires explicit mappings and time units.",
    );
  const comparison = compareTraces(reference.trace, current.trace),
    parameterChanges = [],
    inputChanges = [];
  for (const field of new Set([
    ...Object.keys(reference.session.parameters),
    ...Object.keys(current.session.parameters),
  ])) {
    const before = reference.session.parameters[field] ?? null,
      after = current.session.parameters[field] ?? null;
    if (before !== after) parameterChanges.push({ field, before, after });
  }
  const left = reference.session.inputs || [],
    right = current.session.inputs || [];
  for (let index = 0; index < Math.max(left.length, right.length); index++)
    if (
      ["tick", "signal", "value"].some(
        (key) => left[index]?.[key] !== right[index]?.[key],
      )
    )
      inputChanges.push({
        index,
        before: left[index] || null,
        after: right[index] || null,
      });
  const widthChanges = [];
  for (const group of ["signals", "registers"])
    for (const item of reference.model[group] || []) {
      const other = current.model[group]?.find((other) => other.id === item.id);
      if (other && other.width !== item.width)
        widthChanges.push({
          field: (group === "signals" ? "signal." : "reg.") + item.id,
          before: item.width,
          after: other.width,
        });
    }
  return {
    ...comparison,
    parameterChanges,
    inputChanges,
    widthChanges,
    scope:
      "Exact field names at identical normalized ticks; missing snapshots are unavailable",
    referenceTicks: reference.trace.length,
    currentTicks: current.trace.length,
    durationChange:
      reference.session.duration === current.session.duration
        ? null
        : {
            before: reference.session.duration,
            after: current.session.duration,
          },
  };
}

export function comparisonJSON(
  reference,
  current,
  comparison = compareExperiments(reference, current),
) {
  return {
    format: "chipsim-experiment-comparison",
    version: 1,
    reference: {
      label: reference.label,
      origin: reference.origin || "live",
      session: reference.session,
    },
    current: {
      label: current.label,
      origin: current.origin || "live",
      session: current.session,
    },
    comparison,
  };
}

// Imported observations are data, never executable programs or verified runs.
export function recordedExperiment(data, label = "Recorded reference") {
  if (
    data?.format !== "chipsim-trace" ||
    data.version !== 1 ||
    data.timing?.unit !== "normalized tick"
  )
    throw new Error(
      "Expected a normalized ChipSim JSON trace or a ChipSim session.",
    );
  const model = data.model;
  if (!model || typeof model.id !== "string" || typeof model.name !== "string")
    throw new Error("Trace model identity is missing.");
  const declarations = {};
  for (const [group, limit] of [
    ["signals", 64],
    ["registers", 256],
  ]) {
    const items = model[group] || [];
    if (!Array.isArray(items) || items.length > limit)
      throw new Error("Invalid trace declarations.");
    declarations[group] = new Map();
    for (const item of items) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.id) ||
        !Number.isInteger(item.width) ||
        item.width < 1 ||
        item.width > 32 ||
        declarations[group].has(item.id)
      )
        throw new Error("Invalid trace field declaration.");
      declarations[group].set(item.id, item);
    }
  }
  if (!Array.isArray(data.trace) || !data.trace.length)
    throw new Error("Trace is empty.");
  compareTraces(data.trace, data.trace);
  const observedRegisters = new Set();
  for (const snapshot of data.trace) {
    if (
      typeof snapshot.state !== "string" ||
      typeof snapshot.phase !== "string" ||
      snapshot.state.length > 256 ||
      snapshot.phase.length > 256
    )
      throw new Error("Invalid trace state.");
    for (const group of ["signals", "registers"]) {
      const fields = snapshot[group];
      if (!fields || typeof fields !== "object" || Array.isArray(fields))
        throw new Error("Invalid trace values.");
      for (const [id, value] of Object.entries(fields)) {
        const declaration = declarations[group].get(id);
        // Older builtin exports have observed 32-bit registers without declarations.
        const legacyRegister =
          group === "registers" &&
          !model.definition &&
          !(model.registers || []).length;
        if (
          !declaration &&
          !(legacyRegister && /^[A-Za-z_][A-Za-z0-9_]*$/.test(id))
        )
          throw new Error("Undeclared trace field: " + id);
        const width = declaration?.width || 32;
        if (
          value !== null &&
          !(value === "Z" && group === "signals" && declaration?.triState) &&
          !(Number.isInteger(value) && value >= 0 && value <= 2 ** width - 1)
        )
          throw new Error("Invalid trace value for " + id);
        if (legacyRegister) observedRegisters.add(id);
      }
      if (
        group === "signals" &&
        [...declarations.signals.keys()].some(
          (id) => !Object.hasOwn(fields, id),
        )
      )
        throw new Error("Trace omits a declared signal.");
    }
  }
  const portableModel = {
    ...model,
    registers: (model.registers || []).length
      ? model.registers
      : [...observedRegisters].map((id) => ({ id, width: 32 })),
  };
  if (
    data.parameters !== undefined &&
    (!data.parameters ||
      typeof data.parameters !== "object" ||
      Array.isArray(data.parameters))
  )
    throw new Error("Invalid recorded parameters.");
  const inputs = validateInputs(model.signals, data.inputs || []);
  const result = captureExperiment(
    portableModel,
    data.trace,
    {
      modelId: model.id,
      model: model.definition || null,
      parameters: data.parameters || {},
      inputs,
      duration: data.trace.length - 1,
    },
    label,
  );
  result.origin = "recorded · imported observations, not replay-verified";
  return result;
}
