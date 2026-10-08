export const bits = (value, count) =>
  Array.from(
    { length: count },
    (_, index) => (value >> (count - 1 - index)) & 1,
  );
export function nextOutputs(table, previousClock, values, retained) {
  const clock = values[table.clock.index];
  const matched = table.rows.filter((row) =>
    row.inputs.every((expected, index) => {
      if (expected === null) return true;
      if (expected === "rise") return previousClock === 0 && clock === 1;
      if (expected === "fall") return previousClock === 1 && clock === 0;
      return expected === values[index];
    }),
  );
  const results = matched.map((row) =>
    row.outputs.map((output, index) =>
      output === "hold" ? retained[index] : output,
    ),
  );
  if (!results.length) {
    const active = table.clock.edges.some((edge) =>
      edge === "rise"
        ? previousClock === 0 && clock === 1
        : previousClock === 1 && clock === 0,
    );
    if (active)
      throw new Error(
        "The sequential table leaves an active clock transition undefined.",
      );
    return retained;
  }
  if (
    results.some((outputs) =>
      outputs.some((output, index) => output !== results[0][index]),
    )
  )
    throw new Error(
      "Overlapping sequential rows disagree for a retained output state.",
    );
  return results[0];
}
export function readSequentialTable(raw, document) {
  const table = { ...raw, kind: "sequential", rows: [] };
  const highLow =
      /\bH\s*=\s*HIGH/.test(table.legend) && /\bL\s*=\s*LOW/.test(table.legend),
    dontCare = /X\s*=\s*(?:don['’]t|do not)\s+care/i.test(table.legend),
    setupHigh = /\bh\s*=\s*HIGH voltage level one set-up time prior/.test(
      table.legend,
    ),
    setupLow = /\bl\s*=\s*LOW voltage level one set-up time prior/.test(
      table.legend,
    );
  const arrowColumns = new Set(),
    edges = new Set();
  for (const row of table.rawRows) {
    const inputs = row.inputs.map((cell, index) => {
      if (cell === "↑" || cell === "↓") {
        const direction = cell === "↑" ? "LOW-to-HIGH" : "HIGH-to-LOW";
        if (
          !new RegExp(
            cell + "\\s*=\\s*" + direction + " (?:clock )?transition",
          ).test(table.legend)
        )
          throw new Error(
            "Clock arrows require an explicit transition definition.",
          );
        arrowColumns.add(index);
        edges.add(cell === "↑" ? "rise" : "fall");
        return cell === "↑" ? "rise" : "fall";
      }
      if (cell === "X") {
        if (!dontCare)
          throw new Error("X is not explicitly defined as a don't-care input.");
        return null;
      }
      if (cell === "h" || cell === "l") {
        if (!(cell === "h" ? setupHigh : setupLow))
          throw new Error(
            "Lowercase h/l require their explicit set-up-level definition.",
          );
        return cell === "h" ? 1 : 0;
      }
      if (/^[HL01]$/.test(cell)) {
        if (/^[HL]$/.test(cell) && !highLow)
          throw new Error("The table does not define H and L voltage levels.");
        return ["H", "1"].includes(cell) ? 1 : 0;
      }
      throw new Error("Unsupported sequential input symbol " + cell + ".");
    });
    const outputs = row.outputs.map((cell) => {
      if (cell === "no change") return "hold";
      if (/^[HL01]$/.test(cell)) {
        if (/^[HL]$/.test(cell) && !highLow)
          throw new Error("The table does not define H and L voltage levels.");
        return ["H", "1"].includes(cell) ? 1 : 0;
      }
      throw new Error(
        "Unspecified, tri-state, or symbolic sequential outputs require review.",
      );
    });
    table.rows.push({ inputs, outputs });
  }
  if (arrowColumns.size !== 1)
    throw new Error(
      "A sequential table must explicitly identify one edge-triggered clock column.",
    );
  const clockIndex = [...arrowColumns][0];
  table.clock = {
    index: clockIndex,
    input: table.inputs[clockIndex],
    edges: [...edges],
  };
  const trigger = document.pages.flatMap((page) => {
    const quote = /(?:positive|negative)?[- ]?edge[- ]trigger(?:ed)?/i
      .exec(page.text)?.[0]
      ?.trim();
    return quote ? [{ page: page.number, quote }] : [];
  })[0];
  if (!trigger)
    throw new Error(
      "Retaining state outside table rows requires documented edge-triggered behavior.",
    );
  table.trigger = trigger;
  if (
    table.outputs.length > 2 ||
    2 ** (table.inputs.length + table.outputs.length + 1) > 64
  )
    throw new Error(
      "Sequential state/input/clock coverage exceeds the 64-case model limit.",
    );
  // Exhaustive domain includes the previous clock and every retained output.
  // Missing edge rows are never filled with hold; only inactive clock patterns
  // can retain state under the documented edge-triggered contract.
  table.matrix = [];
  for (let previousClock = 0; previousClock < 2; previousClock++)
    for (
      let combination = 0;
      combination < 2 ** table.inputs.length;
      combination++
    )
      for (let retained = 0; retained < 2 ** table.outputs.length; retained++)
        table.matrix.push(
          nextOutputs(
            table,
            previousClock,
            bits(combination, table.inputs.length),
            bits(retained, table.outputs.length),
          ),
        );
  table.idle = [0, 1].map((clock) =>
    Array.from({ length: 2 ** table.inputs.length }, (_, value) =>
      bits(value, table.inputs.length),
    ).find(
      (values) =>
        values[clockIndex] === clock &&
        Array.from({ length: 2 ** table.outputs.length }, (_, state) =>
          bits(state, table.outputs.length),
        ).every((retained) =>
          nextOutputs(table, clock, values, retained).every(
            (value, index) => value === retained[index],
          ),
        ),
    ),
  );
  if (table.idle.some((values) => !values))
    throw new Error(
      "A sequential table needs a stable idle condition for each initial clock level.",
    );
  if (table.rows.length > 8)
    throw new Error("Sequential tables are limited to eight source rows.");
  return table;
}
