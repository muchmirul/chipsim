import { modelsForDocument } from "../documents/recognize.js";
import { analyzeDocument } from "../model/from-document.js";

// A source chooser must use installed models, never saved analysis model IDs.
export function sourceModelItems(document, models) {
  return modelsForDocument(document, models).map((model) => ({
    label:
      model.name +
      (model.kind === "builtin" ? " · existing example" : " · document model"),
    detail:
      (model.kind === "builtin"
        ? "Existing architecture example. "
        : "Installed simulation. ") + model.scope,
    value: { kind: "open", id: model.id },
  }));
}

export class SourceSimulations {
  constructor(app) {
    this.app = app;
  }
  open(document = this.app.state.document) {
    const { app } = this,
      state = app.state;
    if (!document) {
      state.setMessage("Import a PDF with d before choosing its simulations.");
      return;
    }
    app.menu(
      "SIMULATIONS · " + document.filename,
      [
        ...sourceModelItems(document, state.models),
        {
          label: "Find supported simulations in saved PDF",
          detail:
            "Reread the saved PDF locally and check available reviewed profiles/function tables. Preview scope before creating a new model. Existing models and experiments are preserved.",
          value: { kind: "find" },
        },
        {
          label: "Create a sourced scenario",
          detail:
            "Choose counter, FIFO, shift transfer, behavior table or register bank. Enter and review the rules this manual does not yet compile automatically.",
          value: { kind: "create" },
        },
        {
          label: "Read/search this manual",
          detail:
            "Return to source text at the current page. / searches; h/l changes PDF page. Reading a manual does not change the running experiment.",
          value: { kind: "read" },
        },
      ],
      (choice) => {
        state.documentId = document.id;
        if (choice.kind === "find") return this.find(document);
        if (choice.kind === "create") return app.createScenario();
        if (choice.kind === "read") {
          state.setView("sources");
          return;
        }
        const page = state.page,
          scroll = state.sourceScroll;
        if (choice.id !== state.modelId) state.selectModel(choice.id);
        if (state.documentId !== document.id) {
          state.documentId = document.id;
          state.page = page;
          state.sourceScroll = scroll;
        }
        state.setView("wave");
        state.setMessage(
          "Opened " + state.model.name + " · 5 scope/assumptions",
        );
      },
    );
  }
  find(document) {
    const { app } = this,
      state = app.state;
    return app.task(async () => {
      let analysis;
      // Creating new executable interpretations requires hashing the saved
      // bytes again, even if the extraction version is current.
      const fresh = await state.refreshDocument(
        document.id,
        (message) => {
          state.setMessage(message);
          app.draw();
        },
        {
          force: true,
          validate: (candidate) => {
            analysis = analyzeDocument(candidate, {
              reservedIds: state.models.map((model) => model.id),
            });
          },
        },
      );
      if (!analysis.models.length) {
        this.open(fresh);
        state.setMessage(
          "No new compiled simulation found. " +
            (analysis.diagnostics[0]?.reason ||
              "Create a sourced scenario or export sources with B."),
        );
        return;
      }
      app.menu(
        "CREATE SIMULATION · selected scope only",
        [
          ...analysis.models.map((result) => ({
            label: result.spec.name + " · " + result.checks.length + " checks",
            detail:
              result.spec.scope +
              " New model ID: " +
              result.spec.id +
              ". Existing models are preserved; Esc returns without creating one.",
            value: result.spec,
          })),
          {
            label: "Back to source simulations",
            detail: "Keep the current experiment unchanged.",
            value: null,
          },
        ],
        (spec) => {
          if (!spec) return this.open(fresh);
          return app.task(async () => {
            if (state.models.some((model) => model.id === spec.id))
              throw new Error(
                "Model ID is now in use. Find supported simulations again to choose a fresh ID.",
              );
            await state.installModel(spec);
            state.setView("wave");
          });
        },
      );
      state.setMessage(
        analysis.models.length +
          " supported simulation(s) · review scope · Enter creates selected model",
      );
    });
  }
}
