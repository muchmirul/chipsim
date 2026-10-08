import { formatPayload } from "../core/values.js";
export const clean = (text) =>
  String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text) =>
  Array.from(segments.segment(clean(text)), (item) => item.segment);
const cellWidth = (text) => {
  const code = text.codePointAt(0);
  if (/^[\p{Mark}\u200d\u200b]+$/u.test(text)) return 0;
  if (
    /\p{Extended_Pictographic}/u.test(text) ||
    /[\u{1f1e6}-\u{1f1ff}]/u.test(text)
  )
    return 2;
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd))
    ? 2
    : 1;
};
export const displayWidth = (text) =>
  graphemes(text).reduce((width, part) => width + cellWidth(part), 0);
export const clip = (text, width) => {
  const parts = graphemes(text);
  if (parts.reduce((sum, part) => sum + cellWidth(part), 0) <= width)
    return parts.join("");
  let result = "",
    used = 0;
  for (const part of parts) {
    const size = cellWidth(part);
    if (used + size > width - 1) break;
    result += part;
    used += size;
  }
  return width > 0 ? result + "…" : "";
};
const pad = (text, width) => {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
};
export const display = (value, format, width = 8) =>
  typeof value === "number" && value >= 0
    ? formatPayload(value, format, width)
    : String(value ?? "—");
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
    cursor = Math.round((state.tick - state.offset) * state.zoom);
  const ruler = Array(width).fill(" ");
  for (let col = 0; col < width; col += Math.max(8, Math.floor(width / 6))) {
    const text = String(Math.round(state.offset + col / state.zoom));
    for (let i = 0; i < text.length && col + i < width; i++)
      ruler[col + i] = text[i];
  }
  const lines = [row(" ".repeat(23) + ruler.join(""), "dim")];
  for (const signal of signals) {
    const id = signal.id,
      top = [],
      middle = [],
      bottom = [];
    let previous;
    for (let col = 0; col < width; col++) {
      const tick = Math.floor(state.offset + col / state.zoom),
        value = state.trace[tick]?.signals[id];
      if (value === undefined) {
        top[col] = " ";
        middle[col] = " ";
        bottom[col] = " ";
        continue;
      }
      const changed = previous !== undefined && previous !== value;
      if (value === "Z") {
        top[col] = " ";
        middle[col] = !col || changed ? "Z" : "·";
        bottom[col] = " ";
      } else if (signal.width === 1) {
        top[col] = value ? "─" : changed ? "┐" : " ";
        bottom[col] = value ? (changed ? "┘" : " ") : "─";
        if (changed && value) top[col] = "┌";
        if (changed && !value) bottom[col] = "└";
        middle[col] = changed ? "│" : " ";
      } else {
        top[col] = changed ? "┬" : "─";
        bottom[col] = changed ? "┴" : "─";
        if (changed) middle[col] = "│";
        else middle[col] ??= " ";
        if (!col || changed) {
          const text = display(value, state.format, signal.width);
          for (let n = 0; n < text.length && col + n < width; n++)
            middle[col + n] = text[n];
        }
      }
      previous = value;
    }
    for (const line of [top, middle, bottom])
      if (cursor >= 0 && cursor < width) line[cursor] = "┃";
    const chosen = state.model.signals[state.selected]?.id === id,
      style = chosen ? "selected" : "wave";
    lines.push(
      row(
        pad((chosen ? "› " : "  ") + (signal.label || id), 22) +
          " " +
          top.join(""),
        style,
      ),
      row(" ".repeat(23) + middle.join(""), style),
      row(" ".repeat(23) + bottom.join(""), style),
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
        "   · j/k signal · h/l tick · w/e/b edges",
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
      `${entries.length} rows · ${state.changesOnly ? "changes only" : "all steps"} · filter ${state.logFilter || "(none)"} · j/k choose · Enter seek · C toggle changes`,
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
    max = Math.max(0, text.length - (height - 4));
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
      "j/k scroll · h/l page · / search · n/N matches · c create scenario · Enter choose PDF",
      "dim",
    ),
    ...text
      .slice(state.sourceScroll, state.sourceScroll + height - 4)
      .map((text) => row(text)),
    row(
      "5 model scope/assumptions · c create selected behavior from this manual",
      "dim",
    ),
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
        pad((index === state.registerIndex ? "› " : "  ") + item.id, 25) +
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
      "j/k choose · h/l tick · / filter · F format · " +
        items.length +
        " fields",
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
    row("j/k scroll · M export document model · 4 source text", "dim"),
  ];
}
const help = [
  [
    "Navigation",
    "1 wave · 2 blocks · 3 log · 4 sources · 5 model · 6 registers · Tab next view",
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
    "Simulation",
    "Space run/pause · r reset · p parameters · i drive input · a stimulus JSON/file · T duration",
  ],
  ["Data", "F cycle hex/decimal/binary/octal · f find selected signal value"],
  [
    "Library",
    "m select model · d import PDF, model, or session · c create sourced scenario",
  ],
  ["Search", "/ search signal names, log, or source pages · n/N repeat"],
  [
    "Files",
    "x export trace · S save session · M save model · B export source bundle",
  ],
  ["DWFV", "V open this trace in installed dwfv (optional)"],
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
  const tabs = ["wave", "inspect", "log", "sources", "model", "registers"]
    .map(
      (name, index) =>
        (name === state.view ? "[" + name.toUpperCase() + "]" : name) +
        " " +
        (index + 1),
    )
    .join("  ");
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
  const available = rows - 7;
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
  else lines.push(...sources(state, available));
  while (lines.length < rows - 3) lines.push(row(""));
  lines = lines.slice(0, rows - 3);
  lines.push(
    section(state.busy ? "WORKING" : "COMMANDS", columns),
    row(state.message, state.error ? "error" : "status"),
    row(
      "q quit · ? help · m models · p params · i pins · d import · c create · x export",
      "dim",
    ),
  );
  if (state.menu) {
    const menu = state.menu,
      title = menu.title;
    let overlay = [section(title, columns)];
    const first = Math.max(0, menu.selected - Math.floor((rows - 6) / 2));
    overlay.push(
      ...menu.items
        .slice(first, first + rows - 6)
        .map((item, i) =>
          row(
            (first + i === menu.selected ? "› " : "  ") + item.label,
            first + i === menu.selected ? "selected" : "",
          ),
        ),
    );
    overlay.push(row("j/k or arrows · Enter select · Esc cancel", "dim"));
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
