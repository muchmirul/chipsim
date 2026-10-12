import { stateGraph } from "../visualization/state-graph.js";
import { flowFrame, valueBits } from "../visualization/flow.js";
import { pad, display, wrapText } from "./text.js";
import { signalRows } from "./waveform.js";
const row = (text, style = "") => ({ text, style });
const box = (label, width) => [
  "╭" + "─".repeat(width - 2) + "╮",
  "│" + pad(label, width - 2) + "│",
  "╰" + "─".repeat(width - 2) + "╯",
];

export function stateRows(state, height) {
  const graph = stateGraph(state.model, state.trace, state.tick);
  if (!graph.nodes.length)
    return [
      row("STATE GRAPH"),
      row(graph.scope),
      row("Recorded signals remain available in 1 Waveforms."),
    ];
  state.graphIndex = Math.min(state.graphIndex, graph.nodes.length - 1);
  const node = graph.nodes[state.graphIndex],
    incoming = graph.edges.filter(
      (edge) => edge.to === node.id && edge.from !== node.id,
    ),
    outgoing = graph.edges.filter((edge) => edge.from === node.id),
    targets = [
      ...new Set(
        outgoing.filter((edge) => edge.to !== node.id).map((edge) => edge.to),
      ),
    ],
    width = Math.max(10, Math.min(24, Math.floor((state.columns - 12) / 3))),
    gap = " ──→ ",
    center = box((node.id === graph.current ? "▶ " : "") + node.id, width),
    source = incoming.length
      ? box(incoming[0].from, width)
      : box(node.id === graph.initial ? "INITIAL" : "No incoming edge", width),
    target = targets.length
      ? box(targets[0], width)
      : box(node.terminal ? "LATCHED" : "No outgoing edge", width);
  const lines = [
    row("FSM · " + graph.scope, "dim"),
    row(
      "Current: " +
        (graph.current || "unavailable") +
        " · Focus: " +
        node.id +
        " · " +
        (node.visits.length ? "visited" : "not visited"),
    ),
    row(source[0] + "     " + center[0] + "     " + target[0]),
    row(
      source[1] +
        (incoming.length || node.id === graph.initial ? gap : "     ") +
        center[1] +
        (targets.length ? gap : "     ") +
        target[1],
      node.id === graph.current ? "selected" : "",
    ),
    row(
      source[2] +
        "     " +
        center[2] +
        (targets.length > 1 ? "  │  " : "     ") +
        target[2],
    ),
  ];
  if (targets.length > 1)
    lines.push(
      row(
        " ".repeat(width * 2 + 5) +
          "  └─→ [" +
          targets.slice(1).join("] / [") +
          "]",
      ),
    );
  const hold = outgoing.find((edge) => edge.to === node.id);
  if (hold) lines.push(row(" ".repeat(width + 5) + "↻ " + hold.guard, "dim"));
  if (incoming.length > 1)
    lines.push(
      row(
        "Other incoming: " +
          [...new Set(incoming.slice(1).map((edge) => edge.from))].join(", "),
        "dim",
      ),
    );
  lines.push(row("OUTGOING CONDITIONS · priority order", "dim"));
  for (const edge of outgoing)
    for (const text of wrapText(
      (edge.id === graph.selectedTransition ? "▶ " : "  ") +
        (edge.priority ? edge.priority + ". " : "") +
        edge.to +
        " ← " +
        edge.guard +
        (edge.ticks.length
          ? " · seen " + edge.ticks.length + " tick(s)"
          : " · not observed"),
      state.columns,
    ))
      lines.push(
        row(text, edge.id === graph.selectedTransition ? "selected" : ""),
      );
  return [
    ...lines.slice(0, height - 1),
    row(
      "j/k focus · h/l tick · Enter full rules/observations · Space replay",
      "dim",
    ),
  ];
}

function scrollRows(state, lines, height, hint) {
  state.visualScroll = Math.max(
    0,
    Math.min(state.visualScroll, Math.max(0, lines.length - height + 1)),
  );
  return [
    ...lines.slice(state.visualScroll, state.visualScroll + height - 1),
    row(hint, "dim"),
  ];
}

export function flowRows(state, height) {
  const frame = flowFrame(
      state.model,
      state.trace,
      state.tick,
      state.config.parameters,
    ),
    lines = [];
  if (frame.kind === "serial") {
    const indices = Array.from({ length: frame.bits }, (_, index) => index),
      sender = indices
        .map((index) =>
          pad(
            (index === frame.bitIndex ? "[" : " ") +
              ((frame.payload >>> index) & 1) +
              (index === frame.bitIndex ? "]" : " "),
            4,
          ),
        )
        .join(""),
      receiver = indices
        .map((index) =>
          pad(
            index < frame.samples ? String((frame.decoded >>> index) & 1) : "·",
            4,
          ),
        )
        .join("");
    lines.push(
      row("BIT FLOW · " + frame.title, "dim"),
      row(
        "Payload " +
          display(frame.payload, state.format, frame.bits) +
          " · bit 0 first",
      ),
      row(
        "            " + indices.map((index) => pad("b" + index, 4)).join(""),
        "dim",
      ),
      row("Sender      " + sender),
      row("                  │ present bit " + frame.bitIndex),
      row("                  ▼"),
      row(
        "DATA [" +
          frame.data +
          "] ─────" +
          (frame.sampled
            ? "─▶ CAPTURE bit " + (frame.samples - 1) + " ──▶ Receiver"
            : "── held until rising CLK"),
        frame.sampled ? "selected" : "wave",
      ),
      row(
        "CLK  [" +
          frame.clock +
          "] · " +
          (frame.sampled
            ? "rising edge sampled DATA"
            : "no receiver capture at this tick"),
      ),
      row("Receiver    " + receiver),
      row(
        "Decoded " +
          display(frame.decoded, state.format, frame.bits) +
          " · " +
          frame.samples +
          "/" +
          frame.bits +
          " samples · ACK=" +
          frame.ack,
      ),
      row(
        "Receiver belongs to the teaching experiment, not inferred chip circuitry.",
        "dim",
      ),
    );
  } else if (frame.kind === "assignments") {
    lines.push(
      row("BIT FLOW · executed reads → assignments", "dim"),
      row(
        frame.total +
          " write(s); " +
          frame.operations.length +
          " recorded · order matters",
      ),
    );
    for (const operation of frame.operations) {
      lines.push(
        row(
          operation.index +
            1 +
            ". " +
            operation.stage +
            " · " +
            operation.target +
            "  " +
            display(operation.before, state.format, operation.width) +
            " → " +
            display(operation.after, state.format, operation.width),
          "selected",
        ),
      );
      const source = operation.reads.length
        ? operation.reads
            .map(
              (read) =>
                read.field +
                "=" +
                display(read.value, state.format, read.width),
            )
            .join(" + ")
        : "literal assignment";
      for (const text of wrapText(
        source +
          " ───▶ " +
          operation.target +
          " [" +
          valueBits(operation.after, operation.width) +
          "]",
        state.columns,
      ))
        lines.push(row(text));
    }
    if (frame.total > frame.operations.length)
      lines.push(
        row(
          "Additional writes exceeded the 64-record observation bound.",
          "dim",
        ),
      );
  } else {
    lines.push(
      row("BIT FLOW · observed changes", "dim"),
      row(frame.message, "dim"),
    );
    for (const change of frame.changes || [])
      for (const text of wrapText(
        change.id +
          ": " +
          valueBits(change.before, change.width) +
          " → " +
          valueBits(change.after, change.width),
        state.columns,
      ))
        lines.push(row(text));
    if (!frame.changes?.length)
      lines.push(row("No value change or assignment recorded at this tick."));
  }
  for (const text of wrapText(state.snapshot.message, state.columns))
    lines.push(row(text, "event"));
  return scrollRows(
    state,
    lines,
    height,
    "h/l tick · Space replay · j/k scroll · F base · Enter step details",
  );
}

export function comparisonRows(state, height) {
  if (!state.reference)
    return [
      row("EXPERIMENT COMPARISON"),
      row("No reference captured."),
      row(
        "Y captures this experiment. Change its parameters/stimulus, then D.",
      ),
      row("Enter loads a saved reference session or opens comparison actions."),
    ];
  if (state.model.waveform)
    return [
      row(
        "Use H → Compare for HDL traces with explicit mappings and time units.",
      ),
    ];
  const reference = state.reference,
    current = state.trace[state.tick],
    baseline = reference.trace[state.tick],
    comparison = state.comparison(),
    difference = comparison.differences.find(
      (item) => item.tick === state.tick,
    ),
    changedSignal = difference?.changes
      .find((change) => change.field.startsWith("signal."))
      ?.field.slice(7),
    signal =
      state.model.signals.find((signal) => signal.id === changedSignal) ||
      state.signal,
    referenceSignal = reference.model.signals.find(
      (item) => item.id === signal.id,
    ),
    width = Math.max(1, state.columns - 18),
    last = Math.max(state.trace.length, reference.trace.length) - 1,
    zoom = width / Math.max(1, last),
    cursor = Math.min(width - 1, Math.floor(state.tick * zoom)),
    lines = [
      row(
        "COMPARISON · " +
          comparison.changedTicks +
          " differing ticks · first " +
          (comparison.firstDifference ?? "none"),
        "selected",
      ),
      row(
        "Reference: " +
          reference.model.name +
          " · " +
          (baseline?.state || "unavailable"),
      ),
      row(
        "Current:   " +
          state.model.name +
          " · " +
          (current?.state || "unavailable"),
      ),
    ];
  for (const change of comparison.parameterChanges)
    lines.push(
      row(
        "Parameter " +
          change.field +
          ": " +
          change.before +
          " → " +
          change.after,
        "dim",
      ),
    );
  if (reference.origin)
    lines.splice(3, 0, row("Reference origin: " + reference.origin, "dim"));
  if (comparison.inputChanges.length)
    lines.push(
      row(
        "Stimulus differs at " +
          comparison.inputChanges.length +
          " event position(s)",
        "dim",
      ),
    );
  if (comparison.durationChange)
    lines.push(
      row(
        "Duration " +
          comparison.durationChange.before +
          " → " +
          comparison.durationChange.after,
        "dim",
      ),
    );
  if (comparison.widthChanges.length)
    lines.push(
      row("Declaration widths differ; inspect exported report.", "error"),
    );
  lines.push(
    row("SIGNAL " + signal.id + " · common normalized-tick axis", "dim"),
  );
  if (referenceSignal && referenceSignal.width === signal.width) {
    for (const [label, trace, declaration] of [
      ["Reference", reference.trace, referenceSignal],
      ["Current", state.trace, signal],
    ])
      signalRows(trace, declaration, {
        width,
        offset: 0,
        zoom,
        cursor,
        format: state.format,
      }).forEach((text, index) =>
        lines.push(row(pad(index === 1 ? label : "", 16) + text, "wave")),
      );
  } else
    lines.push(row("No compatible reference signal with this name/width."));
  lines.push(
    row(
      "AT TICK " +
        state.tick +
        " · " +
        (difference ? "differences" : "matching observed fields"),
      "dim",
    ),
  );
  const formatted = (value, model, field) => {
    if (value === null || value === undefined) return "unavailable";
    const [kind, id] = field.split(".");
    const width =
      (kind === "signal" ? model.signals : model.registers)?.find(
        (item) => item.id === id,
      )?.width || 32;
    return typeof value === "number"
      ? display(value, state.format, width)
      : String(value);
  };
  for (const change of difference?.changes || [])
    for (const text of wrapText(
      change.field +
        ": " +
        formatted(change.before, reference.model, change.field) +
        " → " +
        formatted(change.after, state.model, change.field),
      state.columns,
    ))
      lines.push(row(text));
  return scrollRows(
    state,
    lines,
    height,
    "[ / ] differing tick · h/l tick · j/k scroll · Enter load/export/clear",
  );
}
