import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  readRegisterTables,
  registerDraftRows,
} from "../model/register-tables/read.js";
import { parsePayload } from "../core/values.js";
import { readRegisterRows } from "../model/register-bank/read.js";
import { buildRegisterBank } from "../model/register-bank/build.js";
import { textRows, askQuestion, newModelId } from "./authoring.js";

export class RegisterBankEditor {
  constructor(app) {
    this.app = app;
  }
  exportRows(table) {
    const app = this.app,
      options = {};
    askQuestion(
      app,
      {
        key: "path",
        label: "Export register row draft · output path",
        help: "Question marks must be reviewed and replaced before building. Existing files are preserved; choose a new path.",
        parse: async (text) => {
          const path = resolve(
            /^(['"]).*\1$/.test(text) ? text.slice(1, -1) : text,
          );
          await mkdir(dirname(path), { recursive: true });
          try {
            await writeFile(
              path,
              registerDraftRows(table).replace(/; /g, "\n") + "\n",
              { flag: "wx" },
            );
          } catch (error) {
            if (error.code === "EEXIST")
              throw new Error(
                "File exists; choose a new path to preserve your reviewed rows.",
              );
            throw error;
          }
          return path;
        },
      },
      options,
      app.state.workspace.exportPath(table.id + ".registers.txt"),
      () =>
        app.state.setMessage(
          "Saved register row draft " +
            options.path +
            " · replace ? fields, then load with @file",
        ),
    );
  }
  create(document, table = null, selected = false) {
    const inventory = readRegisterTables(document);
    if (!selected && inventory.tables.length)
      return this.app.menu(
        "REGISTER TABLE · choose a draft to review",
        [
          { label: "Enter rows manually", value: null },
          ...inventory.tables.map((item) => ({
            label:
              "PDF " +
              item.page +
              " · " +
              item.caption +
              " · " +
              item.rows.length +
              " words · masks need review",
            value: { kind: "table", table: item },
          })),
          ...inventory.tables.map((item) => ({
            label: "Export row draft · PDF " + item.page + " · " + item.caption,
            value: { kind: "export", table: item },
          })),
        ],
        (choice) =>
          choice?.kind === "export"
            ? this.exportRows(choice.table)
            : this.create(document, choice?.table || null, true),
      );
    const app = this.app,
      state = app.state,
      options = {};
    if (table) {
      state.page = table.page;
      state.sourceScroll = 0;
    }
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
        value: table?.width || 32,
        parse: (text) => {
          const value = parsePayload(text)?.value;
          if (table && value !== table.width)
            throw new Error(
              "This table specifies eight-bit bytes; use manual entry for another width.",
            );
          if (!value || value > 32)
            throw new Error("Use a word width from 1 to 32 bits.");
          return value;
        },
      },
      {
        key: "rows",
        label: "Register rows · NAME ADDRESS MODE RESET MASK · or @file",
        value: table ? registerDraftRows(table) : "",
        help: "Question marks are missing reset/mask fields and must be replaced with reviewed choices. Separate rows with ;. Modes: rw replaces mask bits, ro ignores writes, w1c/w1s clear/set written ones, rc clears mask bits after reading. Addresses/reset/masks accept decimal/0x/0b/0o. No inference from PDF prose.",
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
          if (table && value !== table.page)
            throw new Error(
              "Keep the extracted table's source page; use manual entry for a different source.",
            );
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
          table?.quote ||
          document.pages
            .find((page) => page.number === options.page)
            ?.text.slice(0, 500) ||
          "",
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
        value: table
          ? "The selected table supplies byte addresses, access labels and power-up patterns. Storage rules, masks, unknown initial values and side effects require developer review."
          : "",
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
            assumptions:
              (table
                ? "Selected register-table draft: " +
                  table.caption +
                  " on PDF page " +
                  table.page +
                  " supplied addresses/access/reset patterns only. Final rows are developer-entered; no peripheral side effects or writable masks were inferred.\n"
                : "") + (options.assumptions || ""),
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
