import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  EXTRACTION_VERSION,
  needsDocumentRefresh,
  replaceExtraction,
} from "../src/documents/cache.js";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { readRegisterTables } from "../src/model/register-tables/read.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, displayWidth, screenText } from "../src/tui/render.js";

const pdf = new URL("../docs/references/tca9534/ti-tca9534.pdf", import.meta.url)
  .pathname;
const extracted = extractPDFFile(pdf);
function legacy(document) {
  const old = structuredClone(document);
  delete old.extractionVersion;
  old.tableScanLimit = 32;
  old.registerScanLimit = 32;
  old.analysis = {
    models: [{ id: "obsolete" }],
    registerTables: [{ id: "fabricated" }],
    diagnostics: [{ reason: "Old analysis" }],
  };
  for (const page of old.pages) delete page.layoutLines;
  return old;
}
async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), "chipsim-cache-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const state = new TuiState({ workspace: path });
  await state.initialize();
  const document = await state.workspace.saveDocument(legacy(await extracted));
  state.documents.push(document);
  state.documentId = document.id;
  const spec = structuredClone(analyzeDocument(await extracted).models[0].spec);
  spec.name = "My edited GPIO experiment";
  spec.assumptions.push("An authored experiment that refresh must preserve.");
  await state.installModel(spec);
  return state;
}
function experiment(state) {
  return structuredClone({
    session: state.session(),
    trace: state.trace,
    history: state.stimulus.history,
  });
}

test("fresh PDF extraction replaces stale scan/analysis metadata and retains source identity", async () => {
  const fresh = await extracted,
    old = legacy(fresh);
  old.filename = "My named manual.pdf";
  old.createdAt = "2020-01-01T00:00:00.000Z";
  assert.equal(needsDocumentRefresh(old), true);
  assert.equal(needsDocumentRefresh(fresh), false);
  const updated = replaceExtraction(old, fresh);
  assert.equal(updated.filename, old.filename);
  assert.equal(updated.createdAt, old.createdAt);
  assert.equal(updated.id, old.id);
  assert.equal(updated.extractionVersion, EXTRACTION_VERSION);
  assert.equal(updated.tableScanLimit, undefined);
  assert.equal(updated.registerScanLimit, undefined);
  assert.equal(updated.analysis, undefined);
  assert.deepEqual(readRegisterTables(updated), readRegisterTables(fresh));
  assert.throws(
    () => replaceExtraction(old, { ...fresh, sha256: "f".repeat(64) }),
    /fingerprint changed/,
  );
  assert.equal(old.analysis.models[0].id, "obsolete");
});

test("an old terminal workspace refreshes on register-draft entry without replacing authored models or experiments", async (t) => {
  const saved = await workspace(t),
    state = new TuiState({ workspace: saved.workspace.path });
  await state.initialize();
  state.selectModel(saved.modelId);
  state.setInputs([]);
  state.setDuration(80);
  state.accessRegister("write", 1, 0xb3);
  state.accessRegister("read", 1);
  state.format = "decimal";
  state.seek(2);
  const before = experiment(state),
    model = state.model,
    specs = await state.workspace.records("models"),
    input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = input.pause = () => {};
  output.write = () => {};
  output.columns = 80;
  output.rows = 24;
  const app = new TerminalApp(state, { input, output });
  app.key("c");
  for (let i = 0; i < 4; i++) app.key("j");
  app.key("\r", { name: "return" });
  for (let i = 0; i < 1000 && state.busy; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(state.busy, false);
  assert.match(state.menu?.title || state.message, /REGISTER TABLE/);
  assert.equal(state.model, model);
  assert.deepEqual(experiment(state), before);
  assert.deepEqual(await state.workspace.records("models"), specs);
  assert.equal(state.document.extractionVersion, EXTRACTION_VERSION);
  assert.equal(state.document.analysis, undefined);
  assert.equal(readRegisterTables(state.document).tables[0].rows.length, 4);
  const persisted = (await state.workspace.records("documents")).entries[0];
  assert.deepEqual(persisted, state.document);
  assert.deepEqual(await readFile(persisted.filePath), await readFile(pdf));
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    const frame = render(state);
    assert.equal(frame.length, rows);
    assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
    assert.match(screenText(state), /REGISTER TABLE/);
  }
  // A current cache is reused: it does not reopen the PDF on every entry.
  const restored = new TuiState({ workspace: state.workspace.path });
  await restored.initialize();
  const document = restored.document;
  await rm(document.filePath);
  assert.equal(await restored.refreshDocument(document.id), document);
});

test("failed saved-PDF refresh preserves disk records, source and the working experiment", async (t) => {
  const state = await workspace(t),
    document = state.document,
    before = experiment(state),
    onDisk = await state.workspace.records("documents");
  await copyFile(
    new URL("../docs/references/pca9555/ti-pca9555.pdf", import.meta.url),
    document.filePath,
  );
  await assert.rejects(
    state.refreshDocument(document.id),
    /fingerprint changed/,
  );
  assert.equal(state.document, document);
  assert.deepEqual(await state.workspace.records("documents"), onDisk);
  assert.deepEqual(experiment(state), before);
  await rm(document.filePath);
  await assert.rejects(
    state.refreshDocument(document.id),
    /Saved PDF is missing/,
  );
  assert.equal(state.document, document);
  assert.deepEqual(experiment(state), before);
  // Existing model evidence must also validate against the fresh source.
  await copyFile(pdf, document.filePath);
  const spec = structuredClone(state.model.spec),
    evidence = spec.evidence[0];
  evidence.quote = "A stale cached quotation absent from the original PDF.";
  document.pages.find((page) => page.number === evidence.page).text +=
    "\n" + evidence.quote;
  await state.installModel(spec);
  const changed = experiment(state);
  await assert.rejects(state.refreshDocument(document.id), /quote|excerpt/i);
  assert.equal(state.document, document);
  assert.deepEqual(experiment(state), changed);
  assert.deepEqual(await state.workspace.records("documents"), onDisk);
});
