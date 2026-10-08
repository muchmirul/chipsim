export function clockMask(cell) {
  if (!/^[HL01↑↓](?:\s*,\s*[HL01↑↓]){1,3}$/.test(cell)) return null;
  const parts = cell.split(/\s*,\s*/),
    codes = parts.map(
      (part) => ({ L: 0, 0: 0, H: 3, 1: 3, "↑": 1, "↓": 2 })[part],
    );
  if (new Set(codes).size !== codes.length)
    throw new Error("Clock alternatives repeat a level or transition.");
  return codes.reduce((mask, code) => mask | (1 << code), 0);
}
export function matchesClock(mask, previous, current) {
  return !!(mask & (1 << (previous * 2 + current)));
}
export const isClockMask = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  Number.isInteger(value.clock) &&
  value.clock >= 1 &&
  value.clock <= 15;
export function isClockAlternatives(value) {
  try {
    return typeof value === "string" && clockMask(value) !== null;
  } catch {
    return false;
  }
}
export function clockPinMatches(description, edges) {
  return (
    /\bclock\b/i.test(description) &&
    !/\b(?:not|non|unless|except|conditional|depending|select)\b/i.test(
      description,
    ) &&
    /\bedge[- ]trigger(?:ed)?\b/i.test(description) &&
    edges.every((edge) =>
      (edge === "rise"
        ? /LOW-to-HIGH|rising edge/i
        : /HIGH-to-LOW|falling edge/i
      ).test(description),
    )
  );
}
