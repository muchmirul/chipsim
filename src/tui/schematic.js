import { recordingGraph, schematicLines } from "../workbench/inspect.js";
import { pad } from "./text.js";

export function schematicRows(state, height) {
  const lines = state.netlistGraph
    ? [
        "SCHEMATIC · synthesized module definitions · no recorded values",
        "j/k select · Enter connections · Tab project views",
        ...schematicLines(state.netlistGraph, {
          object: state.netlistSelection,
          limit: Math.max(1, height - 3),
        }),
      ]
    : state.hdlDebug
      ? [
          "SCHEMATIC · captured RTL · event " + state.tick,
          "j/k select · Enter connections/source · F2 panes · J/N event · Tab views",
          "Edges are static connectivity; values are observations at this event.",
          ...schematicLines(recordingGraph(state.hdlDebug), {
            object: state.debugUI.selection,
            at: state.tick,
            limit: Math.max(1, height - 4),
          }),
        ]
      : [
          "SCHEMATIC · open a verified HDL debug recording",
          "chipsim --hdl-debug RUN/debug.json --view schematic",
        ];
  return lines.slice(0, height).map((text, i) => ({
    text: pad(text, state.columns),
    style: i === 0 ? "selected" : "",
  }));
}

export function schematicKey(app, k, key) {
  const state = app.state,
    graph = state.netlistGraph;
  if (!graph) return false;
  // Project controls run before this handler. Only explicit experiment loading
  // or model selection may leave static inspection; other keys must not act on
  // the preserved, hidden simulation behind the netlist.
  if (["m", "H", "d"].includes(k) || key.name === "tab") return false;
  if (state.view !== "schematic") return staticOnly();
  function staticOnly() {
    state.setMessage(
      "Static netlist: use Tab for inspection views, m for models or H/d to load recorded data.",
    );
    return true;
  }
  const index = Math.max(
    0,
    graph.objects.findIndex((o) => o.id === state.netlistSelection),
  );
  if (["j", "k"].includes(k) || ["down", "up"].includes(key.name)) {
    const delta = k === "j" || key.name === "down" ? 1 : -1;
    state.netlistSelection =
      graph.objects[
        Math.max(0, Math.min(graph.objects.length - 1, index + delta))
      ]?.id;
    return true;
  }
  if (key.name === "return") {
    const edges = graph.connections.filter(
      (e) =>
        e.from === state.netlistSelection || e.to === state.netlistSelection,
    );
    app.menu(
      "Static netlist connections",
      edges.slice(0, 200).map((e) => ({
        label: `${e.from} --${e.kind}--> ${e.to}`,
        value: e.from === state.netlistSelection ? e.to : e.from,
      })),
      (id) => {
        if (id) state.netlistSelection = id;
      },
    );
    return true;
  }
  return staticOnly();
}
