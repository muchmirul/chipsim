import { join } from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { loadDesign } from "../design/project.js";
import {
  projectSummary,
  checksForTarget,
  compareRuns,
} from "../design/service.js";
import { startJob, cancelJob, retryJob } from "../design/jobs.js";
import {
  inspectArtifact,
  verifyEvidence,
  exportEvidence,
} from "../design/evidence.js";
import { atomic, json } from "../design/store.js";
import { parseVCD } from "../hdl/vcd.js";
import { clean, wrapText } from "./text.js";

function captureDesignCursor(state) {
  const d = state.design,
    inspected = d?.inspectedRecording;
  if (
    !inspected ||
    d.selectedArtifact !== inspected.artifact ||
    state.model !== inspected.model ||
    state.trace !== inspected.trace
  )
    return;
  d.cursor = {
    kind: state.hdlDebug
      ? "hdl-event"
      : state.model.waveform
        ? "waveform-sample"
        : "model-tick",
    index: state.tick,
    object: state.signal?.id,
  };
}

// Open only verified recorded data. The evidence store may belong to another
// project, so this does not change the active design panel or its selections.
export async function openRecordedArtifact(state, store, id) {
  const data = await inspectArtifact(store, id),
    a = data.artifact;
  if (!a) return { data, opened: false };
  const payload = store.blobPath(a.payload.sha256);
  captureDesignCursor(state);
  if (a.kind === "hdl-debug") await state.loadDebugFile(payload);
  else if (a.kind === "waveform") await state.loadWaveformFile(payload);
  else if (a.kind === "waveform-vcd")
    state.installWaveform(
      parseVCD(await readFile(payload, "utf8"), {
        name: a.path,
        sha256: a.payload.sha256,
      }),
    );
  else if (a.kind === "model-session") {
    await state.loadSession(await json(payload), { persist: false });
    state.view = "wave";
  } else return { data, opened: false };
  return { data, opened: true };
}

export const designViews = ["project", "pipeline", "artifacts", "checks"];
const row = (text, style = "") => ({ text: clean(text), style });
export function designItems(state) {
  const d = state.design;
  if (!d) return [];
  if (state.view === "project")
    return d.summary.targets.map((id) => ({
      id,
      label: "Target " + id,
      kind: "target",
    }));
  if (["pipeline", "activity"].includes(state.view))
    return d.summary.jobs.map((job) => ({
      id: job.id,
      label: `${job.state.toUpperCase()} ${job.target} · ${job.id.slice(0, 8)} · ${Object.entries(
        job.tasks,
      )
        .map(([k, v]) => k + ":" + v.state)
        .join(" ")}`,
      value: job,
      kind: "job",
    }));
  if (state.view === "artifacts")
    return d.artifacts.map((a) => ({
      id: a.id,
      label: `${a.kind} · ${a.path} · ${a.completeness} · ${a.id.slice(0, 8)}`,
      value: a,
      kind: "artifact",
    }));
  return d.checks.map((c) => ({
    id: c.name,
    label: c.verdict.toUpperCase() + " · " + c.name,
    value: c,
    kind: "check",
  }));
}
export function designRows(state, height) {
  const d = state.design;
  if (!d) return [row("Open a design with chipsim --design PROJECT")];
  if (d.detail)
    return [
      row(d.detail.title, "selected"),
      ...wrapText(d.detail.text, state.columns)
        .slice(d.scroll, d.scroll + height - 2)
        .map((t) => row(t)),
      row("Esc back · j/k scroll · Enter related evidence", "dim"),
    ].slice(0, height);
  const items = designItems(state),
    selected = Math.max(
      0,
      items.findIndex((i) => i.id === d.selection[state.view]),
    );
  const first = Math.max(0, selected - Math.floor((height - 5) / 2));
  return [
    row(d.root, "dim"),
    row(
      state.view === "checks"
        ? `${d.ready ? "READY" : "BLOCKED"} · ${d.target} · current policy and inputs`
        : `${d.summary.runs.length} runs · ${d.artifacts.length} artifacts · target ${d.target}`,
      "selected",
    ),
    ...items
      .slice(first, first + height - 5)
      .map((i, n) =>
        row(
          (first + n === selected ? "› " : "  ") + i.label,
          first + n === selected ? "selected" : "",
        ),
      ),
    ...(!items.length
      ? [row("No published results yet. Enter a target in Project to run it.")]
      : []),
    row(
      d.summary.errors[0] ||
        (d.summary.runs.find((r) => r.stale)?.target &&
          "Inputs changed · affected evidence is stale") ||
        "Historical artifacts remain unchanged",
      "dim",
    ),
    row(
      "j/k select · Enter actions · o inspect · r run · X cancel · R retry",
      "dim",
    ),
  ].slice(0, height);
}

export class DesignPanel {
  constructor(state, root) {
    this.state = state;
    this.root = root;
    this.loading = false;
    this.closed = false;
  }
  async initialize() {
    const design = await loadDesign(this.root);
    this.store = design.store;
    let saved = {};
    try {
      saved = await json(join(this.store.root, "sessions", "tui.json"), 65536);
    } catch {}
    this.state.design = {
      root: design.root,
      summary: { targets: [], runs: [], jobs: [], errors: [] },
      artifacts: [],
      checks: [],
      target: design.config.targets[saved.target]
        ? saved.target
        : Object.keys(design.config.targets)[0],
      selection: saved.selection || {},
      cursor: saved.cursor || null,
      selectedArtifact: saved.selectedArtifact || null,
      scroll: 0,
      ready: false,
    };
    await this.refresh();
    this.state.view = "project";
    return this;
  }
  async refresh() {
    if (this.loading || this.closed) return;
    this.loading = true;
    try {
      const d = this.state.design;
      const summary = await projectSummary(this.root);
      const artifacts = await this.store.list("artifact");
      const checks = await checksForTarget(
        this.root,
        d.target,
        undefined,
        summary,
      );
      if (!this.closed)
        Object.assign(d, {
          summary,
          artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
          checks: checks.required,
          ready: checks.ready,
        });
      this.onChange?.();
    } catch (error) {
      this.state.setMessage("Design: " + error.message, true);
      this.onChange?.();
    } finally {
      this.loading = false;
    }
  }
  start() {
    this.timer = setInterval(() => {
      if (
        !this.state.busy &&
        !this.state.prompt &&
        !this.state.menu &&
        !this.external?.()
      )
        this.refresh();
    }, 2000);
  }
  async save() {
    const d = this.state.design;
    captureDesignCursor(this.state);
    await atomic(join(this.store.root, "sessions", "tui.json"), {
      format: "chipsim-inspection-session",
      version: 1,
      target: d.target,
      selection: d.selection,
      selectedArtifact: d.selectedArtifact,
      cursor: d.cursor,
    });
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    return this.save();
  }
  detail(title, data, id) {
    this.state.design.detail = {
      title,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      id,
    };
    this.state.design.scroll = 0;
  }
  async inspect(id, app) {
    const { data, opened } = await openRecordedArtifact(
        this.state,
        this.store,
        id,
      ),
      a = data.artifact;
    if (!a) {
      this.detail(data.record.format, data.record, id);
      return;
    }
    const state = this.state;
    if (!opened && a.kind === "layout") {
      app.external = true;
      app.input.setRawMode(false);
      app.input.pause();
      app.output.write("\x1b[?25h\x1b[?1049l");
      try {
        // Materialize a verified copy with its native extension for KLayout.
        const directory = join(this.store.root, "inspection", a.id);
        await this.store.materialize(
          [{ ...a.payload, path: a.path }],
          directory,
        );
        await new Promise((done, reject) => {
          const child = spawn("klayout", [join(directory, a.path)], {
            stdio: "inherit",
            shell: false,
          });
          child.once("error", reject);
          child.once("close", done);
        });
      } finally {
        app.external = false;
        app.input.setRawMode(true);
        app.input.resume();
        app.output.write("\x1b[?1049h\x1b[?25l");
        app.draw();
      }
    } else if (!opened) {
      this.detail(a.path, data, id);
      return;
    }
    const saved = state.design.cursor;
    if (state.design.selectedArtifact === id && saved) {
      state.seek(Math.min(saved.index, state.lastTick));
      const selected = state.model.signals.findIndex(
        (s) => s.id === saved.object,
      );
      if (selected >= 0) state.selected = selected;
    }
    state.design.selectedArtifact = id;
    state.design.inspectedRecording = opened
      ? { artifact: id, model: state.model, trace: state.trace }
      : null;
    state.design.cursor = null;
    captureDesignCursor(state);
    state.design.detail = null;
  }
  async related(id, app) {
    const r = await verifyEvidence(this.store, id),
      references = [];
    if (r.snapshot)
      references.push({ label: "Input snapshot", value: r.snapshot });
    if (r.plan) references.push({ label: "Execution plan", value: r.plan });
    for (const input of r.inputs || [])
      if (input.artifact)
        references.push({
          label: "Input " + input.path,
          value: input.artifact,
        });
    for (const ref of [
      ...(r.artifacts || []),
      ...(r.attempts || []),
      ...(r.checks || []),
      ...(r.evidence || []),
    ])
      references.push({ label: "Evidence " + ref.slice(0, 12), value: ref });
    if (r.format === "chipsim-artifact") {
      const producer =
        r.producer &&
        (await this.store.list("attempt")).find(
          (a) => a.job === r.producer.job && a.attempt === r.producer.attempt,
        );
      if (producer)
        references.push({ label: "Producer task attempt", value: producer.id });
      const info = await inspectArtifact(this.store, id);
      references.push(
        ...info.consumers.map((value) => ({
          label: "Consumer " + value.slice(0, 12),
          value,
        })),
        ...info.checks.map((c) => ({ label: "Check " + c.name, value: c.id })),
      );
    }
    app.menu(
      "RELATED EVIDENCE",
      references.length
        ? references
        : [{ label: "No recorded links", value: null }],
      (value) =>
        value &&
        app.task(async () =>
          this.detail(
            "Evidence " + value.slice(0, 12),
            await inspectArtifact(this.store, value),
            value,
          ),
        ),
    );
  }
  handle(k, key, app) {
    const s = this.state,
      d = s.design;
    if (k === "0") {
      s.view = "project";
      return true;
    }
    if (
      !d ||
      (s.work && s.view === "activity") ||
      ![...designViews, "activity"].includes(s.view)
    )
      return false;
    if (d.detail) {
      if (key.name === "escape") d.detail = null;
      else if (["j", "down"].includes(k)) d.scroll++;
      else if (["k", "up"].includes(k)) d.scroll = Math.max(0, d.scroll - 1);
      else if (key.name === "return" && d.detail.id)
        app.task(() => this.related(d.detail.id, app));
      else return false;
      return true;
    }
    const items = designItems(s),
      index = Math.max(
        0,
        items.findIndex((i) => i.id === d.selection[s.view]),
      ),
      item = items[index];
    if (["j", "down", "k", "up"].includes(k)) {
      d.selection[s.view] =
        items[
          Math.min(
            items.length - 1,
            Math.max(0, index + (["j", "down"].includes(k) ? 1 : -1)),
          )
        ]?.id;
      return true;
    }
    if (k === "r") {
      app.task(async () => {
        if (item?.kind === "target") d.target = item.id;
        const job = await startJob(this.root, d.target);
        s.setMessage("Accepted " + job.id + " · continues after quit");
        await this.refresh();
      });
      return true;
    }
    if (k === "X" && item?.kind === "job") {
      app.task(async () => {
        await cancelJob(this.store, item.id);
        await this.refresh();
      });
      return true;
    }
    if (k === "R" && item?.kind === "job") {
      app.task(async () => {
        await retryJob(this.store, item.id);
        await this.refresh();
      });
      return true;
    }
    if (k === "o" && item?.kind === "artifact") {
      app.task(() => this.inspect(item.id, app));
      return true;
    }
    if (key.name === "return" && item) {
      if (item.kind === "target") {
        d.target = item.id;
        app.menu(
          "TARGET " + item.id,
          [
            { label: "Run target", value: "run" },
            ...designViews.slice(1).map((value) => ({ label: value, value })),
            { label: "Compare latest runs", value: "compare" },
          ],
          (value) =>
            app.task(async () => {
              if (value === "run") {
                const job = await startJob(this.root, d.target);
                s.setMessage("Accepted " + job.id);
                s.view = "pipeline";
              } else if (value === "compare") {
                const [right, left] = d.summary.runs.filter(
                  (r) => r.target === d.target,
                );
                if (!left) throw new Error("Two runs are required");
                this.detail(
                  "Run comparison",
                  await compareRuns(this.store, left.id, right.id),
                );
              } else s.view = value;
              await this.refresh();
            }),
        );
      } else if (item.kind === "artifact")
        app.menu(
          item.value.path,
          [
            { label: "Inspect payload", value: "open" },
            { label: "Inputs, producer, checks and consumers", value: "links" },
            { label: "Artifact metadata", value: "record" },
            { label: "Export evidence bundle", value: "export" },
          ],
          (value) => {
            if (value === "export")
              app.prompt("New evidence bundle directory", "", (out) =>
                app.task(async () => {
                  await exportEvidence(this.store, item.id, out);
                  s.setMessage("Evidence exported to " + out);
                }),
              );
            else
              app.task(async () => {
                if (value === "open") await this.inspect(item.id, app);
                else if (value === "links") await this.related(item.id, app);
                else
                  this.detail(
                    item.value.path,
                    await inspectArtifact(this.store, item.id),
                    item.id,
                  );
              });
          },
        );
      else
        this.detail(item.label, item.value, item.value.run || item.value.check);
      return true;
    }
    return false;
  }
}
