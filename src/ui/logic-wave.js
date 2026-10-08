import { escape, valueText } from "./values.js";
export function logicWave(signal, trace, { y, color, x, last }) {
  const boundaries = trace.filter(
    (s, j) => !j || s.signals[signal.id] !== trace[j - 1].signals[signal.id],
  );
  const segments = boundaries
    .map((s, index) => {
      const value = s.signals[signal.id],
        end = boundaries[index + 1]?.tick ?? last,
        level =
          value === "Z" ? y - 7.5 : signal.width === 1 ? y - value * 15 : y,
        previous = boundaries[index - 1]?.signals[signal.id];
      const join =
        index && value !== "Z" && previous !== "Z" && signal.width === 1
          ? `<path class="signal" stroke="${color}" d="M${x(s.tick)} ${y - previous * 15} V${level}"/>`
          : "";
      return `${join}<g><title>${escape(signal.label || signal.id)}: ${escape(valueText(value, "hex", signal.width))}${value === "Z" ? " · high impedance" : ""}, ticks ${s.tick}–${end}</title><line class="signal ${value === "Z" ? "high-impedance" : ""}" stroke="${color}" x1="${x(s.tick)}" x2="${x(end)}" y1="${level}" y2="${level}" ${value === "Z" ? 'stroke-dasharray="4 3"' : ""}/>${value === "Z" || signal.width > 1 ? `<text x="${x(s.tick) + 2}" y="${level - 3}">${escape(valueText(value, "hex", signal.width))}</text>` : ""}</g>`;
    })
    .join("");
  return `<text x="0" y="${y - 4}">${escape(signal.label || signal.id)}</text>${segments}`;
}
