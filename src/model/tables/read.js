const normalized = (text) => text.replace(/\s+/g, " ").trim();
const caption =
  /\b(?:Table\s+([\w.-]+)[.:]?\s*)?((?:function|truth)\s+table)\b/i;
const tokens = (line) =>
  line.cells
    .flatMap((cell) => {
      const text = cell.text;
      return Array.from(text.matchAll(/\S+/g), (match) => ({
        text: match[0],
        x:
          cell.x +
          ((cell.width || text.length) * match.index) /
            Math.max(1, text.length),
        width:
          ((cell.width || text.length) * match[0].length) /
          Math.max(1, text.length),
      }));
    })
    .sort((a, b) => a.x - b.x);
const lineText = (line) => line.cells.map((cell) => cell.text).join(" ");
const signalName = /^[a-zA-Z][a-zA-Z\d_]*$/;
function parse(page, start) {
  const lines = page.layoutLines,
    heading = lineText(lines[start]),
    match = caption.exec(heading);
  const table = {
    page: page.number,
    number: match[1] || String(start),
    caption: normalized(heading),
    inputs: [],
    outputs: [],
    rows: [],
  };
  const fail = (reason) => ({
    table: null,
    diagnostic: { page: page.number, caption: table.caption, reason },
  });
  let group = -1;
  for (
    let index = start + 1;
    index < Math.min(lines.length, start + 12);
    index++
  ) {
    const words = tokens(lines[index]);
    if (
      words.some((w) => /^Outputs?$/i.test(w.text)) &&
      words.some((w) => /^(?:Inputs?|Control)$/i.test(w.text))
    ) {
      group = index;
      break;
    }
    if (caption.test(lineText(lines[index]))) break;
  }
  if (group < 0)
    return fail("Cannot identify separate input/output column headings.");
  const groups = tokens(lines[group]),
    output = groups.find((word) => /^Outputs?$/i.test(word.text));
  let names, split, rowStart;
  if (
    groups.every((word) => /^(?:Inputs?|Outputs?|Control)$/i.test(word.text))
  ) {
    names = tokens(lines[group + 1] || { cells: [] });
    split = names.findIndex((name) => name.x + name.width / 2 >= output.x - 2);
    rowStart = group + 2;
  } else {
    // Inline cells such as "Input nA | Input nB | Output nY" explicitly
    // declare each role and need no positional guess about the split.
    if (
      groups.length % 2 ||
      groups.some((word, index) =>
        index % 2
          ? !signalName.test(word.text)
          : !/^(?:Input|Output)$/i.test(word.text),
      )
    )
      return fail("Unsupported grouped table headings.");
    names = groups.filter((_, index) => index % 2);
    split = groups
      .filter((_, index) => !(index % 2))
      .findIndex((word) => /^Output$/i.test(word.text));
    if (
      groups
        .filter((_, index) => !(index % 2))
        .slice(split)
        .some((word) => !/^Output$/i.test(word.text))
    )
      return fail("Interleaved input/output columns require review.");
    rowStart = group + 1;
  }
  if (
    !names.length ||
    names.some((word) => !signalName.test(word.text)) ||
    new Set(names.map((word) => word.text)).size !== names.length
  )
    return fail("Signal headings are missing, duplicated, or ambiguous.");
  if (split <= 0 || split >= names.length)
    return fail("Input/output column boundary is ambiguous.");
  table.inputs = names.slice(0, split).map((name) => name.text);
  table.outputs = names.slice(split).map((name) => name.text);
  if (table.inputs.length > 6 || table.outputs.length > 24)
    return fail("This table exceeds the 6-input/24-output binary-table limit.");
  const centers = names.map((name) => name.x + name.width / 2);
  const local = normalized(lines.slice(start, group).map(lineText).join(" "));
  const highLow = /H\s*=\s*HIGH/i.test(local) && /L\s*=\s*LOW/i.test(local);
  const dontCare = /X\s*=\s*(?:don['’]t|do not)\s+care/i.test(local);
  let end = rowStart;
  for (; end < lines.length; end++) {
    const row = tokens(lines[end]);
    if (!row.length) continue;
    if (!row.every((token) => /^[HLX01]$/.test(token.text))) {
      if (
        /^(?:\d+(?:\.\d+)*\.?\s+[A-Za-z]|Table\s+\d+|Product data sheet)|All information|©/i.test(
          lineText(lines[end]).trim(),
        )
      )
        break;
      return fail(
        "A table row contains unsupported edge/state/tri-state symbols, footnotes, or prose.",
      );
    }
    const cells = Array(names.length).fill(null);
    for (const token of row) {
      const center = token.x + token.width / 2;
      let column = centers.reduce(
        (best, value, index) =>
          Math.abs(value - center) < Math.abs(centers[best] - center)
            ? index
            : best,
        0,
      );
      if (cells[column] !== null)
        return fail("Multiple values map to one column.");
      cells[column] = token.text;
    }
    if (cells.some((cell) => cell === null))
      return fail(
        "Blank or merged cells need an explicit interpretation; no values were filled automatically.",
      );
    if (cells.some((cell) => /[HL]/.test(cell)) && !highLow)
      return fail("The table does not define H and L voltage levels.");
    if (cells.slice(0, split).includes("X") && !dontCare)
      return fail("X is not explicitly defined as a don't-care input.");
    if (cells.slice(split).includes("X"))
      return fail(
        "Unspecified outputs cannot become deterministic binary outputs.",
      );
    table.rows.push({
      inputs: cells
        .slice(0, split)
        .map((cell) =>
          cell === "X" ? null : ["H", "1"].includes(cell) ? 1 : 0,
        ),
      outputs: cells
        .slice(split)
        .map((cell) => (["H", "1"].includes(cell) ? 1 : 0)),
    });
  }
  if (!table.rows.length || table.rows.length > 32)
    return fail("A binary function table must contain 1–32 unambiguous rows.");
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
      return fail("The table does not define every binary input combination.");
    if (
      rows.some((row) =>
        row.outputs.some((value, index) => value !== rows[0].outputs[index]),
      )
    )
      return fail("Overlapping rows disagree about an output.");
    table.matrix.push([...rows[0].outputs]);
  }
  return { table, diagnostic: null };
}
export function readFunctionTables(document) {
  const tables = [],
    diagnostics = [];
  for (const page of document.pages) {
    if (!page.layoutLines) {
      if (/\b(?:function|truth)\s+table\b/i.test(page.text))
        diagnostics.push({
          page: page.number,
          reason: page.layoutError || "No positioned table text is available.",
        });
      continue;
    }
    let seen = 0;
    for (let index = 0; index < page.layoutLines.length; index++)
      if (caption.test(lineText(page.layoutLines[index]))) {
        // Table-of-contents entries lack a nearby grouped header and are diagnostics.
        const result = parse(page, index);
        if (result.table) tables.push(result.table);
        else diagnostics.push(result.diagnostic);
        if (++seen >= 32) break;
      }
  }
  return { tables, diagnostics };
}
