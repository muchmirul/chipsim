import { numberedLegend, plainLegend } from "./legends.js";
const normalized = (text) => text.replace(/\s+/g, " ").trim();
const caption =
  /\b(?:Table\s+([\w.-]+)[.:]?\s*)?((?:function|truth)\s+table)\b/i;
const tokens = (line) =>
  line.cells
    .flatMap((cell) => {
      const text = cell.text;
      return Array.from(text.matchAll(/\S+/g), (match) => ({
        text: match[0],
        group: cell,
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
const boundary =
  /^(?:\d+(?:\.\d+)*\.?\s+[A-Za-z]|Table\s+\d+|Rev\.\d|Product data sheet|Product Folder Links:|Copyright\b|www\.)|All information|©/i;
function parseLayout(page, start, ordinal) {
  const lines = page.layoutLines,
    heading = lineText(lines[start]),
    match = caption.exec(heading);
  const table = {
    page: page.number,
    number: match[1] || "u" + ordinal,
    caption: normalized(heading),
    inputs: [],
    outputs: [],
    rawRows: [],
  };
  const fail = (reason) => ({
    table: null,
    diagnostic: { page: page.number, caption: table.caption, reason },
  });
  const markers = new Set(),
    notes = new Set();
  const header = (line) =>
    tokens(line).flatMap((word) => {
      const annotation = /\((\d{1,2})\)$/.exec(word.text);
      if (!annotation) return [word];
      markers.add(annotation[1]);
      const text = word.text.slice(0, annotation.index);
      return text ? [{ ...word, text }] : [];
    });
  let group = -1;
  for (
    let index = start + 1;
    index < Math.min(lines.length, start + 12);
    index++
  ) {
    const words = header(lines[index]);
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
  let groups = header(lines[group]);
  const modeColumn = /^Operating modes /i.test(lineText(lines[group]));
  if (modeColumn)
    groups = groups.filter((word) => !/^(?:Operating|modes)$/i.test(word.text));
  const left = modeColumn
    ? Math.min(...groups.map((word) => word.x)) - 2
    : -Infinity;
  const output = groups.find((word) => /^Outputs?$/i.test(word.text));
  let names, split, rowStart;
  if (
    groups.every((word) => /^(?:Inputs?|Outputs?|Control)$/i.test(word.text))
  ) {
    let nameLine = group + 1;
    while (nameLine < lines.length && !header(lines[nameLine]).length)
      nameLine++;
    names = header(lines[nameLine] || { cells: [] }).filter(
      (word) => word.x >= left,
    );
    // Explicit two-word headings such as "Enable G" are one label, with
    // whitespace joined for the model identifier. Do not fill unnamed cells.
    const compound = (word, next) =>
      next &&
      /^(?:Enable|Clock|Reset)$/.test(word.text) &&
      signalName.test(next.text) &&
      (word.group === next.group ||
        next.x - word.x - word.width <=
          Math.max(2, (word.width / word.text.length) * 0.8));
    names = names.flatMap((word, index, words) => {
      if (index && compound(words[index - 1], word)) return [];
      if (compound(word, words[index + 1])) {
        const next = words[index + 1];
        return [
          {
            ...word,
            text: word.text + next.text,
            width: next.x + next.width - word.x,
          },
        ];
      }
      return [word];
    });
    split = names.findIndex((name) => name.x + name.width / 2 >= output.x - 2);
    rowStart = nameLine + 1;
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
  table.legend = normalized(lines.slice(start, group).map(lineText).join(" "));
  for (let index = rowStart; index < lines.length; index++) {
    const text = lineText(lines[index]).trim();
    const row = tokens(lines[index]).filter((word) => word.x >= left);
    if (plainLegend(text)) {
      if (!table.rawRows.length)
        return fail("A legend occurs before any table rows.");
      let note = index;
      for (; note < Math.min(lines.length, index + 8); note++) {
        const definition = normalized(lineText(lines[note]));
        const parsed = plainLegend(definition);
        if (!parsed) break;
        if (!parsed.valid)
          return fail("Symbol definitions must be complete and unqualified.");
        table.legend += " " + definition;
      }
      if (note < lines.length && !boundary.test(lineText(lines[note]).trim()))
        return fail("Continued or additional legend text requires review.");
      break;
    }
    if (/^\(\d{1,2}\)\s+[HLXZ]\s*=/.test(text)) {
      if (!table.rawRows.length)
        return fail("A legend occurs before any table rows.");
      // Only adjacent, complete numbered symbol-definition lines are accepted.
      // Footnotes with timing qualifications or continued text require review.
      let note = index;
      for (; note < Math.min(lines.length, index + 8); note++) {
        const definition = normalized(lineText(lines[note]));
        const parsed = numberedLegend(definition);
        if (!parsed) break;
        if (!parsed.valid)
          return fail(
            "Numbered symbol footnotes must contain complete, unqualified definitions.",
          );
        notes.add(parsed.marker);
        table.legend += " " + definition;
      }
      if (note < lines.length && !boundary.test(lineText(lines[note]).trim()))
        return fail("Continued or additional footnote text requires review.");
      break;
    }
    // Pure binary rows may start with a digit. Test the section delimiter only
    // when the row contains words beyond the supported cell vocabulary.
    if (
      (!row.length ||
        !row.every((word) =>
          /^(?:[HLhlXZ01↑↓]|no|change)$/i.test(word.text),
        )) &&
      boundary.test(text)
    )
      break;
    if (!row.length) continue;
    const cells = Array.from({ length: names.length }, () => []);
    for (const token of row) {
      const center = token.x + token.width / 2;
      const column = centers.reduce(
        (best, value, index) =>
          Math.abs(value - center) < Math.abs(centers[best] - center)
            ? index
            : best,
        0,
      );
      cells[column].push(token.text);
    }
    if (cells.some((values) => !values.length))
      return fail(
        "Blank or merged cells need an explicit interpretation; no values were filled automatically.",
      );
    if (
      cells.some(
        (values, index) =>
          values.length > 1 &&
          !(index >= split && /^no change$/i.test(values.join(" "))),
      )
    )
      return fail("Multiple values map to one column.");
    table.rawRows.push({
      inputs: cells.slice(0, split).map((values) => values.join(" ")),
      outputs: cells.slice(split).map((values) => values.join(" ")),
    });
    if (table.rawRows.length > 32)
      return fail("A function table must contain 1–32 unambiguous rows.");
  }
  if (!table.rawRows.length)
    return fail("A function table must contain 1–32 unambiguous rows.");
  if ([...markers].some((marker) => !notes.has(marker)))
    return fail(
      "A header footnote has no complete local symbol definition; review required.",
    );
  return { table, diagnostic: null };
}
export function readTableLayouts(document) {
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
        const result = parseLayout(page, index, seen + 1);
        if (result.table) tables.push(result.table);
        else diagnostics.push(result.diagnostic);
        if (++seen >= 32) break;
      }
  }
  return { tables, diagnostics };
}
