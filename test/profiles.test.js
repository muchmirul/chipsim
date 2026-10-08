import { modelsForDocument } from "../src/documents/recognize.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compileDocument,
  profileForDocument,
  documentProfiles,
} from "../src/model/profiles/index.js";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { simulateModel } from "../src/model/engine.js";
import { TuiState } from "../src/tui/state.js";
const manualPath = new URL(
  "../docs/references/nexperia-74hc595.pdf",
  import.meta.url,
).pathname;
const documentPromise = extractPDFFile(manualPath);
const modelPromise = documentPromise.then(
  (document) => compileDocument(document).spec,
);
const event = (tick, signal, value) => ({ tick, signal, value });

test("reviewed datasheet profile requires exact bytes and its quoted evidence", async () => {
  const document = await documentPromise,
    compiled = compileDocument(document);
  assert.equal(compiled.spec.id, "hc595");
  assert.equal(compiled.checks.length, 8);
  assert.ok(compiled.checks.every((check) => check.passed));
  assert.equal(documentProfiles.length, 1);
  assert.equal(profileForDocument(document).id, "hc595");
  assert.equal(
    compileDocument({
      ...document,
      sha256: "f".repeat(64),
      filename: "74HC_HCT595.pdf",
    }),
    null,
  );
  assert.throws(
    () =>
      compileDocument({
        ...document,
        pages: document.pages.map((page) => ({
          ...page,
          text: "Unrelated contents claiming the same hash.",
        })),
      }),
    /quote does not occur/,
  );
});

test("all byte values shift MSB-first into eight stages while latch holds until STCP", async () => {
  const model = await modelPromise;
  for (let byte = 0; byte < 256; byte++) {
    const inputs = Array.from({ length: 8 }, (_, index) => [
      event(1 + index * 2, "ds", (byte >> (7 - index)) & 1),
      event(1 + index * 2, "shcp", 1),
      event(2 + index * 2, "shcp", 0),
    ]).flat();
    inputs.push(event(17, "stcp", 1));
    const trace = simulateModel(
      model,
      { initial_storage: 0xa5 },
      { inputs, ticks: 17 },
    );
    assert.equal(trace[16].registers.shift, byte);
    assert.equal(trace[16].registers.storage, 0xa5);
    assert.equal(trace[17].registers.storage, byte);
    assert.equal(trace[17].signals.q7s, byte >> 7);
  }
});

test("function-table control combinations preserve reset priority and simultaneous old-data capture", async () => {
  const model = await modelPromise;
  // Expected values are taken from Table 3, independent of transition helpers.
  for (const previous of [0, 1, 0x40, 0x80, 0xa5, 0xff])
    for (const data of [0, 1])
      for (const reset of [0, 1])
        for (const shiftClock of [0, 1])
          for (const storageClock of [0, 1])
            for (const outputDisable of [0, 1]) {
              const trace = simulateModel(
                model,
                { initial_shift: previous, initial_storage: 0x5a },
                {
                  ticks: 1,
                  inputs: [
                    event(1, "ds", data),
                    event(1, "mr_n", reset),
                    event(1, "shcp", shiftClock),
                    event(1, "stcp", storageClock),
                    event(1, "oe_n", outputDisable),
                  ],
                },
              );
              const snapshot = trace.at(-1),
                expectedShift = reset
                  ? shiftClock
                    ? (previous * 2 + data) % 256
                    : previous
                  : 0;
              const expectedStorage = storageClock
                ? reset
                  ? previous
                  : 0
                : 0x5a;
              assert.equal(snapshot.registers.shift, expectedShift);
              assert.equal(snapshot.registers.storage, expectedStorage);
              assert.equal(snapshot.signals.parallel_latch, expectedStorage);
              assert.equal(snapshot.signals.q7s, expectedShift >> 7);
              assert.equal(snapshot.signals.outputs_enabled, 1 - outputDisable);
            }
});

test("tick-zero levels establish clock history and MR release while clock stays high does not invent an edge", async () => {
  const model = await modelPromise;
  const trace = simulateModel(
    model,
    { initial_shift: 0xff, initial_storage: 0xa5 },
    {
      ticks: 4,
      inputs: [
        event(0, "mr_n", 0),
        event(0, "shcp", 1),
        event(0, "stcp", 1),
        event(1, "mr_n", 1),
        event(1, "ds", 1),
        event(2, "shcp", 0),
        event(3, "shcp", 1),
      ],
    },
  );
  assert.equal(trace[0].registers.shift, 0);
  assert.equal(trace[0].registers.storage, 0xa5);
  assert.equal(trace[1].registers.shift, 0);
  assert.equal(trace[1].registers.storage, 0xa5);
  assert.equal(trace[2].registers.shift, 0);
  assert.equal(trace[3].registers.shift, 1);
});

test("importing the PDF alone creates, selects, and persists a runnable TUI model", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-profile-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  assert.equal(state.models.length, 6);
  await state.loadFile(manualPath);
  assert.equal(state.modelId, "hc595");
  assert.match(state.message, /reviewed datasheet profile/);
  assert.equal(state.model.warnings.length, 0);
  assert.equal(state.trace[18].registers.storage, 179);
  assert.equal(state.trace[20].signals.outputs_enabled, 1);
  assert.equal(state.trace[26].registers.shift, 0);
  assert.equal(state.trace[26].registers.storage, 179);
  assert.equal(state.trace[28].registers.storage, 0);
  const saved = JSON.parse(
    await readFile(join(workspace, "models/hc595.json"), "utf8"),
  );
  assert.equal(saved.sources[0].sha256, (await documentPromise).sha256);
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadFile(manualPath);
  assert.equal(restored.modelId, "hc595");
  assert.equal(
    restored.models.filter((model) => model.id === "hc595").length,
    1,
  );
  // Authored edits tied to this source survive a later import.
  saved.name = "Reviewed local adaptation";
  await restored.installModel(saved);
  await restored.loadFile(manualPath);
  assert.equal(restored.model.name, saved.name);
});

test("automatic compilation preserves unrelated authored models with the same catalog ID", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-profile-collision-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  const unrelated = structuredClone(await modelPromise);
  unrelated.name = "Unrelated authored model";
  unrelated.sources[0].sha256 = "f".repeat(64);
  await state.installModel(unrelated);
  await state.loadFile(manualPath);
  assert.notEqual(state.modelId, "hc595");
  assert.deepEqual(
    modelsForDocument(await documentPromise, state.models).map(
      (model) => model.id,
    ),
    [state.modelId],
  );
  assert.equal(
    state.models.find((model) => model.id === "hc595").name,
    unrelated.name,
  );
  assert.equal(state.model.sources[0].sha256, (await documentPromise).sha256);
  assert.equal(
    JSON.parse(await readFile(join(workspace, "models/hc595.json"), "utf8"))
      .name,
    unrelated.name,
  );
  const unique = compileDocument(await documentPromise, {
    reservedIds: ["hc595", "hc595-fa24207e"],
  });
  assert.equal(unique.spec.id, "hc595-fa24207e-2");
});
