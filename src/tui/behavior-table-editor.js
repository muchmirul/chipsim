import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parsePayload } from "../core/values.js";
import {
  tableLabels,
  readBehaviorTable,
} from "../model/behavior-table/read.js";
import { buildBehaviorTable } from "../model/behavior-table/build.js";
import { textRows, askQuestion, newModelId } from "./authoring.js";
import { behaviorDraft } from "../model/behavior-table/authoring.js";
import { TraceReview } from "./trace-review.js";

export const behaviorRows = (value) => textRows(value);

// Terminal authoring only. Rule semantics/provenance/checks live in model/.
export class BehaviorTableEditor {
  constructor(app) {
    this.app = app;
  }
  questions(document, options, editing = false) {
    const state = this.app.state;
    const normalized = (text) => String(text).replace(/\s+/g, " ").trim();
    return [
      {
        key: "name",
        label: "Behavior table · simulation name",
        value: (document.title || document.filename) + " · entered behavior",
        parse: (text) => {
          if (!text.trim() || text.trim().length > 4000)
            throw new Error(
              "Give the simulation a name of at most 4000 characters.",
            );
          return text.trim();
        },
      },
      {
        key: "inputs",
        label: "Input pin names · in pattern order",
        value: "A B",
        parse: (text) => tableLabels(text, "Inputs", 6),
      },
      {
        key: "outputs",
        label: "Output pin names · in pattern order",
        value: "Y",
        parse: (text) => tableLabels(text, "Outputs", 8),
      },
      {
        key: "states",
        label: "State names · first is default initial state",
        value: "logic",
        parse: (text) => tableLabels(text, "States", 8),
      },
      {
        key: "rules",
        label: "Rows · state BITS -> nextState / BITS · or @file",
        value: "",
        help: "Separate rows with ;. Input X = wildcard; output = retains its bit; state * matches every state. No implicit priority or missing-row hold.",
        parse: async (text) => {
          const rules = await behaviorRows(text);
          if (!editing) readBehaviorTable({ ...options, rules });
          return rules;
        },
      },
      {
        key: "page",
        label: "Evidence PDF page · one-based",
        value: () => state.page,
        parse: (text) => {
          const value = parsePayload(text)?.value;
          if (!document.pages.some((page) => page.number === value))
            throw new Error("Choose an existing PDF page.");
          state.page = value;
          state.sourceScroll = 0;
          return value;
        },
      },
      {
        key: "quote",
        label: "Exact source excerpt · Enter uses page excerpt",
        value: () =>
          document.pages
            .find((page) => page.number === options.page)
            ?.text.slice(0, 500) || "",
        parse: (text) => {
          const page = document.pages.find(
            (page) => page.number === options.page,
          );
          if (
            text.trim().length < 8 ||
            text.trim().length > 1000 ||
            !normalized(page?.text).includes(normalized(text))
          )
            throw new Error(
              "Quote must occur on this PDF page and contain 8–1000 characters.",
            );
          return text;
        },
      },
      {
        key: "claim",
        label: "What this excerpt supports in the entered rows",
        value: "",
      },
      {
        key: "assumptions",
        label: "Additional assumption/omission · optional",
        value: "",
        allowEmpty: true,
        parse: (text) => {
          if (text.length > 4000)
            throw new Error(
              "Additional assumptions must be at most 4000 characters.",
            );
          return text;
        },
      },
    ];
  }
  ask(question, options, value, next) {
    return askQuestion(this.app, question, options, value, next);
  }
  create(document) {
    const app = this.app,
      state = app.state,
      options = {},
      questions = this.questions(document, options);
    state.view = "sources";
    const next = (index) => {
      if (index >= questions.length)
        return app.task(async () => {
          const { spec } = buildBehaviorTable(document, {
            ...options,
            id: this.newId(options.name),
          });
          await state.installModel(spec);
          state.setView("wave");
        });
      const question = questions[index],
        value =
          typeof question.value === "function"
            ? question.value()
            : question.value;
      this.ask(question, options, value, () => next(index + 1));
    };
    next(0);
  }
  newId(name) {
    return newModelId(this.app.state, name);
  }
  edit() {
    const state = this.app.state,
      model = state.model;
    if (!model.spec)
      throw new Error(
        "Select an entered behavior-table model first; c creates one from a PDF.",
      );
    if (!this.draft || this.draft.base !== model.spec) {
      const recovered = behaviorDraft(model.spec);
      if (!recovered)
        throw new Error(
          "This model has no reproducible behavior-table draft. Use M for JSON authoring or c to create a table.",
        );
      this.draft = { ...recovered, base: model.spec };
    }
    const document = state.documents.find(
      (document) => document.sha256 === this.draft.sourceHash,
    );
    if (!document)
      throw new Error(
        "Attach the original source PDF with d before revising this table.",
      );
    state.documentId = document.id;
    this.draft.document = document;
    this.menu();
  }
  menu(selected = 0) {
    const app = this.app,
      state = app.state,
      draft = this.draft;
    const order = [
        "rules",
        "inputs",
        "outputs",
        "states",
        "page",
        "quote",
        "claim",
        "assumptions",
        "name",
      ],
      questions = this.questions(draft.document, draft.options, true).sort(
        (a, b) => order.indexOf(a.key) - order.indexOf(b.key),
      );
    app.menu(
      "EDIT BEHAVIOR TABLE · unsaved draft",
      [
        ...questions.map((question) => ({
          label:
            question.key === "rules"
              ? "Rows · edit or load @file"
              : question.label,
          value: question,
        })),
        {
          label: "Review draft · checks and current-tick differences",
          value: "review",
        },
        { label: "Save revision · keep compatible experiment", value: "save" },
        {
          label: "Save as new model · start separate experiment",
          value: "copy",
        },
        { label: "Export draft rows to a text file", value: "export" },
        {
          label: "Revision backups · restore earlier experiment",
          value: "backups",
        },
        { label: "Discard unsaved draft", value: "discard" },
      ],
      (choice) => {
        if (typeof choice === "object") {
          if (["page", "quote", "claim"].includes(choice.key)) {
            state.setView("sources");
            state.page = draft.options.page;
            state.sourceScroll = 0;
          }
          const value = Array.isArray(draft.options[choice.key])
            ? draft.options[choice.key].join(" ")
            : draft.options[choice.key];
          return this.ask(choice, draft.options, value, () =>
            this.menu(questions.indexOf(choice)),
          );
        }
        if (choice === "discard") {
          this.draft = null;
          state.setMessage("Behavior draft discarded · working model kept");
        } else if (choice === "export")
          app.prompt(
            "Export draft rows path",
            state.modelId + ".rules.txt",
            (path) =>
              app.task(async () => {
                await writeFile(
                  resolve(/^(['"]).*\1$/.test(path) ? path.slice(1, -1) : path),
                  draft.options.rules + "\n",
                  "utf8",
                );
                this.menu(12);
                state.setMessage(
                  "Draft rows exported · edit the file and load it with @path",
                );
              }),
          );
        else if (choice === "review") return this.review();
        else if (choice === "backups") return this.backups();
        else return this.save(choice === "copy");
      },
      selected,
    );
  }
  async save(copy = false) {
    const app = this.app,
      state = app.state,
      draft = this.draft;
    return app.task(async () => {
      try {
        if (state.model.spec !== draft.base)
          throw new Error(
            "The selected model changed. Reopen E to begin a new draft.",
          );
        const { spec } = buildBehaviorTable(draft.document, {
          ...draft.options,
          id: copy ? this.newId(draft.options.name) : draft.base.id,
          // Existing independent checks remain part of a revision, never silently discarded.
          additionalChecks: copy ? [] : draft.options.additionalChecks,
        });
        if (copy) await state.installModel(spec);
        else await state.reviseModel(spec);
        this.draft = null;
        state.setView("wave");
      } catch (error) {
        this.menu(copy ? 11 : 10);
        throw error;
      }
    });
  }
  review() {
    const app = this.app,
      state = app.state,
      draft = this.draft;
    return app.task(async () => {
      try {
        const { spec, checks } = buildBehaviorTable(
          draft.document,
          draft.options,
        );
        let review;
        const lines = [
          checks.length +
            " checks passed · source quote verified · entered rules remain developer assumptions",
        ];
        try {
          const preview = state.previewRevision(spec),
            before = state.snapshot,
            after = preview.trace[state.tick];
          review = new TraceReview(app, preview, () => this.review());
          lines.push(
            "Current tick " +
              state.tick +
              ": state " +
              before.state +
              " → " +
              after.state,
          );
          for (const signal of spec.signals.filter(
            (signal) => signal.direction === "output",
          ))
            lines.push(
              signal.label +
                ": " +
                before.signals[signal.id] +
                " → " +
                after.signals[signal.id],
            );
          lines.push(
            `Full trace: ${review.comparison.changedTicks} changed ticks / ${review.comparison.ticks} · first ${review.comparison.firstDifference ?? "none"} · Enter to inspect`,
          );
        } catch (error) {
          lines.push("Current experiment: " + error.message);
        }
        lines.push(...spec.authoring.configuration.rules.split("\n"));
        app.menu(
          "DRAFT REVIEW · working model kept",
          lines.map((label) => ({
            label,
            value: label.startsWith("Full trace:") ? "differences" : null,
          })),
          (choice) => (choice === "differences" ? review.menu() : this.menu(9)),
        );
      } catch (error) {
        this.menu(9);
        throw error;
      }
    });
  }
  backups() {
    const app = this.app,
      state = app.state;
    return app.task(async () => {
      const entries = await state.workspace.revisions(state.modelId);
      if (!entries.length) {
        this.menu(13);
        state.setMessage("No revision backups for this model yet.");
        return;
      }
      app.menu(
        "REVISION BACKUPS · restore whole experiment",
        entries.map((entry) => ({
          label: entry.timestamp + " · " + entry.name,
          value: entry.path,
        })),
        (path) =>
          app.task(async () => {
            const text = await readFile(path, "utf8");
            if (text.length > 3 * 1048576)
              throw new Error("Revision session exceeds 3 MiB.");
            await state.loadSession(JSON.parse(text), { backupCurrent: true });
            this.draft = null;
            state.setView("wave");
            state.setMessage(
              "Revision restored · prior current experiment backed up · E opens history",
            );
          }),
      );
    });
  }
}
