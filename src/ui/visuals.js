import { stateGraph } from "../visualization/state-graph.js";
import { flowFrame, valueBits } from "../visualization/flow.js";
import { escape, valueText } from "./values.js";
import { logicWave } from "./logic-wave.js";

export function statesView(model, trace, tick, focus) {
  const graph = stateGraph(model, trace, tick);
  if (!graph.nodes.length) return `<p>${escape(graph.scope)}</p>`;
  const selected =
    graph.nodes.find((n) => n.id === focus) ||
    graph.nodes.find((n) => n.id === graph.current) ||
    graph.nodes[0];
  const ranks = new Map([[graph.initial, 0]]),
    queue = [graph.initial];
  for (let i = 0; i < queue.length; i++)
    for (const edge of graph.edges.filter(
      (e) => e.from === queue[i] && e.to !== e.from,
    ))
      if (!ranks.has(edge.to)) {
        ranks.set(edge.to, ranks.get(edge.from) + 1);
        queue.push(edge.to);
      }
  const counts = new Map(),
    positions = new Map();
  for (const node of graph.nodes) {
    const rank = ranks.get(node.id) ?? 0,
      row = counts.get(rank) || 0;
    counts.set(rank, row + 1);
    positions.set(node.id, { x: 35 + rank * 205, y: 55 + row * 115 });
  }
  const width = Math.max(...[...positions.values()].map((p) => p.x)) + 195;
  const height = Math.max(...[...positions.values()].map((p) => p.y)) + 95;
  const edges = graph.edges
    .map((edge) => {
      const a = positions.get(edge.from),
        b = positions.get(edge.to),
        self = edge.from === edge.to;
      const path = self
        ? `M${a.x + 30},${a.y} C${a.x - 15},${a.y - 40} ${a.x + 155},${a.y - 40} ${a.x + 125},${a.y}`
        : `M${a.x + 155},${a.y + 30} C${a.x + 185},${a.y + 30} ${b.x - 30},${b.y + 30} ${b.x},${b.y + 30}`;
      return `<path class="fsm-edge ${edge.ticks.length ? "visited" : ""} ${edge.id === graph.selectedTransition ? "taken" : ""} ${edge.hold ? "hold" : ""}" d="${path}" marker-end="url(#fsm-arrow)"><title>${escape(edge.from + " → " + edge.to + ": " + edge.guard)} · ${edge.ticks.length} observed ticks</title></path>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((node) => {
      const p = positions.get(node.id);
      return `<g class="fsm-node ${node.id === graph.current ? "current" : ""} ${node.id === selected.id ? "focused" : ""}" transform="translate(${p.x},${p.y})" data-state="${escape(node.id)}" role="button" tabindex="0" aria-label="Inspect state ${escape(node.label)}${node.id === graph.current ? ", current" : ""}"><title>${escape(node.label)} · ${node.visits.length} snapshots${node.terminal ? " · terminal" : ""}</title><rect width="155" height="60" rx="${node.terminal ? 20 : 8}"/>${node.terminal ? '<rect x="4" y="4" width="147" height="52" rx="16"/>' : ""}<text x="77" y="24" text-anchor="middle">${escape(node.label.length > 18 ? node.label.slice(0, 16) + "…" : node.label)}</text><text class="fsm-caption" x="77" y="44" text-anchor="middle">${node.id === graph.current ? "CURRENT · " : ""}${node.id === graph.initial ? "initial · " : ""}${node.visits.length ? "visited" : "unvisited"}</text></g>`;
    })
    .join("");
  const rules = graph.edges.filter((e) => e.from === selected.id);
  return `<article class="visual-card"><h2>State machine · ${escape(model.name)}</h2><p>${escape(graph.scope)}. Current state: <strong>${escape(graph.current || "unavailable")}</strong>.</p><p class="hint">Click a state to inspect its rules. Solid arrows are transitions; dashed loops mean retention. Amber marks the observed transition at this tick.</p><div class="fsm-scroll"><svg class="fsm-svg" style="min-width:${width}px;width:${width}px;margin:auto" viewBox="0 0 ${width} ${height}" role="group" aria-label="State machine graph"><defs><marker id="fsm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="context-stroke"/></marker></defs>${edges}${nodes}</svg></div><div class="state-picker">${graph.nodes.map((n) => `<button data-state="${escape(n.id)}" aria-pressed="${n.id === selected.id}">${escape(n.label)}</button>`).join("")}</div><h3>Rules from ${escape(selected.label)}</h3>${selected.terminal ? "<p>Terminal state latches; externally driven inputs remain observable.</p>" : rules.map((edge) => `<div class="fsm-rule ${edge.id === graph.selectedTransition ? "taken" : ""}"><strong>${edge.priority ? "Priority " + edge.priority + " · " : ""}${escape(edge.from)} → ${escape(edge.to)}</strong><code>${escape(edge.guard)}</code>${edge.actions.length ? `<pre>${escape(edge.actions.join("\n"))}</pre>` : ""}${edge.evidence.length ? `<p>Evidence: ${escape(edge.evidence.join(", "))}</p>` : ""}<span>${edge.ticks.length} observed ticks</span>${edge.ticks.length ? `<button data-visual-tick="${edge.ticks[0]}">First observed: ${edge.ticks[0]}</button>` : ""}</div>`).join("")}</article>`;
}

const bitsMarkup = (bits, active = -1) =>
  `<span class="bit-word">${[...bits].map((bit, i) => `<span class="bit ${i === active ? "active" : ""}">${escape(bit)}</span>`).join("")}</span>`;
export function flowView(
  model,
  trace,
  tick,
  parameters,
  format,
  animate = false,
) {
  const frame = flowFrame(model, trace, tick, parameters);
  let body;
  if (frame.kind === "serial") {
    const payload = valueBits(frame.payload, frame.bits)
      .split("")
      .reverse()
      .join("");
    const received = Array.from({ length: frame.bits }, (_, i) =>
      i < frame.samples ? (frame.decoded >>> i) & 1 : "·",
    ).join("");
    body = `<p>LSB first: leftmost cell is bit 0. The highlighted bit is the sender’s current bit.</p><div class="flow-end"><strong>Sender · payload ${escape(valueText(frame.payload, format, frame.bits))}</strong>${bitsMarkup(payload, frame.bitIndex)}</div><div class="serial-channel ${frame.sampled && animate ? "capturing" : ""}"><span>DATA = ${escape(frame.data)} · CLK = ${escape(frame.clock)}</span><div class="flow-wire">${frame.sampled ? `<span class="moving-bit">${escape(frame.data)}</span>` : ""}<span class="flow-arrow">↓</span></div><strong>${frame.sampled ? "Rising edge: receiver captured bit " + (frame.samples - 1) : frame.launched ? "Sender presents this bit" : "Holding signals; no capture this tick"}</strong></div><div class="flow-end"><strong>Teaching receiver · ${frame.samples} / ${frame.bits} captured</strong>${bitsMarkup(received, frame.sampled ? frame.samples - 1 : -1)}<span>Decoded: ${escape(valueText(frame.decoded, format, frame.bits))} · ACK = ${escape(frame.ack)}</span></div><p class="hint">The receiver belongs to this teaching experiment. Animation follows recorded captures of both 0 and 1; its speed is cosmetic, not physical timing.</p>`;
  } else if (frame.kind === "assignments") {
    body = `<p>${escape(frame.message)}. These are model assignments, not inferred physical wiring.</p><ol class="flow-operations">${frame.operations.map((op) => `<li><span class="hint">${escape(op.stage)}</span><div class="assignment-flow"><div>${op.reads.length ? op.reads.map((read) => `<div><code>${escape(read.field)}</code> ${bitsMarkup(valueBits(read.value, read.width))} <span>${escape(valueText(read.value, format, read.width))}</span></div>`).join("") : "Literal expression"}</div><span class="assignment-arrow" aria-label="assigned to">→</span><div><code>${escape(op.target)}</code>${bitsMarkup(valueBits(op.after, op.width))}<span>${escape(valueText(op.before, format, op.width))} → ${escape(valueText(op.after, format, op.width))}</span></div></div></li>`).join("")}</ol>${frame.total > frame.operations.length ? `<p>First ${frame.operations.length} of ${frame.total} executed assignments shown.</p>` : ""}`;
  } else {
    body = `<p>${escape(frame.message)}</p>${(frame.changes || []).map((c) => `<p><code>${escape(c.id)}</code> ${escape(valueText(c.before, format, c.width))} → ${bitsMarkup(valueBits(c.after, c.width))} ${escape(valueText(c.after, format, c.width))}</p>`).join("") || "<p>No recorded assignments or value changes at this tick.</p>"}`;
  }
  return `<article class="visual-card"><h2>Bit flow · tick ${tick}</h2>${body}</article>`;
}

export function comparisonView(reference, current, report, tick, format) {
  if (!reference)
    return "<p>Capture a reference, then change parameters or input stimulus. You can also load a saved session or exported JSON trace.</p>";
  const delta = report.differences.find((d) => d.tick === tick),
    last = Math.max(report.ticks - 1, 1);
  const signals = new Map(
    [...reference.model.signals, ...current.model.signals].map((s) => [
      s.id,
      s,
    ]),
  );
  const x = (t) => 110 + (720 * t) / last;
  const waves = [...signals.values()]
    .map((signal, i) => {
      const top = 35 + i * 70;
      return [reference, current]
        .map((run, j) => {
          const declared = run.model.signals.find((s) => s.id === signal.id);
          const trace = run.trace.map((s) => ({
            ...s,
            signals: { [signal.id]: s.signals[signal.id] },
          }));
          const end = run.trace.at(-1).tick,
            y = top + j * 26;
          return declared
            ? logicWave(
                {
                  ...declared,
                  label: signal.id + " " + (j ? "current" : "ref"),
                },
                trace,
                { y, color: j ? "#7557a6" : "#078084", x, last: end },
              ) +
                (end < last
                  ? `<rect class="unavailable-range" x="${x(end)}" y="${y - 19}" width="${x(last) - x(end)}" height="23"/><text x="${x(end) + 3}" y="${y - 2}">unavailable</text>`
                  : "")
            : `<text x="0" y="${y}">${escape(signal.id)} ${j ? "current" : "ref"}: unavailable</text>`;
        })
        .join("");
    })
    .join("");
  const config = [
    ...report.parameterChanges.map((c) => [c.field, c.before, c.after]),
    ...report.inputChanges.map((c) => [
      "input event " + c.index,
      JSON.stringify(c.before),
      JSON.stringify(c.after),
    ]),
    ...(report.durationChange
      ? [
          [
            "duration",
            report.durationChange.before,
            report.durationChange.after,
          ],
        ]
      : []),
    ...report.widthChanges.map((c) => [c.field + " width", c.before, c.after]),
  ];
  const rows = (items) =>
    items
      .map(
        ([field, before, after]) =>
          `<tr><td>${escape(field)}</td><td>${escape(before ?? "unavailable")}</td><td>${escape(after ?? "unavailable")}</td></tr>`,
      )
      .join("");
  return `<article class="visual-card"><h2>${report.changedTicks} differing ticks · first: ${report.firstDifference ?? "none"}</h2><p>${escape(report.scope)}. Matching observations cover this experiment only.</p><p>Reference: ${escape(reference.label)} · ${escape(reference.origin || "captured")} · ${report.referenceTicks} snapshots<br>Current: ${escape(current.model.name)} · ${report.currentTicks} snapshots</p><div class="comparison-states"><span>Reference state: <strong>${escape(reference.trace[tick]?.state || "unavailable")}</strong></span><span>Current state: <strong>${escape(current.trace[tick]?.state || "unavailable")}</strong></span></div><div class="wave-scroll"><svg class="comparison-svg" viewBox="0 0 850 ${45 + signals.size * 70}" role="img" aria-label="Reference and current signals on a shared tick axis"><text x="110" y="13">0</text><text x="830" y="13" text-anchor="end">${last} normalized ticks</text>${waves}<line x1="${x(tick)}" x2="${x(tick)}" y1="17" y2="${40 + signals.size * 70}" stroke="#18394b" stroke-width="2"/></svg></div><h3>Differences at tick ${tick}</h3>${delta ? `<div class="table-scroll"><table class="register-table"><thead><tr><th>Field</th><th>Reference</th><th>Current</th></tr></thead><tbody>${rows(delta.changes.map((c) => [c.field, typeof c.before === "number" ? valueText(c.before, format) : c.before, typeof c.after === "number" ? valueText(c.after, format) : c.after]))}</tbody></table></div>` : "<p>Observed fields match at this tick.</p>"}<details ${config.length ? "open" : ""}><summary>Experiment settings and declaration differences (${config.length})</summary><div class="table-scroll"><table class="register-table"><thead><tr><th>Setting</th><th>Reference</th><th>Current</th></tr></thead><tbody>${rows(config)}</tbody></table></div></details></article>`;
}
