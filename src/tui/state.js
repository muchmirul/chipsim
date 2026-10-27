import { analyzeDocument } from "../model/from-document.js";
import {
  builtinModels,
  defaultParameters,
  registerModel,
} from "../models/index.js";
import { normalizeParameters, validateInputs } from "../model/engine.js";
import { registerAccessInputs } from "../model/register-access.js";
import { extractSourceFile } from "../documents/extract-source.js";
import { referencePath } from "../documents/references.js";
import { needsDocumentRefresh, replaceExtraction } from "../documents/cache.js";
import { modelsForDocument, searchDocument } from "../documents/recognize.js";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Workspace } from "./workspace.js";
import { Stimulus } from "./stimulus.js";
import { parseProgram } from "../program/parse.js";
import { ProgramDebugger } from "../program/engine.js";
import { verifyProgramGuides } from "../program/guides.js";
import { readBounded } from "../agent/io.js";
import { readWaveform } from "../hdl/io.js";
import { waveformModel } from "../hdl/trace.js";
import { debugModel } from "../hdl/debug/model.js";
import {
  HDLRecording,
  debugLimits,
  validateDebugSession,
} from "../hdl/debug/recording.js";
import { initialDebugUI, followDebugEvent } from "./debug-state.js";
import { stateGraph } from "../visualization/state-graph.js";
import {
  captureExperiment,
  compareExperiments,
  recordedExperiment,
} from "../visualization/experiments.js";
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
    this.traceDetail = null;
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
    this.activity = null;
    this.work = null;
    this.activityIndex = 0;
    this.activityFollow = true;
    this.activityFilter = "";
    this.activityDetailScroll = 0;
    this.programDebugger = null;
    this.programLine = 1;
    this.graphIndex = 0;
    this.visualScroll = 0;
    this.reference = null;
    this.comparisonCache = null;
    this.debugDisplays = new Map();
  }
  get hdlDebug() {
    return this.model?.debugRecording || null;
  }
  get debugUI() {
    if (!this.hdlDebug) return null;
    if (!this.debugDisplays.has(this.modelId))
      this.debugDisplays.set(this.modelId, initialDebugUI(this.hdlDebug));
    return this.debugDisplays.get(this.modelId);
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
    return (
      this.trace[this.tick] || {
        tick: this.tick,
        state: "unavailable",
        phase: "unavailable",
        signals: {},
        registers: {},
        active: [],
        values: {},
        changes: [],
        evidence: [],
        message: "Current experiment has no snapshot at this tick.",
        detail: "",
      }
    );
  }
  get lastTick() {
    return this.view === "compare" && this.reference && !this.model.waveform
      ? Math.max(this.trace.length, this.reference.trace.length) - 1
      : Math.max(0, this.trace.length - 1);
  }
  experiment() {
    return {
      model: this.model,
      trace: this.trace,
      session: this.session(),
      label: "Current",
    };
  }
  pinExperiment() {
    this.reference = captureExperiment(
      this.model,
      this.trace,
      this.session(),
      this.model.name + " · captured reference",
    );
    this.comparisonCache = null;
    this.setMessage(
      "Reference captured · change parameters/stimulus, then D compare.",
    );
  }
  comparison() {
    if (!this.reference) return null;
    if (
      this.comparisonCache?.trace !== this.trace ||
      this.comparisonCache?.reference !== this.reference
    )
      this.comparisonCache = {
        trace: this.trace,
        reference: this.reference,
        result: compareExperiments(this.reference, this.experiment()),
      };
    return this.comparisonCache.result;
  }
  async loadComparisonFile(path) {
    const json = JSON.parse(
      (await readBounded(path, 32 * 1048576)).toString("utf8"),
    );
    let reference;
    if (json.format === "chipsim-trace")
      reference = recordedExperiment(json, path);
    else {
      if (json.format !== "chipsim-session")
        throw new Error(
          "Choose a saved ChipSim model/program session; use H for HDL comparisons.",
        );
      const temporary = new TuiState({
        workspace: this.workspace.path,
        root: this.root,
      });
      temporary.models = [...this.models];
      temporary.documents = [...this.documents];
      await temporary.loadSession(json, { persist: false });
      reference = captureExperiment(
        temporary.model,
        temporary.trace,
        temporary.session(),
        temporary.model.name + " · saved reference",
      );
      reference.origin = "replayed session";
    }
    compareExperiments(reference, this.experiment());
    this.reference = reference;
    this.comparisonCache = null;
    this.seek(this.tick);
    this.setMessage("Reference loaded · current experiment kept.");
  }
  seekDifference(direction) {
    const differences = this.comparison()?.differences || [];
    const next = (
      direction > 0 ? differences : [...differences].reverse()
    ).find((item) =>
      direction > 0 ? item.tick > this.tick : item.tick < this.tick,
    );
    if (next) this.seek(next.tick);
    else this.setMessage("No further differing tick.");
  }
  get document() {
    return this.documents.find((d) => d.id === this.documentId);
  }
  setView(view) {
    this.view = view;
    this.seek(this.tick);
    if (view === "states") {
      const graph = stateGraph(this.model, this.trace, this.tick);
      this.graphIndex = Math.max(
        0,
        graph.nodes.findIndex((node) => node.id === graph.current),
      );
    }
    if (["states", "flow", "compare"].includes(view)) this.visualScroll = 0;
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
    this.selectModelDocument();
    this.rebuild();
    if (errors.length) this.setMessage("Workspace: " + errors.join("; "), true);
  }
  rebuild() {
    this.traceDetail = null;
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
    this.programDebugger = null;
    this.modelId = id;
    this.selected = 0;
    this.logIndex = 0;
    this.blockScroll = 0;
    this.rebuild();
    this.selectModelDocument();
    this.setMessage("Loaded " + this.model.name);
  }
  selectModelDocument() {
    const source = this.model.sources.find((source) =>
      this.documents.some((document) => document.sha256 === source.sha256),
    );
    const document = source
      ? this.documents.find((document) => document.sha256 === source.sha256)
      : null;
    const documentId = document?.id || null;
    if (this.documentId !== documentId) {
      this.sourceScroll = 0;
      this.sourceQuery = "";
      this.sourceHits = [];
      this.sourceHitIndex = 0;
    }
    this.documentId = documentId;
    const page =
      this.model.evidence?.find((item) => item.sourceId === source?.id)?.page ||
      source?.pdf_start_page ||
      1;
    this.page = document?.pages.some((item) => item.number === page) ? page : 1;
  }
  async loadModelSource(onProgress = () => {}) {
    const source =
      this.model.kind === "builtin" &&
      this.model.sources.find((item) =>
        item.path?.startsWith("docs/references/"),
      );
    if (!source) throw new Error("Import a reference PDF with d first.");
    const extracted = await extractSourceFile(
      referencePath(source, { root: this.root }),
      {
        onProgress,
      },
    );
    if (extracted.sha256 !== source.sha256)
      throw new Error("Local reference fingerprint does not match the model.");
    const existing = this.documents.find(
      (document) => document.sha256 === extracted.sha256,
    );
    const document = existing
      ? replaceExtraction(existing, extracted)
      : extracted;
    const documents = existing
      ? this.documents.map((item) => (item === existing ? document : item))
      : [...this.documents, document];
    for (const model of this.models)
      if (
        model.kind === "document" &&
        model.sources.some((item) => item.sha256 === document.sha256)
      )
        registerModel(model.spec, documents);
    const saved = await this.workspace.saveDocument(document);
    if (existing) this.documents[this.documents.indexOf(existing)] = saved;
    else this.documents.push(saved);
    this.selectModelDocument();
    this.setMessage("Reference loaded for " + this.model.name);
    return saved;
  }
  setParameter(id, value) {
    this.requireManualExperiment();
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
    this.requireManualExperiment();
    this.stimulus.apply(inputs, { reset: true });
    this.setMessage(
      "Stimulus applied · " + this.config.inputs.length + " events",
    );
  }
  driveInput(signalId, value, tick = this.tick) {
    this.requireManualExperiment();
    this.stimulus.drive(signalId, value, tick);
  }
  setDuration(ticks) {
    this.requireManualExperiment();
    if (this.model.kind === "builtin")
      throw new Error("Built-in duration follows frame and ACK controls.");
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10000)
      throw new Error("Duration must be 1–10000 ticks.");
    this.config.duration = ticks;
    this.rebuild();
    this.stimulus.clearHistory(this.modelId);
  }
  accessRegister(operation, address, value = 0) {
    this.requireManualExperiment();
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
    this.tick = Math.max(0, Math.min(this.lastTick, Math.round(tick)));
    const span = Math.max(1, (this.columns - 30) / this.zoom);
    if (this.tick < this.offset) this.offset = this.tick;
    if (this.tick > this.offset + span)
      this.offset = Math.max(0, this.tick - Math.floor(span * 0.7));
    followDebugEvent(this);
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
      const level = (value) =>
        this.model.kind === "waveform" &&
        this.signal.width === 1 &&
        /^[01]$/.test(value)
          ? Number(value)
          : value;
      const before = level(this.trace[index - 1]?.signals[id]),
        after = level(this.trace[index].signals[id]);
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
    if (this.hdlDebug) {
      const data = this.hdlDebug.data;
      return data.events
        .filter(
          (e) =>
            (!this.changesOnly || e.kind !== "boundary") &&
            `${e.kind} ${e.process || ""} ${e.message || ""} ${Object.keys(e.changes || {}).join(" ")}`
              .toLowerCase()
              .includes(query),
        )
        .map((e) => ({
          tick: e.seq,
          time: e.time,
          state: e.kind,
          phase: e.phase,
          message: e.message || e.process || e.kind,
          changes: Object.entries(e.changes || {}).map(([id, after]) => ({
            id,
            after,
            kind: "signals",
          })),
        }));
    }
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
  previewRevision(spec) {
    if (this.model.kind !== "document" || spec.id !== this.modelId)
      throw new Error("A revision must keep the selected document model's ID.");
    const previous = this.model,
      model = registerModel(spec, this.documents);
    const outputs = (model) =>
      model.signals
        .filter((signal) => signal.direction === "output")
        .map((signal) => signal.id);
    if (JSON.stringify(outputs(previous)) !== JSON.stringify(outputs(model)))
      throw new Error(
        "Output names/order changed. Save as a new model to choose its initial output bits.",
      );
    let configuration, trace;
    try {
      configuration = {
        parameters: normalizeParameters(
          model.parameters,
          this.config.parameters,
        ),
        inputs: validateInputs(model.signals, this.config.inputs),
        duration: this.config.duration,
      };
      trace = model.simulate(configuration.parameters, {
        inputs: configuration.inputs,
        ticks: configuration.duration,
      });
      const fault = trace.find((snapshot) => snapshot.phase === "fault");
      if (fault)
        throw new Error(
          `Simulation fault at tick ${fault.tick}: ${fault.detail || fault.message}`,
        );
    } catch (error) {
      throw new Error(
        "Current experiment does not fit this revision: " +
          error.message +
          ". Revise the draft or save as a new model.",
      );
    }
    return { model, configuration, trace };
  }
  async reviseModel(spec) {
    const { model, configuration, trace } = this.previewRevision(spec),
      previous = this.model;
    const cursor = this.tick,
      selected = this.signal.id,
      backup = await this.workspace.backupSession(
        structuredClone(this.session()),
      );
    await this.workspace.saveModel(spec);
    this.models[this.models.indexOf(previous)] = model;
    this.configurations.set(model.id, configuration);
    this.trace = trace;
    this.stimulus.clearHistory(model.id);
    this.selected = Math.max(
      0,
      model.signals.findIndex((signal) => signal.id === selected),
    );
    this.playing = false;
    this.seek(cursor);
    this.setMessage(
      "Saved revision · experiment kept · E → Revision backups restores earlier versions",
    );
    return backup;
  }
  async refreshDocument(
    id,
    onProgress = () => {},
    { force = false, validate = () => {} } = {},
  ) {
    const existing = this.documents.find((document) => document.id === id);
    if (!existing) throw new Error("Saved reference document was not found.");
    if (!force && !needsDocumentRefresh(existing)) return existing;
    if (!existing.filePath)
      throw new Error(
        "Saved PDF is unavailable. Import the original PDF with d to refresh its source tables.",
      );
    let extracted;
    try {
      extracted = await extractSourceFile(existing.filePath, { onProgress });
    } catch (error) {
      if (error.code === "ENOENT")
        throw new Error(
          "Saved PDF is missing. Restore it or import the original PDF with d to refresh its source tables.",
        );
      throw error;
    }
    const document = replaceExtraction(existing, extracted),
      documents = this.documents.map((item) =>
        item === existing ? document : item,
      );
    // Preflight citations without reinstalling models or resetting experiments.
    for (const model of this.models)
      if (
        model.kind === "document" &&
        model.sources.some((source) => source.sha256 === document.sha256)
      )
        registerModel(model.spec, documents);
    // Source-finder compilation/checks must also pass before cache replacement.
    await validate(document);
    const saved = await this.workspace.saveDocument(document);
    this.documents[this.documents.indexOf(existing)] = saved;
    return saved;
  }
  async loadFile(path, onProgress = () => {}) {
    path = resolve(path);
    if (/\.vcd$/i.test(path)) return this.loadWaveformFile(path);
    if (/\.(pdf|csv)$/i.test(path)) {
      const extracted = await extractSourceFile(path, { onProgress });
      const existing = this.documents.find(
        (d) => d.sha256 === extracted.sha256,
      );
      const document = await this.workspace.saveDocument(
        existing ? replaceExtraction(existing, extracted) : extracted,
      );
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
      let compiled = null,
        createdCount = 0;
      if (
        document.mediaType !== "text/csv" &&
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
            registerTables: analysis.registerTables,
            diagnostics: analysis.diagnostics,
          };
          for (const result of analysis.models)
            await this.installModel(result.spec);
          compiled = analysis.models[0] || null;
          createdCount = analysis.models.length;
          await this.workspace.saveDocument(document);
        } catch (error) {
          errors.push(error.message);
        }
      }
      const matches = modelsForDocument(document, this.models);
      const selected =
        matches.find((m) => m.id === compiled?.spec.id) ||
        matches.find((m) => m.kind === "document" && m.id === this.modelId) ||
        matches.find((m) => m.kind === "document") ||
        matches[0];
      if (selected) {
        this.selectModel(selected.id);
        if (compiled)
          this.setMessage(
            (createdCount > 1
              ? "Created " + createdCount + " simulations · o choose · "
              : "Created ") +
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
            : document.mediaType === "text/csv"
              ? "CSV source imported · load its generated model/session · / searches the table"
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
    const text = (await readBounded(path, debugLimits.fileBytes)).toString(
      "utf8",
    );
    const json = JSON.parse(text);
    if (json.format === "chipsim-hdl-debug")
      return this.installDebugRecording(json);
    if (json.format === "chipsim-hdl-debug-session") {
      const { recording, ui } = validateDebugSession(json);
      this.installDebugRecording(recording);
      this.debugDisplays.set(this.modelId, {
        ...initialDebugUI(recording),
        ...ui,
      });
      this.format = ui.format;
      this.zoom = ui.zoom ?? 1;
      this.seek(ui.eventIndex);
      if (ui.selectedSignal)
        this.selected = recording.signals.findIndex(
          (s) => s.id === ui.selectedSignal,
        );
      this.offset = ui.offset ?? this.offset;
      return;
    }
    if (json.format === "chipsim-waveform") return this.installWaveform(json);
    if (json.format === "chipsim-waveform-session") {
      if (
        json.version !== 1 ||
        !Number.isInteger(json.tick) ||
        json.tick < 0 ||
        !["hex", "decimal", "binary", "octal"].includes(json.display)
      )
        throw new Error("Invalid waveform session.");
      const model = waveformModel(json.waveform);
      if (json.tick >= model.waveform.events.length)
        throw new Error("Waveform session cursor is outside the trace.");
      this.installWaveform(json.waveform);
      this.format = json.display;
      this.seek(json.tick);
      return;
    }
    if (text.length > 3 * 1048576)
      throw new Error("Model/session JSON file exceeds 3 MiB.");
    if (json.format === "chipsim-session") {
      await this.loadSession(json);
      return;
    }
    await this.installModel(json);
  }
  session() {
    if (this.hdlDebug)
      return {
        format: "chipsim-hdl-debug-session",
        version: 1,
        recording: this.hdlDebug.data,
        ui: {
          ...structuredClone(this.debugUI),
          eventIndex: this.tick,
          format: this.format,
          selectedSignal: this.signal?.id || null,
          zoom: this.zoom,
          offset: this.offset,
        },
      };
    if (this.model.waveform)
      return {
        format: "chipsim-waveform-session",
        version: 1,
        waveform: this.model.waveform,
        tick: this.tick,
        display: this.format,
      };
    return {
      format: "chipsim-session",
      version: 1,
      modelId: this.modelId,
      model: this.model.spec || null,
      parameters: this.config.parameters,
      inputs: this.config.inputs,
      duration: this.config.duration,
      tick: Math.min(this.tick, this.trace.length - 1),
      display: this.format,
      ...(this.programDebugger
        ? {
            program: {
              text: this.programDebugger.program.text,
              steps: this.programDebugger.steps.length,
              status: this.programDebugger.status,
              maxTicks: this.programDebugger.maxTicks,
              maxSteps: this.programDebugger.maxSteps,
            },
          }
        : {}),
    };
  }
  requireManualExperiment() {
    if (this.model.kind === "waveform")
      throw new Error(
        "Recorded HDL waveform is read-only. Change its testbench and use H → Run HDL project.",
      );
    if (this.programDebugger)
      throw new Error(
        "The source program controls this experiment. Edit/reload it with P, or detach it with Q in Program view.",
      );
  }
  async loadProgramFile(path) {
    if (this.model.waveform) this.requireManualExperiment();
    const text = (await readBounded(path, 65536)).toString("utf8");
    const debug = await this.prepareProgram(text, this.model);
    this.programDebugger = debug;
    this.programPath = resolve(path);
    this.programLine = debug.next.line;
    this.view = "program";
    this.syncProgram();
    this.selectModelDocument();
    this.setMessage(
      "Program ready · N step · C continue · K breakpoint · J back",
    );
  }
  async loadWaveformFile(path) {
    const wave = await readWaveform(path);
    this.installWaveform(wave);
  }
  async loadDebugFile(path) {
    const json = JSON.parse(
      (await readBounded(path, debugLimits.fileBytes)).toString("utf8"),
    );
    if (json.format === "chipsim-hdl-debug-session") {
      const { recording, ui } = validateDebugSession(json);
      this.installDebugRecording(recording);
      this.debugDisplays.set(this.modelId, {
        ...initialDebugUI(recording),
        ...ui,
      });
      this.format = ui.format;
      this.zoom = ui.zoom ?? 1;
      this.seek(ui.eventIndex);
      if (ui.selectedSignal)
        this.selected = recording.signals.findIndex(
          (s) => s.id === ui.selectedSignal,
        );
      this.offset = ui.offset ?? this.offset;
      return;
    }
    this.installDebugRecording(json);
  }
  installDebugRecording(data) {
    // Construct and validate completely before touching the active experiment.
    const recording =
      data instanceof HDLRecording ? data : new HDLRecording(data);
    let index = this.models.length;
    while (this.models.some((model) => model.id === "hdl-debug-" + index))
      index++;
    const model = debugModel(recording, "hdl-debug-" + index);
    this.models.push(model);
    this.selectModel(model.id);
    this.documentId = null;
    this.view = "debug";
    this.seek(0);
    this.setMessage(
      "HDL debug · I combined · h/l event · F2 pane · F3 expand · K stops · G follow event",
    );
  }
  installWaveform(wave) {
    let index = this.models.length;
    while (this.models.some((model) => model.id === "hdl-waveform-" + index))
      index++;
    const model = waveformModel(wave, "hdl-waveform-" + index);
    this.models.push(model);
    this.selectModel(model.id);
    this.documentId = null;
    this.view = "wave";
    this.setMessage(
      "HDL waveform loaded · H run/compare · timestamp sample indices; exact time at cursor",
    );
  }
  async prepareProgram(text, model, documents = this.documents, limits = {}) {
    const program = parseProgram(text);
    const manual = documents.find((doc) =>
      model.sources.some((s) => s.sha256 === doc.sha256),
    );
    const guides = await verifyProgramGuides(program, model, {
      root: this.root,
      manual,
    });
    return new ProgramDebugger(model, program, { ...limits, guides });
  }
  syncProgram() {
    const debug = this.programDebugger;
    this.playing = false;
    this.traceDetail = null;
    this.configurations.set(this.modelId, {
      parameters: debug.parameters,
      inputs: debug.inputs,
      duration: Math.max(1, debug.tick),
    });
    this.trace = debug.trace;
    this.seek(debug.tick);
    this.programLine = debug.next?.line || debug.steps.at(-1)?.line || 1;
  }
  async loadSession(
    session,
    {
      backupCurrent = false,
      persist = true,
      preserveInspection = false,
      rejectFault = false,
      documents = this.documents,
    } = {},
  ) {
    const inspection = preserveInspection
      ? {
          tick: this.tick,
          signalId: this.signal?.id,
          format: this.format,
          zoom: this.zoom,
          offset: this.offset,
          logIndex: this.logIndex,
          blockScroll: this.blockScroll,
          page: this.page,
          documentId: this.documentId,
        }
      : null;
    if (session.version !== 1) throw new Error("Unsupported session version");
    if (session.model && session.model.id !== session.modelId)
      throw new Error("Session model ID does not match its definition.");
    const model = session.model
      ? registerModel(session.model, documents)
      : this.models.find((m) => m.id === session.modelId);
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
    let trace = model.simulate(parameters, {
      inputs,
      ticks: session.duration,
    });
    let debug = null;
    if (session.program) {
      const saved = session.program;
      if (
        !Number.isInteger(saved.steps) ||
        saved.steps < 0 ||
        saved.steps > 10000
      )
        throw new Error("Invalid saved program step count.");
      debug = await this.prepareProgram(saved.text, model, documents, {
        maxTicks: saved.maxTicks,
        maxSteps: saved.maxSteps,
      });
      for (let i = 0; i < saved.steps; i++) {
        if (!debug.step())
          throw new Error("Saved program step count exceeds its execution.");
      }
      // A step-budget fault occurs before recording another statement.
      if (
        saved.status === "fault" &&
        debug.status !== "fault" &&
        debug.steps.length === debug.maxSteps
      )
        debug.step();
      if (
        saved.status !== undefined &&
        !["paused", "breakpoint", "halted", "fault"].includes(saved.status)
      )
        throw new Error("Invalid saved program status.");
      if (
        ["halted", "fault"].includes(saved.status) &&
        debug.status !== saved.status
      )
        throw new Error(
          "Saved program status does not match source-program replay.",
        );
      const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      if (
        !equal(debug.parameters, parameters) ||
        !equal(debug.inputs, inputs) ||
        Math.max(1, debug.tick) !== session.duration
      )
        throw new Error(
          "Saved experiment does not match source-program replay.",
        );
      trace = debug.trace;
    }
    if (
      rejectFault &&
      (debug?.status === "fault" ||
        trace.some((snapshot) => snapshot.phase === "fault"))
    )
      throw new Error("New run contains a simulation fault");
    if (backupCurrent) {
      if (model.id !== this.modelId || this.model.kind !== "document")
        throw new Error(
          "Revision backup must belong to the selected document model.",
        );
      await this.workspace.backupSession(structuredClone(this.session()));
    }
    if (session.model) {
      if (persist) await this.workspace.saveModel(session.model);
      const index = this.models.findIndex((item) => item.id === model.id);
      if (index < 0) this.models.push(model);
      else this.models[index] = model;
    }
    this.configurations.set(model.id, {
      parameters,
      inputs,
      duration: session.duration,
    });
    this.documents = documents;
    this.stimulus.clearHistory(model.id);
    this.modelId = model.id;
    this.trace = trace;
    this.programDebugger = debug;
    if (debug)
      this.programLine = debug.next?.line || debug.steps.at(-1)?.line || 1;
    this.selected = 0;
    this.logIndex = 0;
    this.blockScroll = 0;
    this.offset = 0;
    this.playing = false;
    this.selectModelDocument();
    this.format = ["hex", "decimal", "binary", "octal"].includes(
      session.display,
    )
      ? session.display
      : "hex";
    this.seek(Number.isInteger(session.tick) ? session.tick : 0);
    if (inspection) {
      this.selected = Math.max(
        0,
        model.signals.findIndex((signal) => signal.id === inspection.signalId),
      );
      this.format = inspection.format;
      this.zoom = inspection.zoom;
      this.offset = Math.min(inspection.offset, trace.length - 1);
      this.logIndex = inspection.logIndex;
      this.blockScroll = inspection.blockScroll;
      if (inspection.documentId === this.documentId)
        this.page = inspection.page;
      this.traceDetail = null;
      this.seek(inspection.tick);
    }
    this.setMessage("Session restored.");
  }
}
