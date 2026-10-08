import { formatPayload } from "../core/values.js";
import { compareTraces } from "../core/trace-diff.js";
import { writeJSON } from "./workspace.js";
import { resolve } from "node:path";

// Read-only review of the experiment. Navigation never seeks or installs a draft.
export class TraceReview {
  constructor(app, preview, onBack) {
    this.app = app;
    this.preview = preview;
    this.onBack = onBack;
    this.comparison = compareTraces(app.state.trace, preview.trace);
    this.baseline = structuredClone(app.state.session());
  }
  value(field, value) {
    if (value === null) return "unavailable";
    if (typeof value !== "number") return String(value);
    const [kind, id] = field.split("."),
      declarations =
        kind === "signal"
          ? this.preview.model.signals
          : this.preview.model.registers,
      width = declarations.find((item) => item.id === id)?.width || 32;
    return formatPayload(value, this.baseline.display, width);
  }
  label(change) {
    return `${change.field}: ${this.value(change.field, change.before)} → ${this.value(change.field, change.after)}`;
  }
  menu(selected = this.comparison.changedTicks ? 1 : 0) {
    const { comparison, app } = this;
    const items = [
      {
        label: `${comparison.changedTicks} changed ticks / ${comparison.ticks} · first ${comparison.firstDifference ?? "none"} · Enter returns`,
        value: "back",
      },
      ...comparison.differences.map((difference) => ({
        label: `Tick ${difference.tick} · ${difference.changes.length} change(s) · ${this.label(difference.changes[0])}`,
        value: difference,
      })),
      { label: "Export full comparison JSON", value: "export" },
    ];
    app.menu(
      "TRACE DIFFERENCES · working model kept",
      items,
      (choice) => {
        if (choice === "back") return this.onBack();
        if (choice === "export")
          return app.prompt(
            "Comparison JSON path",
            app.state.modelId + ".comparison.json",
            (path) =>
              app.task(async () => {
                await writeJSON(
                  resolve(/^(['"]).*\1$/.test(path) ? path.slice(1, -1) : path),
                  {
                    format: "chipsim-trace-comparison",
                    version: 1,
                    baseline: this.baseline,
                    draft: this.preview.model.spec,
                    comparison,
                  },
                );
                this.menu(items.length - 1);
                app.state.setMessage(
                  "Comparison exported · working model and draft kept",
                );
              }),
          );
        app.menu(
          `TICK ${choice.tick} DIFFERENCES · original → draft`,
          [
            ...choice.changes.map((change) => ({
              label: this.label(change),
              value: null,
            })),
            { label: "Return to changed ticks", value: null },
          ],
          () => this.menu(items.findIndex((item) => item.value === choice)),
        );
      },
      Math.min(selected, items.length - 1),
    );
  }
}
