import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { startWork, appendWorkEvent } from "../src/agent/work.js";
import { Store, atomic, json } from "../src/design/store.js";
import { WorkPanel, workRows } from "../src/tui/work-panel.js";
import { DesignPanel } from "../src/tui/design-panel.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { screenText, displayWidth } from "../src/tui/render.js";
import { debugFixture } from "./fixtures/hdl-debug.mjs";

async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), "chipsim-work-ui-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const state = new TuiState({ workspace: join(project, "ui") });
  await state.initialize();
  const panel = await new WorkPanel(state, project).initialize();
  t.after(() => panel.close());
  state.view = "activity";
  const app = {
    task: (fn) => fn(),
    menu: (title, items, callback) => {
      app.menuState = { title, items, callback };
    },
    prompt: (_title, _value, callback) => {
      app.promptCallback = callback;
    },
  };
  return { project, state, panel, app };
}
async function artifact(project, path, kind, data) {
  const store = new Store(project),
    file = join(project, path);
  await writeFile(file, typeof data === "string" ? data : JSON.stringify(data));
  const record = await store.put("artifact", {
    path,
    kind,
    payload: await store.putFile(file),
    producer: null,
    snapshot: null,
    inputs: [],
    completeness: "complete",
    provenance: "captured",
  });
  return { store, record };
}

test("plain-project dashboard renders at both sizes, sanitizes text, and never changes debug inspection", async (t) => {
  const { project, state, panel, app } = await fixture(t);
  assert.match(screenText(state), /No agent-work sessions yet/);
  const session = await startWork(project, {
    goal: "Review a long goal " + "across modules ".repeat(80),
    mode: "evolution",
  });
  const first = await appendWorkEvent(project, session.id, {
    kind: "candidate",
    candidate: "first",
    generation: 0,
    message: "Created baseline",
    status: "running",
  });
  state.installDebugRecording(debugFixture(20));
  state.seek(7);
  state.zoom = 2;
  state.format = "binary";
  const trace = state.trace,
    model = state.model;
  const debugUI = structuredClone(state.debugUI);
  state.view = "activity";
  await panel.refresh();
  panel.handle("k", {}, app);
  const selected = state.work.selection.events;
  await appendWorkEvent(project, session.id, {
    kind: "evaluation",
    candidate: "second",
    parent: "first",
    generation: 1,
    message: "New candidate",
    status: "passed",
    metrics: { score: { value: 0.75, unit: "fraction" } },
  });
  await panel.refresh();
  assert.equal(state.work.selection.events, selected);
  assert.equal(selected, first.id);
  state.work.events[0].message += "\u001b[2J";
  assert.equal(state.trace, trace);
  assert.equal(state.model, model);
  assert.equal(state.tick, 7);
  assert.equal(state.zoom, 2);
  assert.equal(state.format, "binary");
  assert.deepEqual(state.debugUI, debugUI);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    Object.assign(state, { columns, rows });
    for (const tab of ["events", "candidates"]) {
      state.work.tab = tab;
      const text = screenText(state);
      assert.equal(text.split("\n").length, rows);
      assert.ok(
        text.split("\n").every((line) => displayWidth(line) === columns),
      );
      assert.match(text, /Agent work/);
      assert.match(text, /agent-reported/);
      assert.doesNotMatch(text, /tick 7|\u001b/);
    }
  }
  panel.handle("g", {}, app);
  for (let i = 0; i < 8; i++) panel.handle("j", {}, app);
  workRows(state, 17);
  assert.ok(state.work.detail.scroll > 0);
  panel.handle("", { name: "escape" }, app);
  panel.handle("e", {}, app);
  panel.handle("/", {}, app);
  app.promptCallback("second");
  panel.handle("G", {}, app);
  assert.equal(state.work.selection.events, state.work.events.at(-1).id);
  const another = await startWork(project, { goal: "Separate task" });
  await panel.refresh();
  assert.equal(
    state.work.session.id,
    session.id,
    "new sessions do not steal current selection",
  );
  panel.handle("s", {}, app);
  await app.menuState.callback(another.id);
  if (panel.pending) await panel.pending;
  assert.equal(state.work.session.id, another.id);
});

test("SHA candidate labels keep scores and event messages visible at 80 columns while detail retains lineage", async (t) => {
  const { project, state, panel, app } = await fixture(t);
  const sourceId = (source) =>
    "rtl-" + createHash("sha256").update(source).digest("hex");
  const candidate = sourceId("module candidate; endmodule"),
    parent = sourceId("module baseline; endmodule");
  const session = await startWork(project, {
    goal: "Compare full SHA candidate identifiers",
    mode: "evolution",
  });
  await appendWorkEvent(project, session.id, {
    kind: "evaluation",
    candidate,
    parent,
    generation: 1,
    status: "passed",
    message: "Waveform checks completed",
    metrics: {
      combined_score: { value: 1, unit: "fraction" },
      checks_passed: { value: 80, unit: "count" },
      checks_total: { value: 80, unit: "count" },
    },
  });
  await panel.refresh();
  Object.assign(state, { columns: 80, rows: 24 });
  panel.handle("c", {}, app);
  assert.match(screenText(state), /combined_score=1 fraction/);
  assert.equal(state.work.selection.candidates, candidate);
  assert.doesNotMatch(screenText(state), new RegExp(candidate));
  panel.handle("", { name: "return" }, app);
  const detail = JSON.parse(state.work.detail.text);
  assert.equal(detail.id, candidate);
  assert.equal(detail.parent, parent);
  assert.equal(detail.generation, 1);
  panel.handle("", { name: "escape" }, app);
  panel.handle("/", {}, app);
  app.promptCallback(parent);
  assert.match(screenText(state), /combined_score=1 fraction/);
  panel.handle("e", {}, app);
  assert.match(screenText(state), /Waveform checks completed/);
});

test("verified external-project recordings open in combined debug without replacing active design", async (t) => {
  const { project, state, panel, app } = await fixture(t);
  const external = join(project, "candidate-project");
  await mkdir(external);
  const { store, record } = await artifact(
    external,
    "debug.json",
    "hdl-debug",
    debugFixture(20),
  );
  const check = await store.put("check", {
    name: "independent assertion",
    verdict: "fail",
    evidence: [record.id],
    subject: {},
  });
  const run = await store.put("run", {
    artifacts: [record.id],
    checks: [check.id],
    attempts: [],
  });
  const session = await startWork(project, {
    goal: "Compare reported and actual results",
  });
  await appendWorkEvent(project, session.id, {
    kind: "evaluation",
    candidate: "agent-claim",
    status: "passed",
    message: "Agent claims pass",
    evidence: { project: external, run: run.id, artifact: record.id },
  });
  await panel.refresh();
  assert.equal(state.work.candidates[0].status, "passed");
  await panel.evidenceMenu(state.work.events[0].evidence, app);
  assert.ok(
    app.menuState.items.some((item) =>
      item.label.includes("independent assertion · fail"),
    ),
  );
  assert.ok(app.menuState.items.some((item) => item.detail.includes(external)));
  const design = { root: project, selection: { artifacts: "kept" } };
  state.design = design;
  await panel.openRecord(external, record.id);
  assert.equal(state.view, "debug");
  assert.ok(state.hdlDebug);
  assert.equal(state.design, design);
  assert.equal(state.design.selection.artifacts, "kept");
  const trace = state.trace;
  await chmod(store.blobPath(record.payload.sha256), 0o644);
  await writeFile(store.blobPath(record.payload.sha256), "tampered");
  await assert.rejects(panel.openRecord(external, record.id), /integrity/);
  assert.equal(state.trace, trace);
});

test("design cursor remains tied to its recorded artifact across external evidence and ordinary imports", async (t) => {
  const { project, state, panel, app } = await fixture(t);
  const own = await artifact(
    project,
    "design-debug.json",
    "hdl-debug",
    debugFixture(20),
  );
  const external = join(project, "candidate-project");
  await mkdir(external);
  const other = await artifact(
    external,
    "candidate-debug.json",
    "hdl-debug",
    debugFixture(20),
  );
  const design = new DesignPanel(state, project);
  design.store = own.store;
  state.design = {
    root: project,
    target: "simulation",
    selection: {},
    selectedArtifact: own.record.id,
    cursor: { kind: "hdl-event", index: 4, object: "s:count" },
  };
  const sessionFile = join(own.store.root, "sessions", "tui.json");
  await design.save();
  assert.equal(
    (await json(sessionFile)).cursor.index,
    4,
    "unopened saved selection is not tied to the default model",
  );
  await design.inspect(own.record.id, app);
  assert.equal(state.tick, 4);
  state.seek(7);
  state.selected = 1;
  const selectedSignal = state.signal.id;
  await panel.openRecord(external, other.record.id);
  state.seek(2);
  state.selected = 0;
  await design.save();
  const saved = await json(sessionFile);
  assert.equal(saved.selectedArtifact, own.record.id);
  assert.deepEqual(saved.cursor, {
    kind: "hdl-event",
    index: 7,
    object: selectedSignal,
  });
  assert.equal(
    saved.inspectedRecording,
    undefined,
    "in-memory model identity is not persisted",
  );
  await design.inspect(own.record.id, app);
  assert.equal(state.tick, 7);
  assert.equal(state.signal.id, selectedSignal);
  state.seek(10);
  await design.save();
  state.installDebugRecording(debugFixture(20));
  state.seek(3);
  await design.save();
  assert.equal(
    (await json(sessionFile)).cursor.index,
    10,
    "ordinary imports cannot overwrite the selected artifact cursor",
  );
});

test("live job log refresh appends actual output at EOF, preserves browsing and shows actual task state", async (t) => {
  const { project, state, panel, app } = await fixture(t);
  const external = join(project, "managed");
  await mkdir(external);
  const store = new Store(external),
    id = randomUUID(),
    path = join(store.root, "jobs", id);
  const job = {
    id,
    state: "running",
    target: "test",
    updated: new Date().toISOString(),
    tasks: { sim: { state: "running" } },
  };
  await atomic(join(path, "state.json"), job);
  await writeFile(join(path, "log.txt"), "real compiler output\n");
  const session = await startWork(project, {
    goal: "Observe an external tool job",
  });
  await appendWorkEvent(project, session.id, {
    kind: "tool",
    message: "Managed simulation",
    evidence: { project: external, job: id },
  });
  await panel.refresh();
  await panel.openLog(external, id);
  assert.match(state.work.detail.text, /real compiler output/);
  assert.match(state.work.detail.text, /sim:running/);
  const cursor = state.work.detail.cursor;
  panel.handle("k", {}, app);
  assert.equal(state.work.detail.follow, false);
  await appendFile(join(path, "log.txt"), "new assertion failure\n");
  await atomic(join(path, "state.json"), {
    ...job,
    state: "failed",
    tasks: { sim: { state: "failed" } },
  });
  await panel.refresh();
  assert.ok(state.work.detail.cursor > cursor);
  assert.match(state.work.detail.text, /new assertion failure/);
  assert.match(state.work.detail.text, /sim:failed/);
  assert.equal(state.work.detail.follow, false);
  assert.equal(
    (state.work.detail.text.match(/real compiler output/g) || []).length,
    1,
  );
  panel.handle("G", {}, app);
  assert.equal(state.work.detail.follow, true);
  assert.equal(state.modelId, "pio");
});

test("work controls take precedence over design Activity and app exit stops polling", async (t) => {
  const { project, state, panel } = await fixture(t);
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = () => {};
  input.pause = input.resume = () => {};
  output.write = () => {};
  output.columns = 80;
  output.rows = 24;
  const app = new TerminalApp(state, { input, output });
  app.workPanel = panel;
  state.design = {
    summary: { jobs: [] },
    selection: {},
    artifacts: [],
    checks: [],
  };
  const design = new DesignPanel(state, project);
  app.designPanel = design;
  design.close = () => Promise.resolve();
  assert.equal(design.handle("j", {}, app), false);
  app.key("c", { name: "c" });
  assert.equal(state.work.tab, "candidates");
  app.key("g", { name: "g" });
  assert.equal(state.view, "activity");
  assert.ok(state.work.detail);
  panel.start();
  app.close();
  assert.equal(panel.closed, true);
  assert.equal(panel.timer._destroyed, true);
});
