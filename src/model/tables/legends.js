// Complete numbered symbol legends are supported; timing/prose footnotes are
// deliberately not stripped from table semantics.
const definition =
  /^(?:H\s*=\s*(?:High(?: Voltage Level)?|Driving High)|L\s*=\s*(?:Low(?: Voltage Level)?|Driving Low)|X\s*=\s*(?:Don['’]t|Do not) Care|Z\s*=\s*High[- ]Impedance (?:OFF-state|State))\.?$/i;
export function numberedLegend(text) {
  const match = /^\((\d{1,2})\)\s+([HLXZ]\s*=.*)$/.exec(text);
  if (!match) return null;
  return {
    marker: match[1],
    valid: match[2].split(/[,;]/).every((part) => definition.test(part.trim())),
  };
}
export const impedanceQuote = (text) =>
  /\bZ\s*=\s*High[- ]Impedance (?:OFF-state|State)\b/i.exec(text)?.[0];
