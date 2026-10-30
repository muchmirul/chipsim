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
  "project",
  "pipeline",
  "artifacts",
  "checks",
];
export const availableViews = (state) =>
  (state.design ? views : views.slice(0, -4)).filter(
    (view) => view !== "circuit" || state.model?.connected,
  );
