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

// Some publishers put complete, unnumbered definitions below the rows.
// Keep qualifications and continued prose out of this narrow syntax.
export function plainLegend(text) {
  if (!/^[HLX]\s*[:=]/.test(text)) return null;
  return {
    valid:
      /^(?:H\s*[:=]\s*High(?: Voltage)? Level|L\s*[:=]\s*Low(?: Voltage)? Level|X\s*[:=]\s*(?:Irrelevant|(?:Don['’]t|Do not) Care))\.?$/i.test(
        text,
      ),
  };
}
export function levelSymbols(text) {
  return {
    highLow:
      (/\bH\s*=\s*HIGH\b/i.test(text) && /\bL\s*=\s*LOW\b/i.test(text)) ||
      (/\bH\s*:\s*High(?: Voltage)? Level\b/i.test(text) &&
        /\bL\s*:\s*Low(?: Voltage)? Level\b/i.test(text)),
    dontCare: /\bX\s*[:=]\s*(?:(?:don['’]t|do not)\s+care|irrelevant)\b/i.test(
      text,
    ),
  };
}
