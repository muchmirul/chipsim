import { resolve } from "node:path";
import { readJSON } from "../agent/io.js";
import { runHDL } from "../hdl/run.js";
import { readComparisonTrace } from "../hdl/io.js";
import { compareBehavior } from "../hdl/compare.js";
import { exportJSON } from "../trace/export.js";
import { writeJSON } from "./workspace.js";

const pathText = (path) =>
  /^(['"]).*\1$/.test(path) ? path.slice(1, -1) : path;

export class HdlPanel {
  constructor(app) {
    this.app = app;
    this.abort = null;
  }
  close() {
    this.abort?.abort();
    return this.running;
  }
  menu() {
    const app = this.app;
    app.menu(
      "HDL · SIGNAL WORKBENCH",
      [
        { label: "Import VCD / waveform JSON", value: "import" },
        { label: "Run Verilog / VHDL project", value: "run" },
        {
          label: "Compare current trace with VCD / trace JSON",
          value: "compare",
        },
      ],
      (choice) => {
        if (choice === "import")
          return app.prompt("VCD / waveform JSON path", "", (path) =>
            app.task(() => app.state.loadWaveformFile(pathText(path))),
          );
        if (choice === "run")
          return app.prompt("HDL project manifest JSON", "", (project) =>
            app.prompt("New run output directory", "hdl-run", (out) =>
              app.task(async () => {
                this.abort = new AbortController();
                try {
                  this.running = runHDL(pathText(project), pathText(out), {
                    signal: this.abort.signal,
                    onProgress: (stage) => {
                      app.state.setMessage(
                        "HDL " + stage + " · Ctrl-C cancels/exits",
                      );
                      app.draw();
                    },
                  });
                  const { result, waveform } = await this.running;
                  if (!result.ok)
                    throw new Error(
                      "HDL failed: " +
                        result.error +
                        " · " +
                        result.artifacts.diagnostics,
                    );
                  if (!app.closed) app.state.installWaveform(waveform);
                } finally {
                  this.abort = null;
                  this.running = null;
                }
              }),
            ),
          );
        app.prompt("Comparison VCD / exported trace JSON", "", (other) =>
          app.prompt("Signal/time mapping JSON", "", (map) =>
            app.task(async () => {
              const state = app.state;
              const baseline =
                state.model.waveform ||
                JSON.parse(
                  exportJSON(
                    state.model,
                    state.trace,
                    state.config.parameters,
                    state.config.inputs,
                  ),
                );
              const right = await readComparisonTrace(pathText(other));
              const config = await readJSON(pathText(map), 65536);
              const result = compareBehavior(baseline, right, config);
              state.hdlComparison = result;
              this.review(result);
              state.setMessage(
                result.match
                  ? "Mapped signals match in the compared range"
                  : "Comparison differs · inspect coverage, inputs and outputs",
                !result.match,
              );
            }),
          ),
        );
      },
    );
  }
  review(result, selected = 0) {
    const app = this.app;
    const items = [
      {
        label: `${result.match ? "MATCH" : "DIFFERENT"} · ${result.changedSamples}/${result.samples} changed samples · coverage ${result.coverageMatches ? "matches" : "differs"}`,
        detail: result.stimulus + "\n" + result.scope,
        value: "close",
      },
      ...result.differences.map((d) => ({
        label: `${d.timeFs} fs · ${d.changes.length} signal difference(s)`,
        detail: d.changes
          .map(
            (c) =>
              `${c.role} ${c.left} → ${c.right}\n${c.leftValue ?? "unavailable"} → ${c.rightValue ?? "unavailable"}`,
          )
          .join("\n"),
        value: d,
      })),
      { label: "Export full comparison JSON", value: "export" },
    ];
    app.menu(
      "HDL COMPARISON · h/l scroll detail",
      items,
      (choice) => {
        if (choice === "close") return;
        if (choice === "export")
          return app.prompt(
            "Comparison output JSON",
            "hdl-comparison.json",
            (path) =>
              app.task(async () => {
                await writeJSON(resolve(pathText(path)), result);
                app.state.setMessage("Comparison saved");
                this.review(result, items.length - 1);
              }),
          );
        app.menu(
          "TIME " + choice.timeFs + " fs · EXACT BIT VALUES",
          choice.changes.map((change) => ({
            label: change.left + " → " + change.right,
            detail: `${change.role} · ${change.width} bits\nLeft: ${change.leftValue ?? "unavailable"}\nRight: ${change.rightValue ?? "unavailable"}`,
            value: null,
          })),
          () =>
            this.review(
              result,
              items.findIndex((item) => item.value === choice),
            ),
        );
      },
      selected,
    );
  }
}
