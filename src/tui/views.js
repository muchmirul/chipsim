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
  "project",
  "pipeline",
  "artifacts",
  "checks",
];
export const availableViews = (state) =>
  state.design ? views : views.slice(0, -4);
