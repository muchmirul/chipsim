import { pad, display } from "./text.js";
import { signalRows } from "./waveform.js";
import { timeLabel } from "../hdl/time.js";
import { debugHardwareItems, debugSignalItems } from "./debug-state.js";

const row = (text = "", style = "") => ({ text, style });
const fill = (lines, width, height) =>
  Array.from({ length: height }, (_, i) => ({
    ...lines[i],
    text: pad(lines[i]?.text || "", width),
    style: lines[i]?.style || "",
  }));
const names = {
  source: "HDL SOURCE",
  hardware: "RTL HARDWARE",
  signals: "SIGNALS",
};

export function debugHeader(state) {
  const data = state.hdlDebug.data,
    event = data.events[state.tick];
  return (
    `${data.status.complete ? "complete" : "PARTIAL"} · run ${data.run.id.slice(0, 8)} · e${event?.seq ?? "—"}/${Math.max(0, data.events.length - 1)} · ` +
    (event
      ? `${timeLabel(event.time, data.timescale)}${event.delta === undefined ? "" : " Δ" + event.delta} · ${event.phase || "phase unreported"} · ${event.kind}`
      : "no simulation events") +
    ` · ${state.playing ? "REPLAY" : "paused"}`
  );
}

function title(ctx, pane) {
  return row(
    `${ctx.ui.focus === pane ? "◆" : "◇"} ${names[pane]} · e${ctx.snapshot.eventIndex ?? "—"}`,
    ctx.ui.focus === pane ? "selected" : "dim",
  );
}
function sourceRows(ctx, width, height) {
  const { debug, snapshot, ui } = ctx,
    event = snapshot.event;
  const execution =
    event?.kind === "process" ? debug.objects.get(event.process) : null;
  const source = debug.sources.get(ui.sourceFile);
  const location = execution?.source;
  const sameFile = location?.file === source?.id;
  const content = source?.text.split("\n") || [];
  const capacity = Math.max(1, height - 2);
  const first = Math.max(
    1,
    Math.min(
      Math.max(1, content.length - capacity + 1),
      ui.sourceLine - Math.floor(capacity / 2),
    ),
  );
  const lines = [
    title(ctx, "source"),
    row(
      source
        ? ui.follow && execution
          ? `${execution.label} · ${source.path}:${ui.sourceLine}${location?.column ? ":" + location.column : ""}`
          : `${source.path}:${ui.sourceLine} · ${ui.follow ? "context; no activation" : "BROWSE"}`
        : "No source location recorded for this event.",
      "dim",
    ),
  ];
  if (!source)
    lines.push(
      row(
        execution?.label || event?.message || "Open a debug recording with H.",
      ),
    );
  for (
    let line = first;
    line < first + capacity && line <= content.length;
    line++
  ) {
    const executed = sameFile && line === location.line;
    lines.push(
      row(
        `${executed ? "▶" : " "}${line === ui.sourceLine ? "›" : " "}${String(line).padStart(4)} ${content[line - 1]}`,
        executed ? "event" : line === ui.sourceLine ? "selected" : "",
      ),
    );
  }
  return fill(lines, width, height);
}

function objectText(ctx, obj, short = false) {
  const scopePath = ctx.debug.objects.get(ctx.ui.scope)?.path;
  const path = obj.path || obj.label;
  const label =
    short && scopePath && path.startsWith(scopePath + ".")
      ? path.slice(scopePath.length + 1)
      : obj.label;
  const value = obj.observed
    ? " = " +
      display(
        ctx.snapshot.signals[obj.id],
        ctx.state.format,
        obj.width,
        obj.signed,
      )
    : "";
  return label + value;
}
function hardwareRows(ctx, width, height) {
  const { state, debug, snapshot, ui } = ctx;
  const items = debugHardwareItems(state);
  const scope = debug.objects.get(ui.scope);
  const focus = debug.objects.get(ui.selection);
  const links = debug.data.design.connections.filter(
    (e) => e.from === focus?.id || e.to === focus?.id,
  );
  const reserve = height >= 9 ? Math.min(4, links.length + 1) : 1;
  const capacity = Math.max(1, height - 2 - reserve);
  const selected = Math.max(
    0,
    items.findIndex((o) => o.id === ui.selection),
  );
  const first = Math.max(
    0,
    Math.min(items.length - capacity, selected - Math.floor(capacity / 2)),
  );
  const lines = [
    title(ctx, "hardware"),
    row(scope?.path || "Elaborated design", "dim"),
  ];
  for (const obj of items.slice(first, first + capacity)) {
    const active = snapshot.executed?.includes(obj.id),
      changed = snapshot.changed?.includes(obj.id);
    const mark = active ? "▶" : changed ? "*" : " ";
    const type =
      obj.kind === "instance"
        ? {
            1: "[function]",
            2: "[task]",
            3: "[begin]",
            4: "[fork]",
            5: "[generate]",
            6: "[package]",
            7: "[class]",
          }[obj.scopeType] || "[block]"
        : obj.kind === "process"
          ? "[proc]"
          : obj.kind === "operation"
            ? "[op]"
            : obj.kind === "port"
              ? `[${obj.direction}]`
              : obj.variable
                ? "[var]"
                : "[net]";
    lines.push(
      row(
        `${ui.selection === obj.id ? "›" : " "}${mark} ${type} ${objectText(ctx, obj, true)}`,
        active
          ? "event"
          : ui.selection === obj.id
            ? "selected"
            : changed
              ? "success"
              : "",
      ),
    );
  }
  if (height >= 9) {
    lines.push(row("Static connections · ▶ executed · * changed", "dim"));
    for (const edge of links.slice(0, reserve - 1)) {
      const from = debug.objects.get(edge.from),
        to = debug.objects.get(edge.to);
      lines.push(
        row(
          `${objectText(ctx, from, true)} ─${edge.kind}→ ${objectText(ctx, to, true)}`,
          "dim",
        ),
      );
    }
  } else lines.push(row("▶ executed · * changed · Enter links", "dim"));
  return fill(lines, width, height);
}

function signalsRows(ctx, width, height) {
  const { state, snapshot } = ctx;
  const signals = debugSignalItems(state);
  const count = Math.max(1, Math.floor((height - 3) / 3));
  const selected = Math.max(
    0,
    signals.findIndex((s) => s.id === state.signal?.id),
  );
  const first = Math.max(
    0,
    Math.min(signals.length - count, selected - Math.floor(count / 2)),
  );
  const labelWidth = Math.min(28, Math.floor(width * 0.34));
  const plotWidth = Math.max(1, width - labelWidth - 1);
  // A resize or a different pane width must keep the shared cursor visible.
  const offset = Math.min(
    state.tick,
    Math.max(
      state.offset,
      state.tick - Math.floor((plotWidth - 1) / state.zoom),
    ),
  );
  const cursor = Math.floor((state.tick - offset) * state.zoom);
  const ruler = Array(plotWidth).fill(" ");
  for (
    let col = 0;
    col < plotWidth;
    col += Math.max(8, Math.floor(plotWidth / 6))
  ) {
    const label = String(Math.floor(offset + col / state.zoom));
    if (col + label.length > plotWidth) continue;
    for (let i = 0; i < label.length; i++) ruler[col + i] = label[i];
  }
  const lines = [
    title(ctx, "signals"),
    row(pad("EVENT ORDER →", labelWidth + 1) + ruler.join(""), "dim"),
  ];
  for (const signal of signals.slice(first, first + count)) {
    const chosen = state.signal?.id === signal.id;
    const [top, middle, bottom] = signalRows(state.trace, signal, {
      width: plotWidth,
      offset,
      zoom: state.zoom,
      cursor,
      format: state.format,
    });
    const label = (signal.path || signal.label).split(".").at(-1);
    const value = display(
      snapshot.signals[signal.id],
      state.format,
      signal.width,
      signal.signed,
    );
    const style = chosen ? "selected" : "wave";
    lines.push(
      row(
        pad(
          `${chosen ? "›" : " "}${snapshot.changed?.includes(signal.id) ? "*" : " "} ${label}`,
          labelWidth,
        ) +
          " " +
          top,
        style,
      ),
    );
    lines.push(row(pad("  " + value, labelWidth) + " " + middle, style));
    lines.push(row(" ".repeat(labelWidth + 1) + bottom, style));
  }
  lines.push(
    row(
      "Same-time events stay separate · ≋ mixed column · Enter exact values",
      "dim",
    ),
  );
  return fill(lines, width, height);
}
const draw = {
  source: sourceRows,
  hardware: hardwareRows,
  signals: signalsRows,
};

export function debugRows(state, height, pane) {
  if (!state.hdlDebug)
    return [
      row("SYNCHRONIZED HDL DEBUG", "selected"),
      row(""),
      row("H → Run with debug recording / Open debug recording"),
      row("All three panes share one run and one event cursor."),
      row(""),
      row(
        state.model.waveform
          ? "This VCD contains timestamp values only."
          : "Start from a Verilog/SystemVerilog or VHDL project.",
      ),
      row(
        "Process activations, source mapping and RTL connections require debug capture.",
      ),
      row("chipsim hdl run project.json --debug --out NEW_DIRECTORY"),
    ];
  // Resolve exactly once. Every pane consumes this same immutable snapshot.
  const ctx = {
    state,
    debug: state.hdlDebug,
    ui: state.debugUI,
    snapshot: state.snapshot,
  };
  const width = state.columns;
  if (pane || ctx.ui.maximized)
    return draw[pane || ctx.ui.focus](ctx, width, height);
  if (width >= 110 && state.rows >= 32) {
    const topHeight = Math.floor(height * 0.56),
      leftWidth = Math.floor((width - 1) / 2),
      rightWidth = width - leftWidth - 1;
    const left = sourceRows(ctx, leftWidth, topHeight),
      right = hardwareRows(ctx, rightWidth, topHeight);
    // Independent pane styling must not highlight an unrelated source line
    // merely because the hardware row next to it contains an active process.
    const top = left.map((line, i) => ({
      text: line.text + "│" + right[i].text,
      parts: [line, row("│", "dim"), right[i]],
    }));
    return [...top, ...signalsRows(ctx, width, height - topHeight)];
  }
  const sourceHeight = Math.max(3, Math.floor(height * 0.3));
  const hardwareHeight = Math.max(3, Math.floor(height * 0.3));
  return [
    ...sourceRows(ctx, width, sourceHeight),
    ...hardwareRows(ctx, width, hardwareHeight),
    ...signalsRows(
      ctx,
      width,
      Math.max(3, height - sourceHeight - hardwareHeight),
    ),
  ].slice(0, height);
}

export function debugDetails(state, id = state.debugUI.selection) {
  const debug = state.hdlDebug,
    snapshot = state.snapshot,
    object = debug.objects.get(id);
  const event = snapshot.event;
  const location = object?.source,
    source = debug.sources.get(location?.file);
  const details = [
    `Run: ${debug.data.run.id}`,
    `Event: ${snapshot.eventIndex ?? "unavailable"} (snapshot after event)`,
    debugHeader(state),
    `Capture: ${debug.data.status.reason}`,
    "",
    object
      ? `${object.kind}: ${object.label}\nID: ${object.id}`
      : "No selected object",
    object?.observed
      ? `Value: ${display(snapshot.signals[id], state.format, object.width, object.signed)}\nBits (${object.width}): ${snapshot.signals[id] ?? "unavailable"}`
      : "",
    object?.width
      ? `Declaration: ${object.width} bits · ${object.signed ? "signed" : "unsigned/logic"}${object.type ? " · " + object.type : ""}${object.bitNames ? "\nScalar order: " + object.bitNames.join(", ") : ""}`
      : "",
    snapshot.executed?.includes(id)
      ? "Observed process activation at this event."
      : "No activation of this object recorded at this event.",
    snapshot.changed?.includes(id)
      ? "Observed value change at this event."
      : "",
    event?.writer
      ? "Observed writer: " + debug.objects.get(event.writer)?.label
      : "Writer of this event: not recorded.",
    location
      ? `Source: ${source.path}:${location.line}\n${source.text.split("\n")[location.line - 1]}`
      : "Source location: unreported.",
    "",
    "Static elaborated connections:",
    ...debug
      .related(id)
      .connections.map(
        (edge) =>
          `${debug.objects.get(edge.from).label} ─${edge.kind}→ ${debug.objects.get(edge.to).label}`,
      ),
    "",
    "Recorded event:",
    JSON.stringify(event || {}, null, 2),
    "",
    "Capture diagnostics:",
    ...debug.data.diagnostics,
  ];
  return details.filter((text) => text !== undefined).join("\n");
}
