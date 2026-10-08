import { analyzeDocument } from "../model/from-document.js";
import {
  builtinModels,
  defaultParameters,
  registerModel,
} from "../models/index.js";
import { normalizeParameters, validateInputs } from "../model/engine.js";
import { registerAccessInputs } from "../model/register-access.js";
import { extractPDFFile } from "../documents/extract-node.js";
import { modelsForDocument, searchDocument } from "../documents/recognize.js";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Workspace } from "./workspace.js";
import { Stimulus } from "./stimulus.js";
export class TuiState {
  constructor({
    workspace = ".chipsim",
    root = resolve(import.meta.dirname, "../.."),
  } = {}) {
    this.workspace = new Workspace(workspace);
    this.root = root;
    this.models = [...builtinModels];
    this.documents = [];
    this.modelId = "pio";
    this.configurations = new Map();
    this.stimulus = new Stimulus(this);
    this.trace = [];
    this.tick = 0;
    this.selected = 0;
    this.view = "wave";
    this.format = "hex";
    this.zoom = 1;
    this.offset = 0;
    this.rows = 40;
    this.columns = 120;
    this.message = "Ready · ? help";
    this.error = false;
    this.busy = false;
    this.playing = false;
    this.logFilter = "";
    this.changesOnly = true;
    this.logIndex = 0;
    this.registerIndex = 0;
    this.registerFilter = "";
    this.stimulusIndex = 0;
    this.stimulusFilter = "";
    this.infoScroll = 0;
    this.blockScroll = 0;
    this.documentId = null;
    this.page = 1;
    this.sourceScroll = 0;
    this.sourceQuery = "";
    this.sourceHits = [];
    this.sourceHitIndex = 0;
    this.nameSearch = "";
  }
  get model() {
    return this.models.find((m) => m.id === this.modelId);
  }
  get config() {
    if (!this.configurations.has(this.modelId))
      this.configurations.set(this.modelId, {
        parameters: defaultParameters(this.model),
        inputs: structuredClone(this.model.exampleInputs || []),
        duration: this.model.duration || 100,
      });
    return this.configurations.get(this.modelId);
  }
  get snapshot() {
    return this.trace[this.tick] || this.trace.at(-1);
  }
  get document() {
    return this.documents.find((d) => d.id === this.documentId);
  }
  setView(view) {
    this.view = view;
    if (view === "log")
      this.logIndex = Math.max(
        0,
        this.logs().findIndex((snapshot) => snapshot.tick >= this.tick),
      );
    if (view === "stimulus") {
      const events = this.stimulus.events();
      const next = events.findIndex((event) => event.tick >= this.tick);
      this.stimulusIndex = next < 0 ? Math.max(0, events.length - 1) : next;
    }
  }
  get signal() {
    return this.model.signals[this.selected] || this.model.signals[0];
  }
  setMessage(message, error = false) {
    this.message = message;
    this.error = error;
  }
  async initialize() {
    const docs = await this.workspace.records("documents");
    this.documents = docs.entries.filter(
      (d) => typeof d.sha256 === "string" && Array.isArray(d.pages),
    );
    const saved = await this.workspace.records("models");
    let packaged = [];
    for (const file of await readdir(resolve(this.root, "models")))
      if (file.endsWith(".json"))
        packaged.push(
          JSON.parse(
            await readFile(resolve(this.root, "models", file), "utf8"),
          ),
        );
    const errors = [...docs.errors, ...saved.errors];
    for (const spec of [...packaged, ...saved.entries])
      try {
        const model = registerModel(spec, this.documents);
        const index = this.models.findIndex((m) => m.id === model.id);
        if (index < 0) this.models.push(model);
        else this.models[index] = model;
      } catch (error) {
        errors.push(error.message);
      }
    this.documentId = this.documents.at(-1)?.id || null;
    this.rebuild();
    if (errors.length) this.setMessage("Workspace: " + errors.join("; "), true);
  }
  rebuild() {
    const c = this.config;
    const trace = this.model.simulate(c.parameters, {
      inputs: c.inputs,
      ticks: c.duration,
    });
    this.trace = trace;
    this.tick = 0;
    this.offset = 0;
    this.playing = false;
  }
  selectModel(id) {
    if (!this.models.some((m) => m.id === id))
      throw new Error("Unknown model " + id);
    this.modelId = id;
    this.selected = 0;
    this.logIndex = 0;
    this.blockScroll = 0;
    this.rebuild();
    const document = this.documents.find((d) =>
      this.model.sources.some((s) => s.sha256 === d.sha256),
    );
    if (document) {
      this.documentId = document.id;
      this.page = this.model.evidence?.[0]?.page || 1;
    }
    this.setMessage("Loaded " + this.model.name);
  }
  setParameter(id, value) {
    const parameters = normalizeParameters(this.model.parameters, {
      ...this.config.parameters,
      [id]: value,
    });
    this.config.parameters = parameters;
    this.rebuild();
    this.stimulus.clearHistory(this.modelId);
    this.setMessage("Updated " + id);
  }
  setInputs(inputs) {
    this.stimulus.apply(inputs, { reset: true });
    this.setMessage(
      "Stimulus applied · " + this.config.inputs.length + " events",
    );
  }
  driveInput(signalId, value, tick = this.tick) {
    this.stimulus.drive(signalId, value, tick);
  }
  setDuration(ticks) {
    if (this.model.kind === "builtin")
      throw new Error("Built-in duration follows frame and ACK controls.");
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10000)
      throw new Error("Duration must be 1–10000 ticks.");
    this.config.duration = ticks;
    this.rebuild();
    this.stimulus.clearHistory(this.modelId);
  }
  accessRegister(operation, address, value = 0) {
    const tick = this.tick + 1;
    const inputs = registerAccessInputs(this.model, this.config.inputs, {
      tick,
      operation,
      address,
      value,
    });
    const duration = Math.max(this.config.duration, tick);
    const trace = this.model.simulate(this.config.parameters, {
      inputs,
      ticks: duration,
    });
    const fault = trace.find((snapshot) => snapshot.phase === "fault");
    if (fault)
      throw new Error(
        `Simulation fault at tick ${fault.tick}: ${fault.detail || fault.message}`,
      );
    const bus = this.model.registerInterface;
    const result = trace[tick].signals;
    if (!result[bus.valid] || result[bus.error])
      throw new Error(
        "Register access was not accepted at tick " +
          tick +
          "; inspect reset and address rules.",
      );
    this.stimulus.remember();
    this.config.inputs = inputs;
    this.config.duration = duration;
    this.trace = trace;
    this.playing = false;
    this.seek(tick);
    this.setMessage(
      `${operation} address ${address} at tick ${tick} · ${operation === "read" ? "read_data=" + result[bus.readData] : "inspect latch/driver changes"}`,
    );
  }
  seek(tick) {
    if (!Number.isFinite(tick)) throw new Error("Tick must be finite.");
    this.tick = Math.max(0, Math.min(this.trace.length - 1, Math.round(tick)));
    const span = Math.max(1, (this.columns - 30) / this.zoom);
    if (this.tick < this.offset) this.offset = this.tick;
    if (this.tick > this.offset + span)
      this.offset = Math.max(0, this.tick - Math.floor(span * 0.7));
  }
  moveSignal(amount) {
    this.selected = Math.max(
      0,
      Math.min(this.model.signals.length - 1, this.selected + amount),
    );
  }
  jumpEdge(kind, direction = 1) {
    const current = this.tick,
      id = this.signal.id;
    const indexes =
      direction > 0
        ? Array.from(
            { length: this.trace.length - current - 1 },
            (_, i) => current + i + 1,
          )
        : Array.from(
            { length: Math.max(0, current - 1) },
            (_, i) => current - i - 1,
          );
    for (const index of indexes) {
      const before = this.trace[index - 1]?.signals[id],
        after = this.trace[index].signals[id];
      if (before === undefined) continue;
      if (
        kind === "any"
          ? before !== after
          : kind === "rise"
            ? typeof before === "number" &&
              typeof after === "number" &&
              after > before
            : typeof before === "number" &&
              typeof after === "number" &&
              after < before
      ) {
        this.seek(direction > 0 ? index : index);
        return;
      }
    }
    this.setMessage("No " + kind + " edge in that direction.");
  }
  jumpChange(direction = 1) {
    for (
      let index = this.tick + direction;
      index >= 0 && index < this.trace.length;
      index += direction
    )
      if (this.trace[index].changes.length) {
        this.seek(index);
        return;
      }
  }
  zoomBy(factor) {
    this.zoom = Math.max(0.02, Math.min(16, this.zoom * factor));
    this.offset = Math.max(
      0,
      this.tick - Math.floor((this.columns - 30) / (2 * this.zoom)),
    );
  }
  fit() {
    this.zoom = Math.max(
      0.02,
      Math.min(16, (this.columns - 30) / Math.max(1, this.trace.length - 1)),
    );
    this.offset = 0;
  }
  center() {
    this.offset = Math.max(
      0,
      this.tick - Math.floor((this.columns - 30) / (2 * this.zoom)),
    );
  }
  findSignal(query, direction = 1) {
    if (query !== undefined) this.nameSearch = query;
    const signals = this.model.signals;
    for (let n = 1; n <= signals.length; n++) {
      const index =
        (this.selected + direction * n + signals.length * 2) % signals.length;
      if (
        (signals[index].id + " " + signals[index].label)
          .toLowerCase()
          .includes(this.nameSearch.toLowerCase())
      ) {
        this.selected = index;
        return;
      }
    }
    this.setMessage("No matching signal.");
  }
  registers() {
    return [
      ...Object.entries(this.snapshot.signals).map(([id, value]) => ({
        id: "signal." + id,
        key: id,
        value,
        width: this.model.signals.find((s) => s.id === id).width,
        kind: "signals",
      })),
      ...Object.entries(this.snapshot.registers).map(([id, value]) => ({
        id: "reg." + id,
        key: id,
        value,
        width: this.model.registers?.find((r) => r.id === id)?.width || 32,
        kind: "registers",
      })),
    ]
      .map((item) => {
        const entry = this.model.registerMap?.find(
          (entry) => entry.value === item.id,
        );
        return {
          ...item,
          address: entry?.address,
          label: entry
            ? `0x${entry.address.toString(16).padStart(2, "0")} ${entry.name}`
            : item.id,
        };
      })
      .filter((item) =>
        (item.id + " " + item.label)
          .toLowerCase()
          .includes(this.registerFilter.toLowerCase()),
      );
  }
  logs() {
    const query = this.logFilter.toLowerCase();
    return this.trace.filter(
      (s) =>
        (!this.changesOnly || s.changes.length || s.phase === "fault") &&
        `${s.state} ${s.message} ${s.changes.map((c) => c.id).join(" ")}`
          .toLowerCase()
          .includes(query),
    );
  }
  searchSources(query) {
    if (!this.document) throw new Error("Import a PDF first (d).");
    this.sourceQuery = query;
    this.sourceHits = searchDocument(this.document, query, 100);
    this.sourceHitIndex = 0;
    if (this.sourceHits.length) {
      this.page = this.sourceHits[0].page;
      this.sourceScroll = 0;
      this.setMessage(
        this.sourceHits.length + " matching pages · n/N next/previous",
      );
    } else this.setMessage("No matching pages.");
  }
  nextSourceHit(direction = 1) {
    if (!this.sourceHits.length) return;
    this.sourceHitIndex =
      (this.sourceHitIndex + direction + this.sourceHits.length) %
      this.sourceHits.length;
    this.page = this.sourceHits[this.sourceHitIndex].page;
    this.sourceScroll = 0;
  }
  async installModel(spec) {
    const registered = registerModel(spec, this.documents);
    await this.workspace.saveModel(spec);
    const index = this.models.findIndex((m) => m.id === registered.id);
    if (index < 0) this.models.push(registered);
    else this.models[index] = registered;
    this.configurations.delete(registered.id);
    this.stimulus.clearHistory(registered.id);
    this.selectModel(registered.id);
    this.setMessage(
      "Added " +
        registered.name +
        " · " +
        registered.checks.length +
        " checks passed" +
        (registered.warnings.length
          ? " · attach source PDF to verify quotations"
          : ""),
    );
  }
  async loadFile(path, onProgress = () => {}) {
    path = resolve(path);
    if (/\.pdf$/i.test(path)) {
      const extracted = await extractPDFFile(path, { onProgress });
      const existing = this.documents.find(
        (d) => d.sha256 === extracted.sha256,
      );
      const document = await this.workspace.saveDocument({
        ...extracted,
        filename: existing?.filename || extracted.filename,
        createdAt: existing?.createdAt || extracted.createdAt,
      });
      if (existing) this.documents[this.documents.indexOf(existing)] = document;
      else this.documents.push(document);
      this.documentId = document.id;
      this.page = 1;
      this.sourceScroll = 0;
      const errors = [];
      this.models = this.models.flatMap((model) => {
        if (model.kind === "builtin") return [model];
        try {
          return [registerModel(model.spec, this.documents)];
        } catch (error) {
          errors.push(model.name + ": " + error.message);
          return [];
        }
      });
      if (!this.models.some((m) => m.id === this.modelId)) this.modelId = "pio";
      let compiled = null;
      if (
        !this.models.some(
          (model) =>
            model.kind === "document" &&
            model.sources.some((source) => source.sha256 === document.sha256),
        )
      ) {
        try {
          const analysis = analyzeDocument(document, {
            reservedIds: this.models.map((model) => model.id),
          });
          document.analysis = {
            models: analysis.models.map((model) => ({
              id: model.spec.id,
              name: model.spec.name,
              method: model.method,
              checks: model.checks.length,
            })),
            diagnostics: analysis.diagnostics,
          };
          for (const result of analysis.models)
            await this.installModel(result.spec);
          compiled = analysis.models[0] || null;
          await this.workspace.saveDocument(document);
        } catch (error) {
          errors.push(error.message);
        }
      }
      const matches = modelsForDocument(document, this.models);
      const selected = matches.find((m) => m.kind === "document") || matches[0];
      if (selected) {
        this.selectModel(selected.id);
        if (compiled)
          this.setMessage(
            "Created " +
              selected.name +
              " from " +
              compiled.method +
              " · " +
              compiled.checks.length +
              " checks passed · 5 scope/assumptions",
          );
      } else {
        this.rebuild();
        this.view = "sources";
        this.setMessage(
          document.analysis?.diagnostics.length
            ? "PDF imported · table needs review: " +
                document.analysis.diagnostics[0].reason
            : "PDF imported · c creates a local scenario · / searches this manual",
        );
      }
      if (errors.length)
        this.setMessage(
          "Source verification rejected: " + errors.join("; "),
          true,
        );
      return document;
    }
    const text = await readFile(path, "utf8");
    if (text.length > 3 * 1048576) throw new Error("JSON file exceeds 3 MiB.");
    const json = JSON.parse(text);
    if (json.format === "chipsim-session") {
      await this.loadSession(json);
      return;
    }
    await this.installModel(json);
  }
  session() {
    return {
      format: "chipsim-session",
      version: 1,
      modelId: this.modelId,
      model: this.model.spec || null,
      parameters: this.config.parameters,
      inputs: this.config.inputs,
      duration: this.config.duration,
      tick: this.tick,
      display: this.format,
    };
  }
  async loadSession(session) {
    if (session.version !== 1) throw new Error("Unsupported session version");
    if (session.model) await this.installModel(session.model);
    const model = this.models.find((m) => m.id === session.modelId);
    if (!model) throw new Error("Session model is not installed.");
    const parameters = normalizeParameters(
        model.parameters,
        session.parameters,
      ),
      inputs = validateInputs(model.signals, session.inputs || []);
    if (
      !Number.isInteger(session.duration) ||
      session.duration < 1 ||
      session.duration > 10000
    )
      throw new Error("Invalid duration in session.");
    this.configurations.set(model.id, {
      parameters,
      inputs,
      duration: session.duration,
    });
    this.stimulus.clearHistory(model.id);
    this.selectModel(model.id);
    this.format = ["hex", "decimal", "binary", "octal"].includes(
      session.display,
    )
      ? session.display
      : "hex";
    this.seek(Number.isInteger(session.tick) ? session.tick : 0);
    this.setMessage("Session restored.");
  }
}
