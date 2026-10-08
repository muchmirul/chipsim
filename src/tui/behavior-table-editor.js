import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { parsePayload } from "../core/values.js";
import {
  tableLabels,
  readBehaviorTable,
} from "../model/behavior-table/read.js";
import { buildBehaviorTable } from "../model/behavior-table/build.js";
import { modelId } from "../model/builders/sourced.js";

export async function behaviorRows(value) {
  if (!value.trim().startsWith("@")) return value;
  const path = value.trim().slice(1),
    unquoted = /^(['"]).*\1$/.test(path) ? path.slice(1, -1) : path,
    file = await open(
      resolve(unquoted),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536)
      throw new Error("Rules must be a regular text file of at most 64 KiB.");
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 65536) throw new Error("Rules file exceeds 64 KiB.");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

// Terminal authoring only. Rule semantics/provenance/checks live in model/.
export class BehaviorTableEditor {
  constructor(app) {
    this.app = app;
  }
  create(document) {
    const app = this.app,
      state = app.state,
      options = {};
    state.view = "sources";
    const normalized = (text) => String(text).replace(/\s+/g, " ").trim();
    const questions = [
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
          readBehaviorTable({ ...options, rules });
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
      },
    ];
    const next = (index) => {
      if (index >= questions.length)
        return app.task(async () => {
          const base = modelId(options.name);
          let id = base,
            suffix = 2;
          while (state.models.some((model) => model.id === id))
            id = base + "-" + suffix++;
          const { spec } = buildBehaviorTable(document, { ...options, id });
          await state.installModel(spec);
          state.setView("wave");
        });
      const question = questions[index],
        value =
          typeof question.value === "function"
            ? question.value()
            : question.value;
      let pending;
      app.prompt(
        question.label,
        value,
        (text) =>
          app.task(async () => {
            try {
              options[question.key] = question.parse
                ? await question.parse(text)
                : text;
            } catch (error) {
              state.prompt = pending;
              pending.error = error.message;
              throw error;
            }
            return next(index + 1);
          }),
        {
          allowEmpty: question.allowEmpty,
          help:
            question.help ||
            "Developer-authored rows are not inferred from the PDF. Check the cited source and declare omissions; entered-rule checks do not prove hardware fidelity.",
        },
      );
      pending = state.prompt;
    };
    next(0);
  }
}
