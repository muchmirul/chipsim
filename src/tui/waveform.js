import { display } from "./text.js";

// A column covers an interval of the trace, not just its first sample.
// Mixed columns preserve evidence of pulses/value changes when zoomed out.
export function signalCells(trace, id, { width, offset, zoom }) {
  return Array.from({ length: width }, (_, col) => {
    const first = Math.floor(offset + col / zoom),
      last = Math.min(
        trace.length - 1,
        Math.ceil(offset + (col + 1) / zoom) - 1,
      );
    if (first < 0 || first >= trace.length) return { kind: "empty" };
    const value = trace[first].signals[id] ?? undefined;
    for (let tick = first + 1; tick <= last; tick++)
      if ((trace[tick].signals[id] ?? undefined) !== value)
        return { kind: "mixed" };
    return { kind: "value", value };
  });
}

// All glyphs/value labels here occupy one terminal cell. Labels are complete
// values or an ellipsis; neither a segment boundary nor the cursor overwrites
// a numeric label. Exact cursor values are displayed separately by the view.
export function signalRows(trace, signal, options) {
  const { width, cursor, format } = options,
    cells = signalCells(trace, signal.id, options),
    lines = Array.from({ length: 3 }, () => Array(width).fill(" ")),
    [top, middle, bottom] = lines;
  const same = (a, b) => a?.kind === b?.kind && a?.value === b?.value;
  for (let col = 0; col < width; col++) {
    const cell = cells[col],
      previous = cells[col - 1];
    if (cell.kind === "empty") continue;
    if (cell.kind === "mixed") {
      top[col] = bottom[col] = "╎";
      middle[col] = "≋";
      continue;
    }
    const value = cell.value,
      changed = col > 0 && !same(cell, previous) && previous.kind !== "empty";
    if (value === "Z" || value === undefined) middle[col] = "·";
    else if (signal.width === 1) {
      top[col] = value ? "─" : changed ? "┐" : " ";
      bottom[col] = value ? (changed ? "┘" : " ") : "─";
      if (changed && value) top[col] = "┌";
      if (changed && !value) bottom[col] = "└";
      middle[col] = changed ? "│" : " ";
    } else {
      top[col] = changed ? "┬" : "─";
      bottom[col] = changed ? "┴" : "─";
      if (changed) middle[col] = "│";
    }
  }
  for (let start = 0; start < width;) {
    let end = start + 1;
    while (end < width && same(cells[start], cells[end])) end++;
    const cell = cells[start];
    if (
      cell.kind === "value" &&
      (signal.width > 1 || cell.value === "Z" || cell.value === undefined)
    ) {
      // Keep the boundary glyph and at least one space before the next run.
      const left = start + Number(middle[start] === "│"),
        right = end - Number(end < width && end - left > 1),
        gaps =
          cursor >= left && cursor < right
            ? [
                [left, cursor],
                [cursor + 1, right],
              ]
            : [[left, right]];
      const [from, to] = gaps.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0],
        available = to - from,
        full =
          cell.value === undefined
            ? "x"
            : display(cell.value, format, signal.width),
        compact =
          cell.value === undefined ? "x" : display(cell.value, format, 1),
        label =
          full.length <= available
            ? full
            : compact.length <= available
              ? compact
              : "…";
      if (available > 0)
        for (let n = 0; n < label.length; n++) middle[from + n] = label[n];
    }
    start = end;
  }
  for (const line of lines)
    if (cursor >= 0 && cursor < width) line[cursor] = "┃";
  if (cursor >= 0 && cursor < width) {
    const cell = cells[cursor];
    if (cell.kind === "mixed") middle[cursor] = "≋";
    else if (
      cell.kind === "value" &&
      (cell.value === undefined || cell.value === "Z")
    )
      middle[cursor] = cell.value === "Z" ? "Z" : "x";
  }
  return lines.map((line) => line.join(""));
}
