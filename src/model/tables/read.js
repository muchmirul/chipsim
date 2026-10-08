import { readTableLayouts } from "./layout.js";
import { readSequentialTable } from "./sequential-read.js";
import { readRetainedTable } from "./retained-read.js";
import { impedanceQuote, levelSymbols } from "./legends.js";
function binaryTable(raw) {
  const table = { ...raw, rows: [] },
    triState = raw.rawRows.some((row) => row.outputs.includes("Z"));
  if (triState && !impedanceQuote(table.legend))
    throw new Error("Z requires an explicit high-impedance output definition.");
  if (triState) table.kind = "tri-state";
  const { highLow, dontCare } = levelSymbols(table.legend);
  for (const row of table.rawRows) {
    const cells = [...row.inputs, ...row.outputs];
    if (
      row.inputs.some((cell) => !/^[HLX01]$/.test(cell)) ||
      row.outputs.some((cell) => !/^[HLXZ01]$/.test(cell))
    )
      throw new Error(
        "A table row contains unsupported edge/state/tri-state symbols, footnotes, or prose.",
      );
    if (cells.some((cell) => /[HL]/.test(cell)) && !highLow)
      throw new Error("The table does not define H and L voltage levels.");
    if (row.inputs.includes("X") && !dontCare)
      throw new Error("X is not explicitly defined as a don't-care input.");
    if (row.outputs.includes("X"))
      throw new Error(
        "Unspecified outputs cannot become deterministic binary outputs.",
      );
    table.rows.push({
      inputs: row.inputs.map((cell) =>
        cell === "X" ? null : ["H", "1"].includes(cell) ? 1 : 0,
      ),
      outputs: row.outputs.map((cell) =>
        cell === "Z" ? "Z" : ["H", "1"].includes(cell) ? 1 : 0,
      ),
    });
  }
  table.matrix = [];
  for (
    let combination = 0;
    combination < 2 ** table.inputs.length;
    combination++
  ) {
    const values = table.inputs.map(
      (_, index) => (combination >> (table.inputs.length - 1 - index)) & 1,
    );
    const rows = table.rows.filter((row) =>
      row.inputs.every(
        (value, index) => value === null || value === values[index],
      ),
    );
    if (!rows.length)
      throw new Error(
        "The table does not define every binary input combination.",
      );
    if (
      rows.some((row) =>
        row.outputs.some((value, index) => value !== rows[0].outputs[index]),
      )
    )
      throw new Error("Overlapping rows disagree about an output.");
    table.matrix.push([...rows[0].outputs]);
  }
  delete table.rawRows;
  return table;
}
export function readFunctionTables(document) {
  const { tables: layouts, diagnostics } = readTableLayouts(document),
    tables = [];
  for (const raw of layouts)
    try {
      tables.push(
        raw.rawRows.some((row) => row.inputs.some((cell) => /[↑↓]/.test(cell)))
          ? readSequentialTable(raw, document)
          : raw.rawRows.some((row) =>
                row.outputs.some((cell) => /^no change$/i.test(cell)),
              )
            ? readRetainedTable(raw)
            : binaryTable(raw),
      );
    } catch (error) {
      diagnostics.push({
        page: raw.page,
        caption: raw.caption,
        reason: error.message,
      });
    }
  return { tables, diagnostics };
}
