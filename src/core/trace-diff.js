// Compare observable state, independently of log wording and diagram styling.
// null denotes an unavailable/uninitialized value in portable comparison JSON.
export function compareTraces(before, after) {
  for (const trace of [before, after]) {
    if (!Array.isArray(trace) || trace.length > 10001)
      throw new Error(
        "Trace comparison requires arrays of at most 10001 ticks.",
      );
    for (const [tick, snapshot] of trace.entries())
      if (!snapshot || snapshot.tick !== tick)
        throw new Error(
          "Trace comparison requires contiguous ticks starting at zero.",
        );
  }
  const differences = [],
    ticks = Math.max(before.length, after.length);
  for (let tick = 0; tick < ticks; tick++) {
    const previous = before[tick],
      next = after[tick],
      changes = [];
    const change = (field, left, right) => {
      left ??= null;
      right ??= null;
      if (left !== right) changes.push({ field, before: left, after: right });
    };
    change("snapshot", Boolean(previous), Boolean(next));
    for (const field of ["state", "phase"])
      change(field, previous?.[field], next?.[field]);
    for (const group of ["signals", "registers"]) {
      const left = previous?.[group] || {},
        right = next?.[group] || {},
        keys = [
          ...new Set([...Object.keys(left), ...Object.keys(right)]),
        ].sort();
      if (keys.length > (group === "signals" ? 64 : 256))
        throw new Error(
          "Trace comparison exceeds the declared signal/register bounds.",
        );
      for (const id of keys)
        change(
          (group === "signals" ? "signal." : "reg.") + id,
          left[id],
          right[id],
        );
    }
    if (changes.length) differences.push({ tick, changes });
  }
  return {
    ticks,
    changedTicks: differences.length,
    firstDifference: differences[0]?.tick ?? null,
    differences,
  };
}
