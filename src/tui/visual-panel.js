import { stateGraph } from "../visualization/state-graph.js";
import { comparisonJSON } from "../visualization/experiments.js";
import { writeJSON } from "./workspace.js";
import { resolve } from "node:path";

export class VisualPanel {
  constructor(app) {
    this.app = app;
  }
  stateDetails() {
    const s = this.app.state,
      graph = stateGraph(s.model, s.trace, s.tick),
      node = graph.nodes[s.graphIndex];
    if (!node) return s.setMessage(graph.scope);
    const edges = graph.edges.filter((edge) => edge.from === node.id);
    this.app.menu(
      "STATE " +
        node.id +
        " · " +
        (node.terminal ? "terminal latch" : graph.scope),
      [
        ...edges.map((edge) => ({
          label: edge.to + " · " + edge.guard,
          detail:
            (edge.priority ? "Priority " + edge.priority + "; " : "") +
            edge.actions.join("; ") +
            "\nObserved ticks: " +
            (edge.ticks.length
              ? edge.ticks.join(", ")
              : "not observed in this experiment") +
            (edge.evidence.length
              ? "\nEvidence: " + edge.evidence.join(", ")
              : ""),
          value: edge.ticks[0],
        })),
        {
          label:
            "Seek first observed visit · " + (node.visits[0] ?? "not visited"),
          value: node.visits[0],
        },
      ],
      (tick) => {
        if (tick !== undefined) s.seek(tick);
      },
    );
  }
  comparisons() {
    const app = this.app,
      s = app.state;
    app.menu(
      "EXPERIMENT COMPARISON",
      [
        { label: "Capture current experiment as reference", value: "capture" },
        {
          label: "Load a saved session or JSON trace as reference",
          value: "load",
        },
        { label: "Export comparison JSON", value: "export" },
        { label: "Clear reference", value: "clear" },
        { label: "Seek first difference", value: "first" },
      ],
      (choice) => {
        if (choice === "capture") s.pinExperiment();
        if (choice === "first") {
          const tick = s.comparison()?.firstDifference;
          if (tick !== null && tick !== undefined) s.seek(tick);
        }
        if (choice === "clear") {
          s.reference = null;
          s.comparisonCache = null;
          s.seek(s.tick);
          s.setMessage("Comparison reference cleared.");
        }
        if (choice === "load")
          app.prompt("Reference session/trace path", "", (path) =>
            app.task(() =>
              s.loadComparisonFile(
                resolve(path.replace(/^(['"])(.*)\1$/, "$2")),
              ),
            ),
          );
        if (choice === "export") {
          if (!s.reference)
            throw new Error("Capture or load a reference first.");
          app.prompt(
            "Comparison JSON path",
            s.modelId + ".comparison.json",
            (path) =>
              app.task(async () => {
                await writeJSON(
                  resolve(path.replace(/^(['"])(.*)\1$/, "$2")),
                  comparisonJSON(s.reference, s.experiment(), s.comparison()),
                );
                s.setMessage("Experiment comparison exported.");
              }),
          );
        }
      },
    );
  }
}
