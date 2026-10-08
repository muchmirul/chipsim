import { numberedLegend } from "./legends.js";

// Join bounded, geometrically indented wraps, then validate the entire note.
// Additional timing/qualification prose remains part of the note and rejects.
export function numberedNotes(lines, start, text, boundary) {
  const definitions = [],
    markers = [];
  let index = start;
  for (let count = 0; count < 8 && index < lines.length; count++) {
    if (!/^\(\d{1,2}\)\s+/.test(text(lines[index]))) break;
    const first = lines[index],
      content = first.cells.find((cell) => !/^\(\d{1,2}\)$/.test(cell.text)),
      parts = [text(first)];
    index++;
    for (let wrap = 0; wrap < 3 && index < lines.length; wrap++) {
      const next = lines[index],
        value = text(next);
      if (/^\(\d{1,2}\)\s+/.test(value) || boundary.test(value)) break;
      if (
        !content ||
        next.y - lines[index - 1].y > 16 ||
        Math.abs(next.cells[0]?.x - content.x) > 2
      )
        throw new Error(
          "Continued or additional footnote text requires review.",
        );
      parts.push(value);
      index++;
    }
    const definition = parts.join(" "),
      parsed = numberedLegend(definition);
    if (!parsed?.valid)
      throw new Error(
        "Numbered symbol footnotes must contain complete, unqualified definitions.",
      );
    definitions.push(definition);
    markers.push(parsed.marker);
  }
  if (index < lines.length && !boundary.test(text(lines[index])))
    throw new Error("Continued or additional footnote text requires review.");
  return { definitions, markers };
}
