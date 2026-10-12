import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { compileDocument } from "../src/model/profiles/index.js";
import { ProgramDebugger } from "../src/program/engine.js";
import { parseProgram } from "../src/program/parse.js";

const root = new URL("../", import.meta.url).pathname;
const pioProgram = join(root, "examples/programs/pio-transfer.chip");
let esp32Document;

async function setup(t, withESP32 = false) {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-program-workspace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  if (withESP32) {
    esp32Document ??= extractPDFFile(
      join(root, "docs/references/esp32-c6/espressif-esp32-c6-trm.pdf"),
    );
    const saved = await state.workspace.saveDocument(
      structuredClone(await esp32Document),
    );
    state.documents.push(saved);
    state.documentId = saved.id;
  }
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = input.resume = input.pause = () => {};
  output.columns = 120;
  output.rows = 40;
  output.write = () => {};
  return { state, app: new TerminalApp(state, { input, output }) };
}

async function idle(state) {
  const deadline = Date.now() + 15000;
  while (state.busy && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.busy, false, state.message);
  assert.equal(state.error, false, state.message);
}

test("model startup, selection, program loading and session replay clear unrelated references", async (t) => {
  const { state } = await setup(t, true);
  const esp32 = state.document;
  const gpio = compileDocument(esp32, { profileId: "esp32c6-gpio" }).spec;
  await state.installModel(gpio);
  const gpioSession = structuredClone(state.session());
  assert.equal(state.documentId, esp32.id);
  state.sourceQuery = "GPIO";
  state.sourceHits = [{ page: 251 }];
  state.sourceScroll = 5;
  state.selectModel("pio");
  const pioSession = structuredClone(state.session());
  assert.equal(state.documentId, null);
  assert.equal(state.page, 1);
  assert.equal(state.sourceQuery, "");
  assert.deepEqual(state.sourceHits, []);
  assert.equal(state.sourceScroll, 0);
  assert.equal(state.documents.length, 1);

  const restarted = new TuiState({ workspace: state.workspace.path });
  await restarted.initialize();
  assert.equal(restarted.modelId, "pio");
  assert.equal(restarted.documentId, null);
  restarted.setView("sources");
  assert.match(screenText(restarted), /RP2040 Datasheet/);
  assert.doesNotMatch(screenText(restarted), /ESP32-C6/);

  await state.loadSession(gpioSession, { persist: false });
  assert.equal(state.documentId, esp32.id);
  await state.loadSession(pioSession, { persist: false });
  assert.equal(state.documentId, null);
  state.documentId = esp32.id; // Explicit browsing is allowed.
  await state.loadProgramFile(pioProgram);
  assert.equal(state.documentId, null);
  assert.equal(state.programDebugger.steps.length, 0);
  assert.equal(state.trace.length, 1);

  state.documentId = esp32.id;
  const before = structuredClone(state.session());
  await assert.rejects(
    state.loadSession({ ...pioSession, modelId: "uninstalled-model" }),
    /not installed/,
  );
  assert.equal(state.documentId, esp32.id);
  assert.deepEqual(structuredClone(state.session()), before);
});

test("importing the current model reference preserves the running program and distinguishes explicit PDF browsing", async (t) => {
  const { state, app } = await setup(t, true);
  const esp32 = state.document;
  state.selectModel("pio");
  await state.loadProgramFile(pioProgram);
  app.key("N");
  app.key("N");
  assert.equal(state.tick, 16);
  state.programDebugger.toggleBreakpoint(14);
  state.seek(7);
  state.selected = 1;
  state.zoom = 2;
  const debug = state.programDebugger;
  const before = structuredClone({
    session: state.session(),
    trace: state.trace,
    selected: state.selected,
    zoom: state.zoom,
    offset: state.offset,
  });
  state.setView("sources");
  app.key("\r", { name: "return" });
  await idle(state);
  assert.equal(state.document.sha256, state.model.sources[0].sha256);
  assert.equal(state.page, state.model.sources[0].pdf_start_page);
  assert.equal(state.documents.length, 2);
  assert.equal(state.programDebugger, debug);
  assert.ok(debug.breakpoints.has(14));
  assert.deepEqual(
    structuredClone({
      session: state.session(),
      trace: state.trace,
      selected: state.selected,
      zoom: state.zoom,
      offset: state.offset,
    }),
    before,
  );
  assert.match(screenText(state), /Reference for RP2040 PIO/);

  state.documentId = esp32.id;
  state.page = 1;
  assert.match(screenText(state), /Browsing another PDF.*RP2040 PIO/);
  await state.loadProgramFile(pioProgram);
  assert.equal(state.document.sha256, state.model.sources[0].sha256);
  assert.equal(state.page, state.model.sources[0].pdf_start_page);
});

test("a changed bundled reference is rejected without replacing source or experiment", async (t) => {
  const { state } = await setup(t, true);
  state.models = state.models.map((model) =>
    model.id === "pio"
      ? {
          ...model,
          sources: model.sources.map((source) => ({
            ...source,
            sha256: "a".repeat(64),
          })),
        }
      : model,
  );
  const before = structuredClone({
    session: state.session(),
    trace: state.trace,
    documents: state.documents,
    documentId: state.documentId,
  });
  await assert.rejects(state.loadModelSource(), /fingerprint/);
  assert.deepEqual(
    structuredClone({
      session: state.session(),
      trace: state.trace,
      documents: state.documents,
      documentId: state.documentId,
    }),
    before,
  );
  assert.equal((await state.workspace.records("documents")).entries.length, 1);
});

test("tick-zero programs show real initial signal values and actionable guidance until time advances", async (t) => {
  const { state, app } = await setup(t);
  await state.loadProgramFile(pioProgram);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    for (const view of ["program", "wave"]) {
      state.setView(view);
      const frame = render(state);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((row) => displayWidth(row.text) <= columns));
      const text = screenText(state);
      assert.match(text, /SIGNALS.*initial values at tick 0/);
      assert.match(text, /no waveform history yet/);
      assert.match(text, /N step/);
      assert.match(text, /C continue/);
      assert.match(text, /DATA\s*=\s*0x1/);
      assert.match(text, /CLK\s*=\s*0x0/);
      assert.match(text, /ACK\s*=\s*0x0/);
    }
  }
  assert.equal(state.programDebugger.steps.length, 0);
  assert.equal(state.trace.length, 1);
  state.setView("program");
  app.key("N"); // The first assertion takes no simulation time.
  assert.equal(state.tick, 0);
  assert.match(screenText(state), /no waveform history yet/);
  app.key("N"); // wait 16 produces actual signal history.
  assert.equal(state.tick, 16);
  assert.equal(state.trace.length, 17);
  assert.doesNotMatch(screenText(state), /no waveform history yet/);
  state.setView("wave");
  assert.match(screenText(state), /CLK\s+[┌─ ]/);
  state.setView("program");
  app.key("r");
  assert.equal(state.trace.length, 1);
  assert.match(screenText(state), /no waveform history yet/);

  for (const [body, status] of [
    ["halt", "halted"],
    ["expect signal.ack == 1", "stopped"],
  ]) {
    state.programDebugger = new ProgramDebugger(
      state.model,
      parseProgram("model pio\n" + body),
    );
    state.programDebugger.step();
    state.syncProgram();
    assert.match(
      screenText(state),
      new RegExp("No time advanced.*program " + status),
    );
    assert.doesNotMatch(screenText(state), /no waveform history yet/);
    assert.match(screenText(state), /DATA\s*=\s*0x1/);
    assert.equal(state.trace.length, 1);
  }
});
