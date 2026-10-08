import { levelSymbols } from "./legends.js";
import { bits } from "./shared.js";

export function retainedOutputs(table, values, retained) {
  const matched = table.rows.filter((row) =>
    row.inputs.every(
      (value, index) => value === null || value === values[index],
    ),
  );
  if (!matched.length)
    throw new Error(
      "The retained-state table leaves an input combination undefined.",
    );
  const results = matched.map((row) =>
    row.outputs.map((value, index) =>
      value === "hold" ? retained[index] : value,
    ),
  );
  if (
    results.some((result) =>
      result.some((value, index) => value !== results[0][index]),
    )
  )
    throw new Error(
      "Overlapping level rows disagree for a retained output state.",
    );
  return results[0];
}
export function readRetainedTable(raw) {
  const { highLow, dontCare } = levelSymbols(raw.legend);
  const table = { ...raw, kind: "retained", rows: [] };
  if (
    table.outputs.length > 2 ||
    table.rawRows.length > 8 ||
    2 ** (table.inputs.length + table.outputs.length) > 64
  )
    throw new Error(
      "Retained-state tables require at most two outputs, eight rows, and 64 input/state cases.",
    );
  for (const row of raw.rawRows) {
    const inputs = row.inputs.map((cell) => {
      if (cell === "X") {
        if (!dontCare)
          throw new Error(
            "X is not explicitly defined as a don't-care or irrelevant input.",
          );
        return null;
      }
      if (!/^[HL01]$/.test(cell))
        throw new Error(
          "Level-state inputs require defined binary levels; edge/set-up symbols require review.",
        );
      if (/[HL]/.test(cell) && !highLow)
        throw new Error("The table does not define H and L voltage levels.");
      return ["H", "1"].includes(cell) ? 1 : 0;
    });
    const outputs = row.outputs.map((cell) => {
      if (/^no change$/i.test(cell)) return "hold";
      if (!/^[HL01]$/.test(cell))
        throw new Error(
          "Level-state outputs require binary values or explicit no change; symbolic, unspecified, or released states require review.",
        );
      if (/[HL]/.test(cell) && !highLow)
        throw new Error("The table does not define H and L voltage levels.");
      return ["H", "1"].includes(cell) ? 1 : 0;
    });
    table.rows.push({ inputs, outputs });
  }
  if (!table.rows.some((row) => row.outputs.includes("hold")))
    throw new Error("A retained-state table needs explicit no-change outputs.");
  table.matrix = [];
  for (let value = 0; value < 2 ** table.inputs.length; value++)
    for (let state = 0; state < 2 ** table.outputs.length; state++)
      table.matrix.push(
        retainedOutputs(
          table,
          bits(value, table.inputs.length),
          bits(state, table.outputs.length),
        ),
      );
  table.idle = Array.from({ length: 2 ** table.inputs.length }, (_, value) =>
    bits(value, table.inputs.length),
  ).find((values) =>
    Array.from({ length: 2 ** table.outputs.length }, (_, state) =>
      bits(state, table.outputs.length),
    ).every((retained) =>
      retainedOutputs(table, values, retained).every(
        (value, index) => value === retained[index],
      ),
    ),
  );
  if (!table.idle)
    throw new Error(
      "A retained-state table needs an explicitly covered all-output hold condition to establish each checked prior state.",
    );
  return table;
}
