// Bounded, data-only CSV. No spreadsheet formula evaluation or type inference.
export function readCSV(
  text,
  columns,
  { maxBytes = 1048576, maxRows = 10000 } = {},
) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maxBytes)
    throw new Error(`CSV must be UTF-8 text of at most ${maxBytes} bytes.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new Error("CSV contains unsupported control characters.");
  text = text.replace(/^\uFEFF/, "");
  const records = [];
  let row = [],
    cell = "",
    quoted = false,
    closed = false;
  const field = () => {
    row.push(cell.trim());
    if (row.length > columns.length)
      throw new Error("CSV has too many columns.");
    cell = "";
    closed = false;
  };
  const record = () => {
    field();
    if (row.some((value) => value !== "") || row.length > 1) records.push(row);
    if (records.length > maxRows + 1)
      throw new Error(`CSV exceeds ${maxRows} data rows.`);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === ",") field();
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record();
    } else if (ch === '"') {
      if (cell.trim() || closed)
        throw new Error("CSV quote must start a field.");
      cell = "";
      quoted = true;
    } else {
      if (closed && !/[ \t]/.test(ch))
        throw new Error("Unexpected text after a CSV quote.");
      if (!closed) cell += ch;
    }
    if (cell.length > 4096)
      throw new Error("CSV field exceeds 4096 characters.");
  }
  if (quoted) throw new Error("Unterminated CSV quoted field.");
  if (cell || row.length || closed) record();
  const header = records.shift()?.map((value) => value.toLowerCase());
  if (
    !header ||
    header.length !== columns.length ||
    new Set(header).size !== columns.length ||
    columns.some((column) => !header.includes(column))
  )
    throw new Error(
      "CSV requires exactly these named columns: " + columns.join(",") + ".",
    );
  return records.map((fields, index) => {
    if (fields.length !== header.length || fields.some((value) => !value))
      throw new Error(
        `CSV data row ${index + 1}: every column needs an explicit value.`,
      );
    return Object.fromEntries(header.map((key, i) => [key, fields[i]]));
  });
}
