import { emitKeypressEvents } from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parsePayload, formatPayload } from "../core/values.js";
import { exportCSV, exportJSON, exportVCD } from "../trace/export.js";
import { sourceBundle } from "../documents/recognize.js";
import {
  templates,
  suggestScenarios,
  buildScenario,
  modelId,
} from "../model/templates.js";
import { writeJSON } from "./workspace.js";
import { screenText } from "./render.js";
const unquote = (path) =>
  /^(['"]).*\1$/.test(path) ? path.slice(1, -1) : path;
export class TerminalApp {
  constructor(
    state,
    {
      input = process.stdin,
      output = process.stdout,
      color = true,
      viewer = "dwfv",
      onExit = () => {},
    } = {},
  ) {
    this.state = state;
    this.input = input;
    this.output = output;
    this.color = color;
    this.viewer = viewer;
    this.onExit = onExit;
    this.closed = false;
    this.external = false;
    this.previousRaw = input.isRaw || false;
    this.keyHandler = (text, key) => this.key(text, key);
    this.resizeHandler = () => this.draw();
    this.timer = null;
  }
  draw() {
    if (this.closed || this.external) return;
    this.state.columns = this.output.columns || 120;
    this.state.rows = this.output.rows || 40;
    this.output.write(
      "\x1b[H" +
        screenText(this.state, { color: this.color }).replaceAll("\n", "\r\n") +
        "\x1b[J",
    );
  }
  start() {
    emitKeypressEvents(this.input);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("keypress", this.keyHandler);
    this.output.on("resize", this.resizeHandler);
    this.output.write("\x1b[?1049h\x1b[?25l");
    this.timer = setInterval(() => {
      if (
        this.state.playing &&
        !this.state.busy &&
        !this.state.prompt &&
        !this.state.menu &&
        !this.external
      ) {
        this.state.seek(this.state.tick + 1);
        if (
          this.state.tick >= this.state.trace.length - 1 ||
          ["fault", "success", "timeout", "complete"].includes(
            this.state.snapshot.phase,
          )
        )
          this.state.playing = false;
        this.draw();
      }
    }, 200);
    this.draw();
    return this;
  }
  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.input.off("keypress", this.keyHandler);
    this.output.off("resize", this.resizeHandler);
    this.input.setRawMode(this.previousRaw);
    this.input.pause();
    this.output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    this.onExit(code);
  }
  async task(action) {
    this.state.busy = true;
    this.state.playing = false;
    this.draw();
    try {
      await action();
    } catch (error) {
      this.state.setMessage(error.message, true);
    } finally {
      this.state.busy = false;
      this.draw();
    }
  }
  prompt(
    label,
    defaultValue,
    onSubmit,
    { help = "", allowEmpty = false } = {},
  ) {
    this.state.playing = false;
    this.state.prompt = {
      label,
      defaultValue: String(defaultValue ?? ""),
      value: "",
      error: "",
      help,
      allowEmpty,
      onSubmit,
    };
    this.draw();
  }
  menu(title, items, onSelect, selected = 0) {
    this.state.playing = false;
    this.state.menu = { title, items, selected, onSelect };
    this.draw();
  }
  parameterMenu() {
    const m = this.state.model;
    if (!m.parameters.length) {
      this.state.setMessage(
        "This model has no runtime parameters. Edit or recreate its definition to change fixed resources.",
      );
      return;
    }
    this.menu(
      "PARAMETERS · " + m.name,
      m.parameters.map((p) => ({
        label:
          (p.advanced ? "(advanced) " : "") +
          (p.label || p.id) +
          " = " +
          this.state.config.parameters[p.id],
        value: p,
      })),
      (p) => {
        const current = this.state.config.parameters[p.id];
        if (p.type === "enum")
          this.menu(
            p.label || p.id,
            p.options.map((value) => ({ label: value, value })),
            (value) => this.state.setParameter(p.id, value),
            p.options.indexOf(current),
          );
        else if (p.type === "boolean")
          this.menu(
            p.label || p.id,
            [
              { label: "true", value: true },
              { label: "false", value: false },
            ],
            (value) => this.state.setParameter(p.id, value),
            current ? 0 : 1,
          );
        else
          this.prompt(
            (p.label || p.id) + ` · ${p.min}–${p.max}`,
            current,
            (text) => {
              const parsed = parsePayload(text);
              if (!parsed)
                throw new Error("Use decimal, 0x, 0b, or 0o whole numbers.");
              this.state.setParameter(p.id, parsed.value);
            },
          );
      },
    );
  }
  async saveTrace(format, path) {
    const s = this.state,
      content =
        format === "csv"
          ? exportCSV(s.model, s.trace)
          : format === "vcd"
            ? exportVCD(s.model, s.trace)
            : exportJSON(
                s.model,
                s.trace,
                s.config.parameters,
                s.config.inputs,
              );
    path = resolve(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    s.setMessage("Saved " + path);
    return path;
  }
  exportMenu() {
    this.menu(
      "EXPORT FULL TRACE",
      [
        { label: "CSV", value: "csv" },
        { label: "JSON · provenance + parameters + stimulus", value: "json" },
        { label: "VCD · normalized tick waveform", value: "vcd" },
      ],
      (format) =>
        this.prompt(
          "Output path",
          this.state.model.id + "-trace." + format,
          (path) => this.task(() => this.saveTrace(format, unquote(path))),
        ),
    );
  }
  async openViewer() {
    await this.task(async () => {
      const path = await this.saveTrace(
        "vcd",
        this.state.workspace.exportPath(this.state.model.id + ".vcd"),
      );
      this.external = true;
      this.input.pause();
      this.input.setRawMode(this.previousRaw);
      this.output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(this.viewer, [path], { stdio: "inherit" });
          child.once("error", (error) =>
            reject(
              error.code === "ENOENT"
                ? new Error(
                    "dwfv is not installed. See docs/TUI.md for the optional viewer.",
                  )
                : error,
            ),
          );
          child.once("exit", (code, signal) =>
            code === 0
              ? resolve()
              : reject(new Error("dwfv exited with " + (signal || code))),
          );
        });
        this.state.setMessage("Returned from dwfv.");
      } finally {
        this.external = false;
        this.input.setRawMode(true);
        this.input.resume();
        this.output.write("\x1b[?1049h\x1b[?25l");
      }
    });
  }
  sourcesMenu() {
    if (!this.state.documents.length) {
      if (this.state.model.kind === "builtin") {
        const source = this.state.model.sources[0];
        if (source?.path?.startsWith("docs/references/"))
          return this.task(async () => {
            await this.state.loadFile(
              resolve(this.state.root, source.path),
              (message) => {
                this.state.setMessage(message);
                this.draw();
              },
            );
            this.state.view = "sources";
            this.state.page = source.pdf_start_page || 1;
          });
      }
      this.state.setMessage("Import a PDF with d first.");
      return;
    }
    this.menu(
      "REFERENCE MANUALS",
      this.state.documents.map((document) => ({
        label: document.filename + " · " + document.pages.length + " pages",
        value: document,
      })),
      (document) => {
        this.state.documentId = document.id;
        this.state.page = 1;
        this.state.sourceScroll = 0;
        this.state.view = "sources";
      },
    );
  }
  createScenario() {
    if (!this.state.document) {
      this.state.setMessage(
        "Import a reference PDF with d before creating a scenario.",
      );
      return;
    }
    const document = this.state.document,
      suggestions = suggestScenarios(document);
    this.menu(
      "CREATE · choose peripheral",
      templates.map((template) => ({
        label: template.label + " · " + template.description,
        value: template.id,
      })),
      (kind) => {
        const choices = suggestions.filter((s) => s.kind === kind);
        const create = (source) =>
          this.scenarioQuestions(document, kind, source);
        if (choices.length)
          this.menu(
            "CHOOSE SOURCE EXCERPT",
            choices.map((source) => ({
              label:
                "PDF page " +
                source.page +
                (source.width ? " · " + source.width + "-bit" : "") +
                " · " +
                source.quote,
              value: source,
            })),
            create,
          );
        else
          create({
            kind,
            page: this.state.page,
            quote:
              document.pages
                .find((p) => p.number === this.state.page)
                ?.text.slice(0, 500) || "",
            width: null,
          });
      },
    );
  }
  scenarioQuestions(document, kind, source) {
    this.state.view = "sources";
    this.state.page = source.page;
    const options = {
      kind,
      depth: 4,
      direction: kind === "shifter" ? "lsb" : "up",
      match: "repeat",
    };
    const integer = (text, min, max) => {
      const parsed = parsePayload(text);
      if (!parsed || parsed.value < min || parsed.value > max)
        throw new Error(`Use a whole number from ${min} to ${max}.`);
      return parsed.value;
    };
    const choice = (text, values) => {
      if (!values.includes(text))
        throw new Error("Choose " + values.join(" or "));
      return text;
    };
    const questions = [
      {
        key: "name",
        label: "Simulation name",
        value:
          document.title + " · " + templates.find((t) => t.id === kind).label,
      },
      {
        key: "width",
        label:
          kind === "fifo"
            ? "Word width · bits"
            : "Counter/transfer width · bits",
        value: source.width || (kind === "counter" ? 16 : 8),
        parse: (text) => integer(text, 1, 32),
      },
      ...(kind === "fifo"
        ? [
            {
              key: "depth",
              label: "FIFO depth · words",
              value: 4,
              parse: (text) => integer(text, 1, 16),
            },
          ]
        : [
            {
              key: "direction",
              label:
                kind === "counter"
                  ? "Direction · up or down"
                  : "Bit order · lsb or msb",
              value: kind === "counter" ? "up" : "lsb",
              parse: (text) =>
                choice(
                  text,
                  kind === "counter" ? ["up", "down"] : ["lsb", "msb"],
                ),
            },
            ...(kind === "counter"
              ? [
                  {
                    key: "match",
                    label: "At compare · repeat or halt",
                    value: "repeat",
                    parse: (text) => choice(text, ["repeat", "halt"]),
                  },
                ]
              : []),
            {
              key: "value",
              label:
                kind === "counter"
                  ? "Default period · enabled steps"
                  : "Default payload · decimal/0x/0b/0o",
              value: () =>
                kind === "counter"
                  ? Math.min(8, 2 ** options.width)
                  : formatPayload(
                      Math.min(179, 2 ** options.width - 1),
                      "hex",
                      options.width,
                    ),
              parse: (text) =>
                integer(
                  text,
                  kind === "counter" ? 1 : 0,
                  kind === "counter"
                    ? Math.min(2 ** options.width, 0xffffffff)
                    : 2 ** options.width - 1,
                ),
            },
          ]),
      {
        key: "page",
        label: "Evidence PDF page · one-based",
        value: source.page,
        parse: (text) => integer(text, 1, document.pages.length),
      },
      {
        key: "quote",
        label: "Exact source excerpt · Enter uses selected excerpt",
        value: () =>
          options.page === source.page
            ? source.quote
            : document.pages
                .find((p) => p.number === options.page)
                ?.text.slice(0, 500) || "",
        parse: (text) => {
          const normalize = (value) =>
            String(value).replace(/\s+/g, " ").trim();
          const page = document.pages.find((p) => p.number === options.page);
          if (
            text.length < 8 ||
            text.length > 1000 ||
            !normalize(page?.text).includes(normalize(text))
          )
            throw new Error(
              "Quote must occur on the selected PDF page and contain 8–1000 characters.",
            );
          return text;
        },
      },
      {
        key: "claim",
        label: "What the excerpt supports",
        value:
          "This excerpt is retained for the developer’s review. Selected scenario rules are declared separately; behavior is not inferred automatically.",
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
        return this.task(async () => {
          let id = modelId(options.name),
            base = id,
            suffix = 2;
          while (this.state.models.some((m) => m.id === id))
            id = base + "-" + suffix++;
          const { spec } = buildScenario(document, { ...options, id });
          await this.state.installModel(spec);
          this.state.view = "wave";
        });
      const q = questions[index],
        value = typeof q.value === "function" ? q.value() : q.value;
      this.prompt(
        q.label,
        value,
        (text) => {
          options[q.key] = q.parse ? q.parse(text) : text;
          next(index + 1);
        },
        {
          allowEmpty: q.allowEmpty,
          help: "Selected scenario rules are explicit assumptions; inspect them under Model/Sources or export model JSON.",
        },
      );
    };
    next(0);
  }
  search() {
    const s = this.state;
    if (s.view === "registers")
      this.prompt(
        "Filter register / signal names",
        s.registerFilter,
        (text) => {
          s.registerFilter = text;
          s.registerIndex = 0;
        },
        { allowEmpty: true },
      );
    else if (s.view === "sources")
      this.prompt("Search manual text", s.sourceQuery, (text) =>
        s.searchSources(text),
      );
    else if (s.view === "log")
      this.prompt(
        "Filter log events / states / register names",
        s.logFilter,
        (text) => {
          s.logFilter = text;
          s.logIndex = 0;
        },
        { allowEmpty: true },
      );
    else
      this.prompt("Search signal names", s.nameSearch, (text) =>
        s.findSignal(text),
      );
  }
  key(text, key = {}) {
    if (this.closed || this.external) return;
    if (key.ctrl && key.name === "c") {
      this.close();
      return;
    }
    const s = this.state;
    if (s.prompt) {
      const p = s.prompt;
      if (key.name === "escape") {
        s.prompt = null;
        this.draw();
        return;
      }
      if (key.name === "return") {
        const value = p.value || p.defaultValue;
        if (!value && !p.allowEmpty) {
          p.error = "A value is required.";
          this.draw();
          return;
        }
        try {
          s.prompt = null;
          const result = p.onSubmit(value);
          if (result?.catch)
            result.catch((error) => {
              s.setMessage(error.message, true);
              this.draw();
            });
        } catch (error) {
          s.prompt = p;
          p.error = error.message;
        }
        this.draw();
        return;
      }
      if (key.name === "backspace")
        p.value = Array.from(p.value).slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") p.value = "";
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text))
        p.value = (p.value + text).slice(0, 4096);
      this.draw();
      return;
    }
    if (s.menu) {
      const menu = s.menu;
      if (key.name === "escape" || text === "q") {
        s.menu = null;
        this.draw();
        return;
      }
      if (["up", "k"].includes(key.name) || text === "k")
        menu.selected = Math.max(0, menu.selected - 1);
      else if (["down", "j"].includes(key.name) || text === "j")
        menu.selected = Math.min(menu.items.length - 1, menu.selected + 1);
      else if (key.name === "return") {
        try {
          s.menu = null;
          const result = menu.onSelect(menu.items[menu.selected].value);
          if (result?.catch)
            result.catch((error) => {
              s.setMessage(error.message, true);
              this.draw();
            });
        } catch (error) {
          s.setMessage(error.message, true);
        }
      }
      this.draw();
      return;
    }
    if (s.help) {
      if (key.name === "escape" || text === "?") s.help = false;
      else if (text === "q") this.close();
      this.draw();
      return;
    }
    if (s.busy) {
      if (text === "q") this.close();
      return;
    }
    try {
      const k = text || key.name;
      if (k === "q") {
        this.close();
        return;
      }
      if (k === "?") s.help = true;
      else if (k === "m")
        this.menu(
          "MODELS",
          s.models.map((model) => ({
            label:
              model.name +
              " · " +
              (model.kind === "builtin"
                ? model.metadata.tag
                : "document-backed"),
            value: model.id,
          })),
          (id) => s.selectModel(id),
          s.models.findIndex((m) => m.id === s.modelId),
        );
      else if (k === "p") this.parameterMenu();
      else if (k === "d")
        this.prompt("Import PDF, model JSON, or session JSON", "", (path) =>
          this.task(() =>
            s.loadFile(unquote(path), (message) => {
              s.setMessage(message);
              this.draw();
            }),
          ),
        );
      else if (k === "c") this.createScenario();
      else if (k === "x") this.exportMenu();
      else if (k === "V") this.openViewer();
      else if (k === "S")
        this.prompt("Save session path", "chipsim-session.json", (path) =>
          this.task(async () => {
            await writeJSON(resolve(unquote(path)), s.session());
            s.setMessage("Session saved.");
          }),
        );
      else if (k === "M") {
        if (!s.model.spec)
          throw new Error(
            "Built-in models are implemented in source modules; only document models export as JSON.",
          );
        this.prompt("Save model path", s.model.id + ".model.json", (path) =>
          this.task(async () => {
            await writeJSON(resolve(unquote(path)), s.model.spec);
            s.setMessage("Model JSON saved.");
          }),
        );
      } else if (k === "B") {
        if (!s.document) throw new Error("Import a PDF first.");
        this.prompt(
          "Export source bundle path",
          s.document.filename.replace(/\.pdf$/i, "") + ".sources.json",
          (path) =>
            this.task(async () => {
              await writeJSON(
                resolve(unquote(path)),
                sourceBundle([s.document]),
              );
              s.setMessage("Source bundle exported.");
            }),
        );
      } else if (k === "a")
        this.prompt("Stimulus JSON array or JSON file path", "[]", (value) =>
          this.task(async () => {
            const text = value.trim().startsWith("[")
              ? value
              : await readFile(resolve(unquote(value)), "utf8");
            s.setInputs(JSON.parse(text));
          }),
        );
      else if (k === "t")
        this.prompt("Go to normalized tick", s.tick, (text) => {
          const parsed = parsePayload(text);
          if (!parsed || parsed.value >= s.trace.length)
            throw new Error("Tick must be 0–" + (s.trace.length - 1));
          s.seek(parsed.value);
        });
      else if (k === "T")
        this.prompt(
          "Document model duration · ticks",
          s.config.duration,
          (text) => {
            const parsed = parsePayload(text);
            s.setDuration(parsed?.value);
          },
        );
      else if (k === "F") {
        const formats = ["hex", "decimal", "binary", "octal"];
        s.format = formats[(formats.indexOf(s.format) + 1) % formats.length];
      } else if (k === "f")
        this.prompt("Find selected signal value", 0, (text) => {
          const parsed = parsePayload(text);
          if (!parsed)
            throw new Error("Use a decimal, hex, binary, or octal value.");
          const found = s.trace.find(
            (snapshot) =>
              snapshot.tick > s.tick &&
              snapshot.signals[s.signal.id] === parsed.value,
          );
          if (found) s.seek(found.tick);
          else s.setMessage("No later matching signal value.");
        });
      else if (k === "/") this.search();
      else if (k === "n" || k === "N") {
        if (s.view === "sources") s.nextSourceHit(k === "n" ? 1 : -1);
        else s.findSignal(undefined, k === "n" ? 1 : -1);
      } else if (["1", "2", "3", "4", "5", "6"].includes(k))
        s.setView(
          ["wave", "inspect", "log", "sources", "model", "registers"][
            Number(k) - 1
          ],
        );
      else if (key.name === "tab")
        s.setView(
          ["wave", "inspect", "log", "sources", "model", "registers"][
            ([
              "wave",
              "inspect",
              "log",
              "sources",
              "model",
              "registers",
            ].indexOf(s.view) +
              1) %
              6
          ],
        );
      else if (k === " " || key.name === "space") {
        if (s.tick === s.trace.length - 1) s.seek(0);
        s.playing = !s.playing;
      } else if (k === "r") {
        s.rebuild();
        s.setMessage("Reset simulation.");
      } else if (k === "0" || key.name === "home") s.seek(0);
      else if (k === "$" || key.name === "end") s.seek(s.trace.length - 1);
      else if (k === "w") s.jumpEdge("rise");
      else if (k === "e") s.jumpEdge("fall");
      else if (k === "b") s.jumpEdge("rise", -1);
      else if (k === "]") s.jumpChange(1);
      else if (k === "[") s.jumpChange(-1);
      else if (k === "+" || k === "=") {
        if (k === "=") s.fit();
        else s.zoomBy(2);
      } else if (k === "-") s.zoomBy(0.5);
      else if (k === "z") s.center();
      else if (k === "C") s.changesOnly = !s.changesOnly;
      else if (key.name === "return") {
        if (s.view === "sources") this.sourcesMenu();
        else if (s.view === "log") {
          const entry = s.logs()[s.logIndex];
          if (entry) s.seek(entry.tick);
        }
      } else if (k === "j" || key.name === "down") {
        if (s.view === "registers")
          s.registerIndex = Math.min(
            s.registers().length - 1,
            s.registerIndex + 1,
          );
        else if (s.view === "model") s.infoScroll++;
        else if (s.view === "inspect") s.blockScroll++;
        else if (s.view === "log")
          s.logIndex = Math.min(s.logs().length - 1, s.logIndex + 1);
        else if (s.view === "sources") s.sourceScroll++;
        else s.moveSignal(1);
      } else if (k === "k" || key.name === "up") {
        if (s.view === "registers")
          s.registerIndex = Math.max(0, s.registerIndex - 1);
        else if (s.view === "model")
          s.infoScroll = Math.max(0, s.infoScroll - 1);
        else if (s.view === "inspect")
          s.blockScroll = Math.max(0, s.blockScroll - 1);
        else if (s.view === "log") s.logIndex = Math.max(0, s.logIndex - 1);
        else if (s.view === "sources")
          s.sourceScroll = Math.max(0, s.sourceScroll - 1);
        else s.moveSignal(-1);
      } else if (k === "h" || key.name === "left") {
        s.playing = false;
        if (s.view === "sources" && s.document) {
          s.page = Math.max(1, s.page - 1);
          s.sourceScroll = 0;
        } else s.seek(s.tick - 1);
      } else if (k === "l" || key.name === "right") {
        s.playing = false;
        if (s.view === "sources" && s.document) {
          s.page = Math.min(s.document.pages.length, s.page + 1);
          s.sourceScroll = 0;
        } else s.seek(s.tick + 1);
      }
    } catch (error) {
      s.setMessage(error.message, true);
    }
    this.draw();
  }
}
