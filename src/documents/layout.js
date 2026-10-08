// Common geometry for Poppler words and PDF.js text items. Rows are retained
// on selected table pages; paragraph extraction remains unchanged.
export function positionedLines(items) {
  const words = items
    .filter(
      (item) =>
        typeof item.text === "string" &&
        item.text.trim() &&
        [item.x, item.y, item.width].every(Number.isFinite),
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const word of words) {
    let line = lines.at(-1);
    if (!line || Math.abs(line.y - word.y) > 2.5) {
      line = { y: word.y, cells: [] };
      lines.push(line);
    }
    line.cells.push({ text: word.text, x: word.x, width: word.width });
  }
  for (const line of lines) line.cells.sort((a, b) => a.x - b.x);
  return lines;
}
const entity = (text) =>
  text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (match) => {
    const fixed = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
    };
    if (fixed[match]) return fixed[match];
    const code = match.startsWith("&#x")
      ? parseInt(match.slice(3, -1), 16)
      : Number(match.slice(2, -1));
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
export function popplerLines(xml) {
  const words = [];
  for (const match of xml.matchAll(/<word\b([^>]*)>([^<]*)<\/word>/g)) {
    const attributes = Object.fromEntries(
      Array.from(match[1].matchAll(/(xMin|yMin|xMax|yMax)="([^"]+)"/g), (m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    words.push({
      text: entity(match[2]),
      x: attributes.xMin,
      y: attributes.yMax,
      width: attributes.xMax - attributes.xMin,
    });
  }
  return positionedLines(words);
}
export const hasFunctionTable = (text) =>
  /\b(?:function|truth)\s+table\b/i.test(text);
export const hasTableLayout = (text) =>
  hasFunctionTable(text) ||
  /\bPin\s+Functions\b/i.test(text) ||
  /\bTable\s+[\w.-]+\s+Pin\s+description\b/i.test(text);

export const hasRegisterTable = (text) =>
  /\bTable\s+[\w.-]+\.\s*(?:Command Byte(?: Table)?|Register Map)\b/i.test(
    text.replace(/\s+/g, " "),
  );
