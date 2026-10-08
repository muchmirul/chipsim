import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { extractPDFFile } from "../src/documents/extract-node.js";
import {
  compileDocument,
  compileDocumentProfiles,
  documentProfiles,
  profilesForDocument,
  profileForDocument,
} from "../src/model/profiles/index.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { sourceModelItems } from "../src/tui/source-simulations.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { screenText, render, displayWidth } from "../src/tui/render.js";
const root = new URL("../", import.meta.url).pathname;
const hcPDF = join(root, "docs/references/nexperia-74hc595.pdf");
const c6PDF = join(root, "docs/references/espressif-esp32-c6-trm.pdf");
const hcPromise = extractPDFFile(hcPDF),
  c6Promise = extractPDFFile(c6PDF);
async function setup(t, document) {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-source-menu-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  const saved = await state.workspace.saveDocument(structuredClone(document));
  state.documents.push(saved);
  state.documentId = saved.id;
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = input.resume = input.pause = () => {};
  output.columns = 80;
  output.rows = 24;
  output.write = () => {};
  return { state, app: new TerminalApp(state, { input, output }) };
}
const experiment = (state) =>
  structuredClone({
    session: state.session(),
    trace: state.trace,
    history: state.stimulus.history,
  });
const enter = (app) => app.key("\r", { name: "return" });
async function idle(state) {
  const deadline = Date.now() + 15000;
  while (state.busy && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.busy, false, state.message);
  assert.equal(state.error, false, state.message);
}

test("one exact manual can supply multiple reviewed profiles without ID collisions or implicit first-profile selection", async (t) => {
  const document = await hcPromise,
    base = documentProfiles.find((profile) => profile.id === "hc595"),
    variant = {
      ...base,
      id: "test-second-scope",
      name: "Registry test scope",
      build(source) {
        const spec = base.build(source);
        spec.name = "Registry fixture with a colliding model ID";
        return spec;
      },
    };
  documentProfiles.push(variant);
  t.after(() => documentProfiles.splice(documentProfiles.indexOf(variant), 1));
  assert.equal(profilesForDocument(document).length, 2);
  assert.throws(
    () => profileForDocument(document),
    /multiple reviewed profiles/,
  );
  assert.throws(() => compileDocument(document), /choose profileId/);
  assert.equal(
    compileDocument(document, { profileId: variant.id }).profile.id,
    variant.id,
  );
  assert.equal(compileDocument(document, { profileId: "unknown" }), null);
  const reserved = ["hc595", "hc595-" + document.sha256.slice(0, 8)],
    results = compileDocumentProfiles(document, { reservedIds: reserved });
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map((result) => result.spec.id)).size, 2);
  assert.ok(results.every((result) => !reserved.includes(result.spec.id)));
  assert.ok(
    results.every((result) => result.checks.every((check) => check.passed)),
  );
  assert.equal(analyzeDocument(document).models.length, 2);
  const { state, app } = await setup(t, document);
  await state.loadFile(hcPDF);
  assert.equal(
    state.models.filter((model) => model.kind === "document").length,
    2,
  );
  assert.equal(sourceModelItems(state.document, state.models).length, 2);
  assert.equal((await state.workspace.records("models")).entries.length, 2);
  assert.deepEqual(
    compileDocumentProfiles({ ...document, sha256: "a".repeat(64) }),
    [],
  );
  const originalBuild = variant.build;
  variant.build = (source) => {
    const spec = originalBuild(source);
    spec.evidence[0].quote = "This quotation is absent from the actual PDF.";
    return spec;
  };
  assert.throws(
    () => compileDocumentProfiles(document),
    /quote does not occur/,
  );
  const before = experiment(state),
    cached = state.document,
    records = await state.workspace.records("documents");
  await app.sourceSimulations.find(cached);
  assert.equal(state.error, true);
  assert.match(state.message, /quote does not occur/);
  assert.equal(state.document, cached);
  assert.deepEqual(experiment(state), before);
  assert.deepEqual(await state.workspace.records("documents"), records);
});

test("a cached ESP32-C6 manual offers scope review and creates a selected model without an external reimport", async (t) => {
  const { state, app } = await setup(t, await c6Promise);
  state.document.analysis = {
    models: [{ id: "phantom", name: "Not an installed model" }],
  };
  state.setParameter("payload", 300);
  state.setInputs([{ tick: 35, signal: "ack", value: 1 }]);
  state.seek(7);
  const before = experiment(state),
    savedModels = await state.workspace.records("models");
  state.setView("sources");
  assert.match(screenText(state), /No simulation linked/);
  assert.deepEqual(sourceModelItems(state.document, state.models), []);
  app.key("o");
  assert.equal(state.menu.items[0].value.kind, "find");
  enter(app);
  await idle(state);
  assert.match(state.menu.title, /CREATE SIMULATION/);
  assert.equal(state.menu.items[0].value.id, "esp32c6-pcnt");
  assert.equal(state.menu.items[1].value.id, "esp32c6-gpio");
  assert.deepEqual(experiment(state), before);
  assert.deepEqual(await state.workspace.records("models"), savedModels);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    const frame = render(state);
    assert.equal(frame.length, rows);
    assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
    assert.match(screenText(state), /SCOPE \/ ACTION/);
    assert.match(screenText(state), /channel 1 disabled/);
    for (let n = 0; n < 40; n++) app.key("l");
    assert.match(screenText(state), /Existing models are preserved/);
    for (let n = 0; n < 40; n++) app.key("h");
  }
  app.key("", { name: "escape" });
  assert.deepEqual(experiment(state), before);
  assert.deepEqual(await state.workspace.records("models"), savedModels);
  app.key("o");
  enter(app);
  await idle(state);
  enter(app);
  await idle(state);
  assert.equal(state.modelId, "esp32c6-pcnt");
  assert.equal(state.view, "wave");
  assert.equal(state.trace[13].registers.pulse_count, 65534);
  const restored = new TuiState({ workspace: state.workspace.path });
  await restored.initialize();
  assert.ok(restored.models.some((model) => model.id === "esp32c6-pcnt"));
  assert.ok(!restored.models.some((model) => model.id === "esp32c6-gpio"));
  const oldModel = state.model.spec;
  await app.sourceSimulations.find(state.document);
  assert.equal(state.menu.items[1].value.id, "esp32c6-gpio");
  app.key("j");
  enter(app);
  await idle(state);
  assert.equal(state.modelId, "esp32c6-gpio");
  assert.deepEqual(
    state.models.find((model) => model.id === "esp32c6-pcnt").spec,
    oldModel,
  );
});

test("opening the active source simulation preserves the experiment and explicit new copies preserve authored models", async (t) => {
  const { state, app } = await setup(t, await hcPromise),
    spec = compileDocument(state.document).spec;
  spec.name = "My authored shift experiment";
  await state.installModel(spec);
  state.setParameter("initial_shift", 165);
  state.driveInput("ds", 1, 1);
  state.seek(5);
  const before = experiment(state),
    oldId = state.modelId,
    filename = join(state.workspace.path, "models", oldId + ".json"),
    oldBytes = await readFile(filename, "utf8");
  app.key("o");
  enter(app);
  assert.deepEqual(experiment(state), before);
  await app.sourceSimulations.find(state.document);
  assert.equal(state.error, false, state.message);
  assert.notEqual(state.menu.items[0].value.id, oldId);
  assert.deepEqual(experiment(state), before);
  enter(app);
  await idle(state);
  assert.notEqual(state.modelId, oldId);
  assert.equal(await readFile(filename, "utf8"), oldBytes);
  assert.deepEqual(structuredClone(state.configurations.get(oldId)), {
    parameters: before.session.parameters,
    inputs: before.session.inputs,
    duration: before.session.duration,
  });
  assert.deepEqual(state.stimulus.histories.get(oldId), before.history);
  assert.ok(
    state.models.some(
      (model) => model.id === oldId && model.name === spec.name,
    ),
  );
});

test("finding models verifies current PDF bytes even with a current cache version", async (t) => {
  const { state, app } = await setup(t, await hcPromise),
    document = state.document,
    before = experiment(state),
    records = await state.workspace.records("documents");
  await copyFile(
    join(root, "docs/references/ti-tca9534.pdf"),
    document.filePath,
  );
  await app.sourceSimulations.find(document);
  assert.equal(state.error, true);
  assert.match(state.message, /fingerprint changed/);
  assert.equal(state.document, document);
  assert.deepEqual(experiment(state), before);
  assert.deepEqual(await state.workspace.records("documents"), records);
  assert.equal((await state.workspace.records("models")).entries.length, 0);
});

test("the document CLI selects an explicit model and reports available IDs on a mismatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chipsim-document-select-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "selected.json");
  execFileSync(
    process.execPath,
    ["scripts/document.mjs", hcPDF, "--model", "hc595", "--out", output],
    { cwd: root },
  );
  assert.equal(JSON.parse(await readFile(output, "utf8")).id, "hc595");
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["scripts/document.mjs", hcPDF, "--model", "nonexistent"],
        { cwd: root, stdio: "pipe" },
      ),
    (error) => /Available: hc595/.test(error.stderr.toString()),
  );
});
