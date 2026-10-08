import { formatPayload } from "../core/values.js";
export const clean = (text) =>
  String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text) =>
  Array.from(segments.segment(clean(text)), (item) => item.segment);
const cellWidth = (text) => {
  const code = text.codePointAt(0);
  if (/^[\p{Mark}\u200d\u200b]+$/u.test(text)) return 0;
  if (
    /\p{Extended_Pictographic}/u.test(text) ||
    /[\u{1f1e6}-\u{1f1ff}]/u.test(text)
  )
    return 2;
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd))
    ? 2
    : 1;
};
export const displayWidth = (text) =>
  graphemes(text).reduce((width, part) => width + cellWidth(part), 0);
export const clip = (text, width) => {
  const parts = graphemes(text);
  if (parts.reduce((sum, part) => sum + cellWidth(part), 0) <= width)
    return parts.join("");
  let result = "",
    used = 0;
  for (const part of parts) {
    const size = cellWidth(part);
    if (used + size > width - 1) break;
    result += part;
    used += size;
  }
  return width > 0 ? result + "…" : "";
};
export const pad = (text, width) => {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
};
export const display = (value, format, width = 8) =>
  typeof value === "number" && value >= 0
    ? formatPayload(value, format, width)
    : String(value ?? "—");

// Preserve complete content, including long identifiers and wide characters.
// Wrapping never truncates a source quotation or a numeric value.
export function wrapText(text, width) {
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of clean(paragraph).split(/\s+/)) {
      if (!word) continue;
      if (line && displayWidth(line + " " + word) <= width) {
        line += " " + word;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const part of graphemes(word)) {
        if (displayWidth(line) + cellWidth(part) > width && line) {
          lines.push(line);
          line = "";
        }
        line += part;
      }
    }
    lines.push(line);
  }
  return lines;
}
