import { formatPayload } from "../core/values.js";
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const valueText = (value, format, width = 8) =>
  typeof value === "number" && value >= 0
    ? formatPayload(value, format, width)
    : String(value);
export function diagram(model, snapshot, format) {
  const nodes = model.topology.nodes.map((n, i) => ({
    ...n,
    x: n.x ?? 20 + (i % 3) * 210,
    y: n.y ?? 20 + Math.floor(i / 3) * 105,
    w: n.w ?? 180,
    h: n.h ?? 76,
  }));
  const w = Math.max(...nodes.map((n) => n.x + n.w)) + 20,
    h = Math.max(...nodes.map((n) => n.y + n.h)) + 20;
  const active = new Set(snapshot.active),
    byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = model.topology.edges
    .map(([a, b]) => {
      const from = byId.get(a),
        to = byId.get(b);
      return `<path class="wire ${active.has(a) && active.has(b) ? "active" : ""}" d="M${from.x + from.w / 2},${from.y + from.h / 2} L${to.x + to.w / 2},${to.y + to.h / 2}"/>`;
    })
    .join("");
  return `<svg class="hardware-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(model.name)} architecture and active resources">${edges}${nodes
    .map((n) => {
      const fields = [
        ...(n.registers || []).map(
          (id) =>
            id +
            "=" +
            valueText(
              snapshot.registers[id],
              format,
              model.registers?.find((r) => r.id === id)?.width,
            ),
        ),
        ...(n.signals || []).map((id) => id + "=" + snapshot.signals[id]),
      ];
      const values = snapshot.values[n.id] || [
        fields.slice(0, 2).join(" "),
        n.note || "",
      ];
      return `<g class="node ${escape(n.kind || "")} ${active.has(n.id) ? "active" : ""}" transform="translate(${n.x},${n.y})"><title>${escape([n.label || n.id, ...values].join(" · "))}</title><rect width="${n.w}" height="${n.h}" rx="7"/><text class="title" x="10" y="20">${escape(n.label || n.id)}</text><text class="value" x="10" y="40">${escape(values[0])}</text><text class="note" x="10" y="57">${escape(values[1])}</text></g>`;
    })
    .join("")}</svg>`;
}
export function waveform(model, trace, tick) {
  const width = 900,
    left = 75,
    right = 875,
    rows = model.signals.length,
    height = 30 + rows * 37,
    last = trace.at(-1).tick || 1;
  const x = (t) => left + ((right - left) * t) / last;
  const marks = Array.from({ length: 9 }, (_, i) => {
    const t = Math.round((last * i) / 8);
    return `<line x1="${x(t)}" x2="${x(t)}" y1="18" y2="${height - 10}" stroke="#edf1f4"/><text x="${x(t)}" y="11" text-anchor="middle">${t}</text>`;
  }).join("");
  const signals = model.signals
    .map((signal, i) => {
      const y = 36 + i * 37,
        color = ["#078084", "#7557a6", "#ae741c"][i % 3];
      if (signal.width === 1) {
        let path = `M${x(0)} ${y - trace[0].signals[signal.id] * 15}`;
        for (let j = 1; j < trace.length; j++)
          path += ` H${x(trace[j].tick)} V${y - trace[j].signals[signal.id] * 15}`;
        return `<text x="0" y="${y - 4}">${escape(signal.label || signal.id)}</text><path class="signal" stroke="${color}" d="${path}"/>`;
      }
      const boundaries = trace.filter(
        (s, j) =>
          !j || s.signals[signal.id] !== trace[j - 1].signals[signal.id],
      );
      return `<text x="0" y="${y - 4}">${escape(signal.label || signal.id)}</text><line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${color}"/>${boundaries.map((s) => `<text x="${x(s.tick) + 2}" y="${y - 7}">${escape(formatPayload(s.signals[signal.id], "hex", signal.width))}</text>`).join("")}`;
    })
    .join("");
  return `<div class="wave-card"><div class="card-bar"><h3>${escape(model.name)} · Signals</h3><span class="hint">Full trace · normalized ticks · cursor ${tick}</span></div><div class="wave-scroll"><svg class="wave-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Signal waveform for ${escape(model.name)}">${marks}${signals}<rect x="${x(tick)}" y="18" width="${Math.max(0, right - x(tick))}" height="${height - 26}" fill="#fff" opacity=".5"/><line x1="${x(tick)}" x2="${x(tick)}" y1="17" y2="${height - 9}" stroke="#18394b" stroke-width="1.5"/></svg></div></div>`;
}
export function inspect(model, snapshot, parameters, format) {
  const fields = [
    ...Object.entries(snapshot.signals).map(([id, value]) => ({
      id,
      value,
      width: model.signals.find((s) => s.id === id).width,
      kind: "signals",
    })),
    ...Object.entries(snapshot.registers).map(([id, value]) => ({
      id,
      value,
      width: model.registers?.find((r) => r.id === id)?.width || 32,
      kind: "registers",
    })),
  ];
  const lines = model.recipe(parameters);
  return `<article class="inspect-card"><header class="card-bar"><span>${escape(model.name)}</span><span class="status ${escape(snapshot.phase)}">${escape(snapshot.phase)}${snapshot.state === snapshot.phase ? "" : " · " + escape(snapshot.state)}</span></header><div class="inspect-content"><div class="diagram-panel">${diagram(model, snapshot, format)}<div class="diagram-legend"><span><i></i>Active this tick</span><span><i class="config"></i>Configuration</span></div></div><div class="register-panel"><h3>Signals & registers</h3><div class="register-scroll"><table class="register-table"><tbody>${fields.map((f) => `<tr class="${snapshot.changes.some((c) => c.kind === f.kind && c.id === f.id) ? "changed" : ""}"><td>${escape(f.id)}</td><td>${escape(valueText(f.value, format, f.width))}</td></tr>`).join("")}</tbody></table></div></div></div><div class="current-event">${escape(snapshot.message || "Hold state")}<small>${escape(snapshot.detail)}</small></div><details class="recipe-details"><summary>${model.kind === "builtin" ? "Implementation recipe" : "Model states"} · semantic operations</summary><pre>${lines.map((line, i) => `<span class="recipe-line ${i === snapshot.recipeLine ? "active" : ""}">${escape(line)}</span>`).join("")}</pre></details></article>`;
}
export function logRows(runs, tick, changesOnly, filter, format) {
  const entries = runs
    .flatMap(({ model, trace }) =>
      trace
        .filter((s) => s.tick <= tick)
        .map((snapshot) => ({ model, snapshot })),
    )
    .sort((a, b) => a.snapshot.tick - b.snapshot.tick);
  const matching = entries.filter(
    ({ model, snapshot: s }) =>
      (!changesOnly ||
        s.changes.length ||
        ["fault", "timeout"].includes(s.phase)) &&
      `${model.name} ${s.state} ${s.message} ${s.changes.map((c) => c.id).join(" ")}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const visible = matching.slice(-500);
  return {
    count: `${matching.length} rows${matching.length > 500 ? " · latest 500 shown" : ""}`,
    html: `<table class="log-table"><thead><tr><th>Tick</th>${runs.length > 1 ? "<th>Model</th>" : ""}<th>State</th><th>Event</th><th>Changes</th></tr></thead><tbody>${visible.map(({ model, snapshot: s }) => `<tr data-tick="${s.tick}" tabindex="0" class="${s.tick === tick ? "current" : ""}"><td>${s.tick}</td>${runs.length > 1 ? `<td>${escape(model.name)}</td>` : ""}<td>${escape(s.state)}</td><td>${escape(s.message || "Hold")} ${s.evidence.length ? `<span class="evidence-link">[${escape(s.evidence.join(", "))}]</span>` : ""}</td><td class="log-delta">${s.changes.map((c) => `${escape(c.id)}: ${escape(c.before === null ? "—" : valueText(c.before, format))} → ${escape(valueText(c.after, format))}`).join("<br>")}</td></tr>`).join("")}</tbody></table>`,
  };
}
