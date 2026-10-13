export const debugPanes = ["source", "hardware", "signals"];

export function initialDebugUI(debug) {
  return {
    focus: "source",
    maximized: false,
    scope:
      debug.data.design.objects.find((o) => o.kind === "instance")?.id || null,
    selection: null,
    signals: debug.signals.slice(0, 8).map((s) => s.id),
    stops: [],
    follow: true,
    sourceFile: debug.data.sources[0]?.id || null,
    sourceLine: 1,
  };
}

export function selectDebugObject(state, id, { browse = true } = {}) {
  const debug = state.hdlDebug,
    ui = state.debugUI,
    object = debug.objects.get(id);
  if (!object) return;
  ui.selection = id;
  if (browse) ui.follow = false;
  if (object.source) {
    ui.sourceFile = object.source.file;
    ui.sourceLine = object.source.line;
  } else if (!browse && object.kind === "process") {
    ui.sourceFile = null;
    ui.sourceLine = 1;
  }
  let scope =
    object.kind === "instance" ? object : debug.objects.get(object.parent);
  while (scope && scope.kind !== "instance")
    scope = debug.objects.get(scope.parent);
  if (scope) ui.scope = scope.id;
  const signal = debug.signals.findIndex((s) => s.id === id);
  if (signal >= 0) state.selected = signal;
  else if (object.kind === "process") {
    const written = debug.data.design.connections.find(
      (e) =>
        e.from === id &&
        e.kind === "writes" &&
        debug.objects.get(e.to)?.observed,
    );
    const related = debug.related(id).objects.find((o) => o.observed);
    const index = debug.signals.findIndex(
      (s) => s.id === (written?.to || related?.id),
    );
    if (index >= 0) state.selected = index;
  }
}

export function followDebugEvent(state) {
  if (!state.hdlDebug || !state.debugUI.follow) return;
  const event = state.hdlDebug.data.events[state.tick];
  const id = event?.process || Object.keys(event?.changes || {})[0];
  if (id) selectDebugObject(state, id, { browse: false });
  else if (event?.source) {
    state.debugUI.sourceFile = event.source.file;
    state.debugUI.sourceLine = event.source.line;
  }
}

export function debugHardwareItems(state) {
  const { hdlDebug: debug, debugUI: ui } = state;
  const scope = debug.objects.get(ui.scope);
  const related = new Set(debug.related(ui.selection).objects.map((o) => o.id));
  const items = debug.data.design.objects.filter(
    (o) =>
      o.id === ui.scope ||
      o.parent === ui.scope ||
      o.id === scope?.parent ||
      (related.has(o.id) && !o.local),
  );
  return items.sort((a, b) => {
    if (a.id === scope?.parent) return -1;
    if (b.id === scope?.parent) return 1;
    if (a.id === ui.scope) return -1;
    if (b.id === ui.scope) return 1;
    const ranks = {
      instance: 0,
      process: 1,
      operation: 2,
      port: 3,
      signal: 4,
      net: 5,
    };
    return ranks[a.kind] - ranks[b.kind] || a.label.localeCompare(b.label);
  });
}

export function debugSignalItems(state) {
  const debug = state.hdlDebug,
    ids = new Set(state.debugUI.signals);
  for (const obj of debug.related(state.debugUI.selection).objects)
    if (obj.observed) ids.add(obj.id);
  if (state.signal) ids.add(state.signal.id);
  return debug.signals.filter((s) => ids.has(s.id));
}

export function moveDebugPane(state, amount, pane = state.debugUI.focus) {
  const ui = state.debugUI;
  if (pane === "source") {
    ui.follow = false;
    const length =
      state.hdlDebug.sources.get(ui.sourceFile)?.text.split("\n").length || 1;
    ui.sourceLine = Math.max(1, Math.min(length, ui.sourceLine + amount));
  } else if (pane === "hardware") {
    const items = debugHardwareItems(state);
    const index = Math.max(
      0,
      items.findIndex((o) => o.id === ui.selection),
    );
    // Browsing an object selects related source and signals. Enter can focus a
    // child instance; j/k does not unexpectedly switch hierarchy mid-list.
    const scope = ui.scope;
    selectDebugObject(
      state,
      items[Math.max(0, Math.min(items.length - 1, index + amount))]?.id,
    );
    ui.scope = scope;
  } else {
    state.moveSignal(amount);
    selectDebugObject(state, state.signal?.id);
  }
}

export function advanceDebugReplay(state) {
  if (!state.hdlDebug.data.events.length) {
    state.playing = false;
    return;
  }
  state.seek(state.tick + 1);
  const stop = state.debugUI.stops.find((condition) =>
    state.hdlDebug.matches(state.tick, condition),
  );
  if (stop || state.tick >= state.lastTick) {
    state.playing = false;
    state.setMessage(
      stop
        ? `Replay stopped · ${stop.kind} · event ${state.tick}`
        : "End of recorded events.",
    );
  }
}
