import { clean, displayWidth, clip, pad, display } from "./text.js";
export { clean, displayWidth, clip, display } from "./text.js";
import { signalRows } from "./waveform.js";
import { detailRows } from "./trace-detail.js";
import { views } from "./views.js";
import { modelsForDocument } from "../documents/recognize.js";
import { activityRows } from "./activity-panel.js";
import { programRows } from "./program-panel.js";
const row = (text, style = "") => ({ text, style });
function section(title, width) {
  return row(
    "─ " + title + " " + "─".repeat(Math.max(0, width - title.length - 3)),
    "dim",
  );
}
function waveform(state, height) {
  const width = Math.max(1, state.columns - 24),
    maxSignals = Math.max(1, Math.floor((height - 3) / 3)),
    first = Math.max(
      0,
      Math.min(
        state.selected - Math.floor(maxSignals / 2),
        state.model.signals.length - maxSignals,
      ),
    ),
    signals = state.model.signals.slice(first, first + maxSignals),
    cursor = Math.floor((state.tick - state.offset) * state.zoom);
  const ruler = Array(width).fill(" ");
  for (let col = 0; col < width; col += Math.max(8, Math.floor(width / 6))) {
    const text = String(Math.round(state.offset + col / state.zoom));
    for (let i = 0; i < text.length && col + i < width; i++)
      ruler[col + i] = text[i];
  }
  const lines = [row(" ".repeat(23) + ruler.join(""), "dim")];
  for (const signal of signals) {
    const id = signal.id,
      [top, middle, bottom] = signalRows(state.trace, signal, {
        width,
        offset: state.offset,
        zoom: state.zoom,
        cursor,
        format: state.format,
      });
    const chosen = state.model.signals[state.selected]?.id === id,
      style = chosen ? "selected" : "wave";
    lines.push(
      row(
        pad((chosen ? "› " : "  ") + (signal.label || id), 22) + " " + top,
        style,
      ),
      row(" ".repeat(23) + middle, style),
      row(" ".repeat(23) + bottom, style),
    );
  }
  lines.push(
    row(
      "Selected: " +
        state.signal.id +
        " = " +
        display(
          state.snapshot.signals[state.signal.id],
          state.format,
          state.signal.width,
        ) +
        (state.view === "program"
          ? "   · 1 choose signal · h/l tick"
          : "   · j/k signal · h/l tick · w/e/b edges"),
      "dim",
    ),
  );
  lines.push(
    row(
      "… zoom for label · ≋ multiple values/column · x unavailable · Enter details",
      "dim",
    ),
  );
  return lines.slice(0, height);
}
function registers(state, height) {
  const snapshot = state.snapshot,
    items = [
      ...Object.entries(snapshot.signals).map(([id, value]) => ({
        id,
        value,
        width: state.model.signals.find((s) => s.id === id).width,
        kind: "signals",
      })),
      ...Object.entries(snapshot.registers).map(([id, value]) => ({
        id,
        value,
        width: state.model.registers?.find((r) => r.id === id)?.width || 32,
        kind: "registers",
      })),
    ];
  const columns = state.columns >= 110 ? 3 : 2,
    cell = Math.floor(state.columns / columns),
    lines = [];
  for (let i = 0; i < Math.min(items.length, height * columns); i += columns) {
    const text = items
      .slice(i, i + columns)
      .map((item) => {
        const changed = snapshot.changes.some(
          (c) => c.kind === item.kind && c.id === item.id,
        );
        return pad(
          (changed ? "* " : "  ") +
            item.id +
            "=" +
            display(item.value, state.format, item.width),
          cell,
        );
      })
      .join("");
    lines.push(row(text));
  }
  return lines;
}
function inspect(state, height) {
  const nodes = state.model.topology.nodes,
    active = new Set(state.snapshot.active),
    columns = state.columns >= 110 ? 3 : 2,
    cell = Math.floor(state.columns / columns),
    visibleRows = Math.max(1, Math.floor((height - 2) / 3)),
    maxScroll = Math.max(0, Math.ceil(nodes.length / columns) - visibleRows);
  state.blockScroll = Math.min(maxScroll, Math.max(0, state.blockScroll));
  const first = state.blockScroll * columns,
    end = Math.min(nodes.length, first + visibleRows * columns),
    lines = [
      row(`Blocks ${first + 1}–${end}/${nodes.length} · j/k scroll`, "dim"),
    ];
  for (let i = first; i < end; i += columns) {
    const group = nodes.slice(i, i + columns);
    lines.push(
      row(
        group
          .map((n) =>
            pad(
              "┌" + (active.has(n.id) ? " ACTIVE " : " ") + (n.label || n.id),
              cell,
            ),
          )
          .join(""),
        "wave",
      ),
    );
    lines.push(
      row(
        group
          .map((n) => {
            const value =
              state.snapshot.values[n.id]?.[0] ||
              [
                ...(n.registers || []).map(
                  (id) =>
                    id +
                    "=" +
                    display(state.snapshot.registers[id], state.format),
                ),
                ...(n.signals || []).map(
                  (id) => id + "=" + state.snapshot.signals[id],
                ),
              ].join(" ");
            return pad("│ " + value, cell);
          })
          .join(""),
      ),
    );
    lines.push(
      row(
        group
          .map(() => pad("└" + "─".repeat(Math.max(1, cell - 3)), cell))
          .join(""),
        "dim",
      ),
    );
  }
  lines.push(
    row(
      "Connections: " +
        state.model.topology.edges.map(([a, b]) => a + " → " + b).join(" · "),
      "dim",
    ),
  );
  return lines.slice(0, height);
}
function logs(state, height) {
  const entries = state.logs();
  state.logIndex = Math.max(0, Math.min(entries.length - 1, state.logIndex));
  const first = Math.max(0, state.logIndex - Math.floor((height - 2) / 2));
  const lines = [
    row("Tick    State           Event / register changes", "dim"),
  ];
  for (let i = first; i < Math.min(entries.length, first + height - 2); i++) {
    const s = entries[i],
      changed = s.changes
        .map(
          (c) =>
            `${c.id}: ${display(c.before, state.format)}→${display(c.after, state.format)}`,
        )
        .join(" · ");
    lines.push(
      row(
        (i === state.logIndex ? "› " : "  ") +
          String(s.tick).padStart(4) +
          "  " +
          pad(s.state, 15) +
          " " +
          s.message +
          (changed ? " | " + changed : ""),
        i === state.logIndex ? "selected" : "",
      ),
    );
  }
  lines.push(
    row(
      `j/k choose · Enter seek/details · C changes · ${entries.length} rows · filter ${state.logFilter || "(none)"}`,
      "dim",
    ),
  );
  return lines;
}
function wrapped(text, width) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let current = "";
    for (const word of clean(paragraph).split(/\s+/)) {
      if (current.length + word.length + 1 > width) {
        if (current) lines.push(current);
        current = word;
      } else current += (current ? " " : "") + word;
    }
    lines.push(current);
  }
  return lines;
}
function sources(state, height) {
  const document = state.document;
  if (!document)
    return [
      row(
        "No PDF is loaded. Press d to import a datasheet or reference manual.",
      ),
      row("Press Enter to import the first bundled source for this model."),
      ...state.model.sources.map((s) =>
        row(
          (s.title || s.filename || s.id) + " · " + (s.path || s.url || ""),
          "dim",
        ),
      ),
    ];
  const page = document.pages.find((p) => p.number === state.page),
    text = wrapped(page?.text || "", state.columns),
    linked = modelsForDocument(document, state.models),
    max = Math.max(0, text.length - (height - 5));
  state.sourceScroll = Math.min(max, Math.max(0, state.sourceScroll));
  return [
    row(
      document.filename +
        " · PDF page " +
        state.page +
        "/" +
        document.pages.length +
        " · SHA " +
        document.sha256.slice(0, 16),
      "selected",
    ),
    row(
      (linked.length
        ? linked.length + " simulation(s) available"
        : "No simulation linked") + " · o choose/find · c create",
      "selected",
    ),
    row(
      "j/k scroll · h/l page · / search · n/N matches · Enter choose PDF",
      "dim",
    ),
    ...text
      .slice(state.sourceScroll, state.sourceScroll + height - 5)
      .map((text) => row(text)),
    row("o simulations and scope for this PDF · B export sources", "dim"),
  ];
}
function registerTable(state, height) {
  const items = state.registers();
  state.registerIndex = Math.max(
    0,
    Math.min(items.length - 1, state.registerIndex),
  );
  const first = Math.max(0, state.registerIndex - Math.floor((height - 2) / 2));
  const lines = [
    row(
      pad("Register / signal", 25) +
        pad("Current", Math.min(36, Math.floor((state.columns - 25) / 2))) +
        "Change at this tick",
      "dim",
    ),
  ];
  for (
    let index = first;
    index < Math.min(items.length, first + height - 2);
    index++
  ) {
    const item = items[index],
      change = state.snapshot.changes.find(
        (c) => c.kind === item.kind && c.id === item.key,
      );
    lines.push(
      row(
        pad((index === state.registerIndex ? "› " : "  ") + item.label, 25) +
          pad(
            display(item.value, state.format, item.width),
            Math.min(36, Math.floor((state.columns - 25) / 2)),
          ) +
          (change
            ? display(change.before, state.format, item.width) +
              " → " +
              display(change.after, state.format, item.width)
            : ""),
        index === state.registerIndex ? "selected" : "",
      ),
    );
  }
  lines.push(
    row(
      "j/k choose · Enter details · h/l tick · / filter · F format · " +
        (state.model.registerInterface ? "u access · " : "") +
        items.length +
        " fields",
      "dim",
    ),
  );
  return lines;
}
function stimulusTable(state, height) {
  const events = state.stimulus.events();
  state.stimulusIndex = Math.max(
    0,
    Math.min(events.length - 1, state.stimulusIndex),
  );
  const first = Math.max(0, state.stimulusIndex - Math.floor((height - 3) / 2)),
    pinWidth = state.columns >= 110 ? 32 : 22,
    valueWidth = Math.min(36, state.columns - pinWidth - 20);
  const lines = [
    row(
      pad("Tick / input pin", pinWidth) +
        pad("Value", valueWidth) +
        "Holds / status",
      "dim",
    ),
  ];
  if (!events.length)
    lines.push(
      row(
        state.stimulusFilter
          ? "No events match this filter · / changes filter"
          : state.model.kind === "builtin"
            ? "No explicit events · ACK uses model parameters"
            : "No explicit events · input pins start at their initial values",
      ),
    );
  for (
    let index = first;
    index < Math.min(events.length, first + height - 3);
    index++
  ) {
    const event = events[index];
    lines.push(
      row(
        pad(
          (index === state.stimulusIndex ? "› " : "  ") +
            String(event.tick).padStart(5) +
            "  " +
            event.label,
          pinWidth,
        ) +
          pad(display(event.value, state.format, event.width), valueWidth) +
          (event.superseded
            ? "superseded at same tick"
            : !event.reached
              ? "outside current trace"
              : event.until === undefined
                ? "to trace end"
                : "until tick " + event.until),
        index === state.stimulusIndex ? "selected" : "",
      ),
    );
  }
  lines.push(
    row(
      `${events.length}/${state.config.inputs.length} events · filter ${state.stimulusFilter || "(none)"} · U undo / R redo`,
      "dim",
    ),
  );
  lines.push(
    row(
      "j/k choose · Enter actions · i schedule · Del remove · a clear/load · / filter",
      "dim",
    ),
  );
  return lines;
}
function modelInfo(state, height) {
  const m = state.model;
  const text = [
    "MODEL: " + m.name,
    "FIDELITY: " + m.fidelity,
    "SCOPE: " + m.scope,
    ...(m.registerMap
      ? [
          "",
          "REGISTER MAP",
          ...m.registerMap.map(
            (entry) =>
              `0x${entry.address.toString(16)} ${entry.name} · ${entry.access} · ${entry.value || "write action"} · evidence: ${entry.evidence.join(", ")}`,
          ),
        ]
      : []),
    "",
    "ASSUMPTIONS",
    ...m.assumptions.map((a) => "• " + a),
    "",
    "PARAMETERS",
    ...m.parameters.map(
      (p) =>
        (p.label || p.id) + " (" + p.id + "): " + state.config.parameters[p.id],
    ),
    "",
    "SOURCES",
    ...m.sources.map(
      (s) => (s.title || s.filename || s.id) + " · SHA " + s.sha256,
    ),
    ...(m.evidence || []).flatMap((e) => [
      "PDF page " + e.page + ": " + e.claim,
      "“" + e.quote + "”",
    ]),
    ...(m.warnings || []).map((w) => "UNVERIFIED: " + w),
    "",
    "IMPLEMENTATION / STATES",
    ...m.recipe(state.config.parameters),
  ];
  if (m.sourceTable) {
    const table = m.sourceTable;
    text.push(
      "",
      "SOURCE FUNCTION TABLE · PDF page " + table.page,
      table.inputs.join(" ") + " → " + table.outputs.join(" "),
      ...(table.symbolRows || table.rows).map(
        (row) =>
          row.inputs.map((value) => (value === null ? "X" : value)).join(" ") +
          " → " +
          row.outputs.join(" "),
      ),
      "Instances: " +
        table.instances.map((instance) => instance.join("/")).join(" · "),
    );
  }
  const lines = text.flatMap((t) => wrapped(t, state.columns));
  state.infoScroll = Math.min(
    Math.max(0, lines.length - height + 1),
    Math.max(0, state.infoScroll),
  );
  return [
    ...lines
      .slice(state.infoScroll, state.infoScroll + height - 1)
      .map((t) => row(t)),
    row(
      "j/k scroll · E edit entered table · M export model · 4 source text",
      "dim",
    ),
  ];
}
const help = [
  [
    "Navigation",
    "1 wave · 2 blocks · 3 log · 4 sources · 5 model · 6 regs · 7 inputs · 8 agent · 9 program",
  ],
  [
    "Waveforms",
    "h/l or ←/→ tick · j/k or ↑/↓ signal · w rising · e falling · b previous rising",
  ],
  [
    "Timeline",
    "0 beginning · $/End last tick · [/] previous/next change · t go to tick",
  ],
  ["Zoom", "+/- zoom · = fit trace · z center cursor"],
  [
    "Step details",
    "Enter in wave/blocks/registers/log · j/k scroll · s source · Esc close",
  ],
  [
    "Simulation",
    "Space run/pause · r reset · p parameters · i drive input · a stimulus JSON/file · T duration",
  ],
  ["Data", "F cycle hex/decimal/binary/octal · f find selected signal value"],
  [
    "Stimulus",
    "7 timeline · Enter edit/move/seek · i schedule · Del remove · U undo · R redo",
  ],
  [
    "Registers",
    "u addressed read/write at next tick · 6 inspect latches and values",
  ],
  [
    "Library",
    "m models · o source simulations · d import · c create · E edit entered table",
  ],
  ["Search", "/ search signal names, log, or source pages · n/N repeat"],
  [
    "Files",
    "x export trace · S save session · M save model · B export source bundle",
  ],
  ["DWFV", "V open this trace in installed dwfv (optional)"],
  [
    "Programming",
    "P load .chip · 9 code/signals · N step · C continue · K break · J back",
  ],
  [
    "Agent monitor",
    "--watch PROJECT · 8 activity · W pause reload · G follow newest",
  ],
  ["General", "? help · Esc close overlay · q/Ctrl-C quit"],
];
export function render(state) {
  const columns = Math.max(1, state.columns),
    rows = Math.max(1, state.rows),
    s = state.snapshot;
  if (columns < 60 || rows < 18)
    return Array.from({ length: rows }, (_, index) =>
      row(
        pad(
          index === 0
            ? "ChipSim · resize terminal to at least 60×18"
            : index === 1
              ? "q quit · 80×24 recommended"
              : "",
          columns,
        ),
      ),
    );
  if (!s) return "Loading ChipSim…";
  const tabs = views
    .map(
      (name, index) =>
        (name === state.view
          ? "[" + name.toUpperCase() + "]"
          : columns < 110
            ? {
                inspect: "blocks",
                sources: "src",
                registers: "regs",
                stimulus: "inputs",
                activity: "agent",
                program: "prog",
              }[name] || name
            : name) +
        (columns < 110 ? "" : " ") +
        (index + 1),
    )
    .join(columns < 110 ? " " : "  ");
  let lines = [
    row(
      "CHIPSIM  " + state.model.name + "   · behavioral · normalized ticks",
      "title",
    ),
    row(tabs, "dim"),
    row(
      `tick ${state.tick}/${state.trace.length - 1}  state ${s.state}  format ${state.format}  zoom ${state.zoom.toFixed(2)}  ${state.playing ? "RUNNING" : "paused"}`,
      "selected",
    ),
  ];
  const monitoring = state.activity && state.view !== "activity";
  const available = rows - (monitoring ? 8 : 7);
  if (state.view === "wave") {
    const wh = Math.max(6, Math.floor(available * 0.6));
    lines.push(
      ...waveform(state, wh),
      section("REGISTERS · * changed", columns),
      ...registers(state, Math.max(1, available - wh - 3)),
      row(s.message || "Hold state", "event"),
    );
  } else if (state.view === "inspect") {
    const gh = Math.max(6, Math.floor(available * 0.6));
    lines.push(
      ...inspect(state, gh),
      section("REGISTERS", columns),
      ...registers(state, Math.max(1, available - gh - 3)),
      row(s.message || "Hold state", "event"),
    );
  } else if (state.view === "log") lines.push(...logs(state, available));
  else if (state.view === "registers")
    lines.push(...registerTable(state, available));
  else if (state.view === "model") lines.push(...modelInfo(state, available));
  else if (state.view === "stimulus")
    lines.push(...stimulusTable(state, available));
  else if (state.view === "activity")
    lines.push(...activityRows(state, available));
  else if (state.view === "program") {
    const sourceHeight = Math.max(7, Math.floor(available * 0.55));
    lines.push(
      ...programRows(state, sourceHeight),
      ...waveform(state, Math.max(4, available - sourceHeight)),
    );
  } else lines.push(...sources(state, available));
  while (lines.length < rows - (monitoring ? 4 : 3)) lines.push(row(""));
  lines = lines.slice(0, rows - (monitoring ? 4 : 3));
  if (monitoring)
    lines.push(
      row(
        "AGENT · " +
          (state.activity.events.at(-1)
            ? state.activity.events.at(-1).command +
              " " +
              state.activity.events.at(-1).status +
              " · "
            : "") +
          (state.activity.events.at(-1)?.message || "Waiting for activity") +
          " · 8 details",
        "dim",
      ),
    );
  lines.push(
    section(
      state.busy
        ? "WORKING"
        : state.activity
          ? `COMMANDS · WATCH ${state.activity.enabled ? "LIVE" : "PAUSED"}`
          : "COMMANDS",
      columns,
    ),
    row(state.message, state.error ? "error" : "status"),
    row(
      "q quit · ? help · 1–9 views · m models · d import · x export" +
        (state.activity ? " · W watch" : " · c create"),
      "dim",
    ),
  );
  if (state.traceDetail)
    lines.splice(3, rows - 6, ...detailRows(state, rows - 6));
  if (state.traceDetail)
    lines[rows - 1] = row(
      "j/k scroll · [/] change · s source · Esc/Enter/q close · Ctrl-C quit",
      "dim",
    );
  if (state.menu) {
    const menu = state.menu,
      title = menu.title;
    let overlay = [section(title, columns)];
    const detail = menu.items[menu.selected]?.detail,
      detailLines = detail ? wrapped(detail, columns) : [],
      detailSpace = detail
        ? Math.min(7, Math.max(3, Math.floor((rows - 6) / 2)))
        : 0,
      itemSpace = Math.max(1, rows - 8 - detailSpace),
      first = Math.max(0, menu.selected - Math.floor(itemSpace / 2));
    overlay.push(
      ...menu.items
        .slice(first, first + itemSpace)
        .map((item, i) =>
          row(
            (first + i === menu.selected ? "› " : "  ") + item.label,
            first + i === menu.selected ? "selected" : "",
          ),
        ),
    );
    if (detail) {
      menu.detailScroll = Math.min(
        Math.max(0, detailLines.length - detailSpace + 1),
        Math.max(0, menu.detailScroll || 0),
      );
      overlay.push(section("SCOPE / ACTION · h/l scroll", columns));
      const visible = detailLines.slice(
        menu.detailScroll,
        menu.detailScroll + detailSpace - 1,
      );
      if (detailLines.length > menu.detailScroll + visible.length)
        visible[visible.length - 1] = clip(visible.at(-1), columns - 2) + " …";
      overlay.push(...visible.map((text) => row(text, "dim")));
    }
    overlay.push(row("j/k or arrows · Enter select · Esc cancel", "dim"));
    if (detail) while (overlay.length < rows - 6) overlay.push(row(""));
    lines.splice(
      3,
      Math.min(overlay.length, rows - 6),
      ...overlay.slice(0, rows - 6),
    );
  }
  if (state.prompt) {
    const p = state.prompt;
    const overlay = [
      section(p.label, columns),
      row("Default: " + (p.defaultValue || "(none)"), "dim"),
      row("> " + p.value + "▏", "selected"),
      row(
        p.error ||
          p.help ||
          "Enter accepts typed value or default · Esc cancels",
        p.error ? "error" : "dim",
      ),
    ];
    lines.splice(3, 4, ...overlay);
  }
  if (state.help) {
    const overlay = [
      section("KEYS", columns),
      ...help.flatMap(([name, description]) => [
        row(name + ": " + description),
      ]),
      row("Esc or ? closes help", "dim"),
    ];
    lines.splice(
      3,
      Math.min(rows - 6, overlay.length),
      ...overlay.slice(0, rows - 6),
    );
  }
  return lines
    .slice(0, rows)
    .map((line) => ({ text: pad(line.text, columns), style: line.style }));
}
const colors = {
  title: "1;36",
  selected: "30;46",
  dim: "2",
  wave: "36",
  event: "33",
  status: "32",
  error: "31",
};
export function screenText(state, { color = false } = {}) {
  return render(state)
    .map(({ text, style }) =>
      color && colors[style] ? `\x1b[${colors[style]}m${text}\x1b[0m` : text,
    )
    .join("\n");
}
