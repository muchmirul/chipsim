export function valueBits(value, width = 1) {
  if (value === "Z") return "Z".repeat(width);
  if (typeof value === "string" && /^[01xXzZuUwWlLhH-]+$/.test(value))
    return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return "?".repeat(width);
  return (BigInt(value) & ((1n << BigInt(width)) - 1n))
    .toString(2)
    .padStart(width, "0");
}

function declarationWidth(model, field) {
  const [kind, id] = field.split(".");
  return (
    (kind === "signal" ? model.signals : model.registers)?.find(
      (item) => item.id === id,
    )?.width || 32
  );
}

export function flowFrame(model, trace, tick, parameters = {}) {
  const snapshot = trace[tick];
  if (!snapshot)
    return {
      kind: "unavailable",
      operations: [],
      message: "No snapshot at this tick",
    };
  if (model.kind === "builtin") {
    const bits = Number(parameters.bits) || 8,
      previous = trace[tick - 1],
      sampled =
        !!previous && snapshot.registers.samples > previous.registers.samples;
    return {
      kind: "serial",
      title: "LSB-first transfer · modeled receiver",
      bits,
      payload: Number(parameters.payload) & (2 ** bits - 1),
      data: snapshot.signals.data,
      clock: snapshot.signals.clock,
      ack: snapshot.signals.ack,
      samples: snapshot.registers.samples,
      decoded: snapshot.registers.decoded,
      bitIndex: snapshot.registers.bitIndex,
      sampled,
      launched:
        snapshot.state === "send" &&
        (tick === 0 ||
          previous?.state === "load" ||
          (!!previous &&
            snapshot.registers.bitIndex !== previous.registers.bitIndex)),
      operations: [],
      message: snapshot.message,
    };
  }
  const operations = (snapshot.operations || []).map((operation, index) => ({
    ...operation,
    index,
    reads: operation.reads.map((read) => ({
      ...read,
      width: declarationWidth(model, read.field),
    })),
  }));
  return {
    kind: operations.length ? "assignments" : "changes",
    operations,
    total: snapshot.operationCount ?? operations.length,
    changes: (snapshot.changes || [])
      .filter((change) => ["signals", "registers"].includes(change.kind))
      .map((change) => ({
        ...change,
        width: declarationWidth(
          model,
          (change.kind === "signals" ? "signal." : "reg.") + change.id,
        ),
      })),
    message: operations.length
      ? "Executed assignments in order; arrows represent evaluated reads"
      : "Observed value changes; no internal data movement is inferred",
  };
}
