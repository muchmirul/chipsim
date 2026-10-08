import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { compileDocument } from "../src/model/profiles/index.js";
import { simulateModel } from "../src/model/engine.js";
import { TuiState } from "../src/tui/state.js";
import { screenText, render, displayWidth } from "../src/tui/render.js";
import { exportJSON, exportCSV, exportVCD } from "../src/trace/export.js";

const path = new URL(
  "../docs/references/espressif-esp32-c6-trm.pdf",
  import.meta.url,
).pathname;
const documentPromise = extractPDFFile(path);
const event = (tick, signal, value) => ({ tick, signal, value });
const modelPromise = documentPromise.then(
  (document) => compileDocument(document).spec,
);

test("the supplied ESP32-C6 manual opens only its reviewed PCNT scope with real page evidence", async () => {
  const document = await documentPromise,
    result = analyzeDocument(document);
  assert.equal(document.pageCount, 1394);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].spec.id, "esp32c6-pcnt");
  assert.equal(result.models[0].checks.length, 16);
  assert.ok(result.models[0].checks.every((check) => check.passed));
  assert.equal(compileDocument({ ...document, sha256: "0".repeat(64) }), null);
  const changed = structuredClone(document);
  changed.pages.find((page) => page.number === 1015).text = "Unrelated page";
  assert.throws(() => compileDocument(changed), /quote does not occur/);
  assert.match(result.models[0].spec.scope, /channel 1 disabled/);
  assert.match(result.models[0].spec.scope, /MMIO, interrupts/);
});

// Literal Table 31.2-1..4 outcomes: rows = edge encoding, columns = control
// encoding. Keep the oracle separate from the model's expression builders.
const table = [
  [0, 0, 0, 0],
  [1, -1, 0, 0],
  [-1, 1, 0, 0],
  [0, 0, 0, 0],
];
test("every edge/control encoding, held level, pause and clear agrees with an independent signed counter oracle", async () => {
  const model = await modelPromise;
  for (let positive = 0; positive < 4; positive++)
    for (let negative = 0; negative < 4; negative++)
      for (let low = 0; low < 4; low++)
        for (let high = 0; high < 4; high++)
          for (const initial of [0, 1]) {
            const inputs = [],
              levels = [];
            for (let tick = 0; tick <= 48; tick++) {
              const pins = {
                pulse: tick === 0 ? initial : Math.floor(tick / 2) % 2,
                control: Math.floor(tick / 7) % 2,
                pause: Number(tick >= 17 && tick <= 21),
                clear: Number(tick === 11 || tick === 12 || tick === 39),
              };
              levels.push(pins);
              for (const [signal, value] of Object.entries(pins))
                inputs.push(event(tick, signal, value));
            }
            const trace = simulateModel(
              model,
              {
                positive_mode: positive,
                negative_mode: negative,
                control_low_mode: low,
                control_high_mode: high,
                high_limit: 3,
                low_limit_magnitude: 2,
              },
              { inputs, ticks: 48 },
            );
            let count = 0,
              previous = initial;
            for (const [tick, pins] of levels.entries()) {
              let delta = 0,
                highHit = 0,
                lowHit = 0;
              if (tick && !pins.pause && !pins.clear && pins.pulse !== previous)
                delta =
                  table[pins.pulse ? positive : negative][
                    pins.control ? high : low
                  ];
              if (pins.clear) count = 0;
              else if (delta) {
                count += delta;
                if (count === 3) {
                  highHit = 1;
                  count = 0;
                }
                if (count === -2) {
                  lowHit = 1;
                  count = 0;
                }
              }
              previous = pins.pulse;
              const snapshot = trace[tick];
              assert.notEqual(snapshot.phase, "fault");
              assert.equal(snapshot.registers.pulse_count, count & 65535);
              assert.equal(snapshot.registers.previous_pulse, previous);
              assert.equal(
                snapshot.registers.control_mode,
                pins.control ? high : low,
              );
              assert.equal(snapshot.signals.negative, Number(count < 0));
              assert.equal(snapshot.signals.magnitude, Math.abs(count));
              assert.equal(snapshot.signals.count_up, Number(delta === 1));
              assert.equal(snapshot.signals.count_down, Number(delta === -1));
              assert.equal(snapshot.signals.high_limit_hit, highHit);
              assert.equal(snapshot.signals.low_limit_hit, lowHit);
            }
          }
});

test("signed 16-bit extrema clear at the configured limit and invalid configuration rejects", async () => {
  const model = await modelPromise;
  for (const [start, mode, limitSignal] of [
    [32766, 1, "high_limit_hit"],
    [-32767, 2, "low_limit_hit"],
  ]) {
    // A test-only initialized state exercises one boundary step without a
    // >32768-edge run, beyond the engine's 10000-tick experiment bound.
    const variant = structuredClone(model);
    variant.registers.find((item) => item.id === "pulse_count").initial =
      start & 65535;
    variant.signals.find((item) => item.id === "negative").initial = Number(
      start < 0,
    );
    variant.signals.find((item) => item.id === "magnitude").initial =
      Math.abs(start);
    const final = simulateModel(
      variant,
      { positive_mode: mode, high_limit: 32767, low_limit_magnitude: 32768 },
      { inputs: [event(1, "pulse", 1)], ticks: 1 },
    ).at(-1);
    assert.equal(final.registers.pulse_count, 0);
    assert.equal(final.signals[limitSignal], 1);
    assert.equal(final.signals.magnitude, 0);
  }
  for (const parameters of [
    { high_limit: 0 },
    { high_limit: 32768 },
    { low_limit_magnitude: 0 },
    { low_limit_magnitude: 32769 },
    { positive_mode: 4 },
    { control_low_mode: -1 },
  ])
    assert.throws(() => simulateModel(model, parameters), /must be an integer/);
});

test("real-manual terminal import, trace exports, saved experiments and authored precedence work for ESP32-C6 PCNT", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-c6-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(path);
  assert.equal(state.modelId, "esp32c6-pcnt");
  assert.equal(state.models.filter((m) => m.kind === "document").length, 1);
  assert.equal(state.trace[9].signals.high_limit_hit, 1);
  assert.equal(state.trace[11].registers.pulse_count, 65535);
  assert.equal(state.trace[19].signals.low_limit_hit, 1);
  state.seek(13);
  state.format = "decimal";
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    for (const view of [
      "wave",
      "inspect",
      "registers",
      "log",
      "model",
      "sources",
    ]) {
      state.setView(view);
      const frame = render(state);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
      assert.match(screenText(state), /ESP32-C6/);
    }
  }
  const json = JSON.parse(
    exportJSON(
      state.model,
      state.trace,
      state.config.parameters,
      state.config.inputs,
    ),
  );
  assert.equal(json.trace[13].registers.pulse_count, 65534);
  assert.equal(json.trace[13].signals.magnitude, 2);
  assert.match(exportCSV(state.model, state.trace), /reg.pulse_count/);
  assert.match(exportVCD(state.model, state.trace), /pulse_count/);
  const session = state.session(),
    trace = state.trace;
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(session);
  assert.equal(restored.tick, 13);
  assert.deepEqual(restored.trace, trace);
  const authored = structuredClone(state.model.spec);
  authored.name = "My ESP32-C6 experiment";
  await restored.installModel(authored);
  await restored.loadFile(path);
  assert.equal(restored.model.name, authored.name);
  assert.deepEqual(
    JSON.parse(
      await readFile(join(workspace, "models", authored.id + ".json"), "utf8"),
    ),
    authored,
  );
});
