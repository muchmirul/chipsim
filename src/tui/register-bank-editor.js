import { parsePayload } from "../core/values.js";
import { readRegisterRows } from "../model/register-bank/read.js";
import { buildRegisterBank } from "../model/register-bank/build.js";
import { textRows, askQuestion, newModelId } from "./authoring.js";

export class RegisterBankEditor {
  constructor(app) {
    this.app = app;
  }
  create(document) {
    const app = this.app,
      state = app.state,
      options = {};
    const questions = [
      {
        key: "name",
        label: "Register bank · simulation name",
        value: (document.title || document.filename) + " · entered registers",
        parse: (text) => {
          if (!text.trim() || text.length > 4000)
            throw new Error(
              "Give the simulation a name of at most 4000 characters.",
            );
          return text.trim();
        },
      },
      {
        key: "width",
        label: "Register word width · bits",
        value: 32,
        parse: (text) => {
          const value = parsePayload(text)?.value;
          if (!value || value > 32)
            throw new Error("Use a word width from 1 to 32 bits.");
          return value;
        },
      },
      {
        key: "rows",
        label: "Register rows · NAME ADDRESS MODE RESET MASK · or @file",
        value: "",
        help: "Separate rows with ;. Modes: rw replaces mask bits, ro ignores writes, w1c/w1s clear/set written ones, rc clears mask bits after reading. Addresses/reset/masks accept decimal/0x/0b/0o. No inference from PDF prose.",
        parse: async (text) => {
          const rows = await textRows(text, "Registers");
          readRegisterRows(rows, options.width);
          return rows;
        },
      },
      {
        key: "hardwarePriority",
        label: "Synthetic hardware set · before or after bus operation",
        value: "before",
        parse: (text) => {
          if (!["before", "after"].includes(text))
            throw new Error("Choose before or after.");
          return text;
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
          const normalize = (value) =>
            String(value).replace(/\s+/g, " ").trim();
          if (
            text.trim().length < 8 ||
            text.trim().length > 1000 ||
            !normalize(
              document.pages.find((page) => page.number === options.page)?.text,
            ).includes(normalize(text))
          )
            throw new Error(
              "Quote must occur on this PDF page and contain 8–1000 characters.",
            );
          return text;
        },
      },
      {
        key: "claim",
        label: "What the excerpt supports in these register rules",
        value: "",
      },
      {
        key: "assumptions",
        label: "Additional assumption/omission · optional",
        value: "",
        allowEmpty: true,
      },
    ];
    state.setView("sources");
    const next = (index) => {
      if (index >= questions.length)
        return app.task(async () => {
          const { spec } = buildRegisterBank(document, {
            ...options,
            id: newModelId(state, options.name),
          });
          await state.installModel(spec);
          state.setView("wave");
        });
      const question = questions[index],
        value =
          typeof question.value === "function"
            ? question.value()
            : question.value;
      askQuestion(app, question, options, value, () => next(index + 1));
    };
    next(0);
  }
}
