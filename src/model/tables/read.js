import { readTableLayouts } from "./layout.js";
import { readSequentialTable } from "./sequential-read.js";
function binaryTable(raw) {
  const table = { ...raw, rows: [] };
  const highLow =
    /H\s*=\s*HIGH/i.test(table.legend) && /L\s*=\s*LOW/i.test(table.legend);
  const dontCare = /X\s*=\s*(?:don['’]t|do not)\s+care/i.test(table.legend);
  for (const row of table.rawRows) {
    const cells = [...row.inputs, ...row.outputs];
    if (cells.some((cell) => !/^[HLX01]$/.test(cell)))
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
      outputs: row.outputs.map((cell) => (["H", "1"].includes(cell) ? 1 : 0)),
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
        raw.rawRows.some((row) =>
          [...row.inputs, ...row.outputs].some((cell) =>
            /[↑↓]|no change/.test(cell),
          ),
        )
          ? readSequentialTable(raw, document)
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
