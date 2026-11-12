export const views = [
  "wave",
  "inspect",
  "log",
  "sources",
  "model",
  "registers",
  "stimulus",
  "activity",
  "program",
  "states",
  "flow",
  "compare",
  "debug",
  "circuit",
  "schematic",
  "project",
  "pipeline",
  "artifacts",
  "checks",
];
export const availableViews = (state) =>
  state.netlistGraph
    ? ["schematic", ...(state.design ? views.slice(-4) : [])]
    : (state.design ? views : views.slice(0, -4)).filter(
        (view) =>
          (view !== "circuit" || state.model?.connected) &&
          (view !== "schematic" || state.hdlDebug),
      );
