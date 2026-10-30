import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TuiState } from "../src/tui/state.js";
import { screenText, displayWidth } from "../src/tui/render.js";
import { circuitKey } from "../src/tui/circuit-panel.js";
import { buildCircuit } from "../src/circuit/files.js";

const examples = resolve("examples/connected-circuit");
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-circuit-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("connected TUI separates static rules and one-step probes, preserves the cursor and restores portable sessions", async (t) => {
  const root = await temporary(t),
    state = new TuiState({ workspace: join(root, "ui") });
  await state.initialize();
  await state.loadCircuitFile(join(examples, "swap.json"));
  const app = {
    state,
    prompt(_name, _value, callback) {
      app.callback = callback;
    },
    task(fn) {
      return fn();
    },
  };
  const nativeTrace = state.trace;
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    Object.assign(state, { columns, rows });
    const frame = screenText(state);
    assert.equal(frame.split("\n").length, rows);
    assert.ok(
      frame.split("\n").every((line) => displayWidth(line) === columns),
    );
    assert.match(frame, /ONE-STEP PROBE/);
    assert.match(frame, /event none/);
    assert.match(frame, /state.B\[0:0\] -> state.A.d/);
    circuitKey(app, "t", {});
    assert.match(screenText(state), /STATIC RULES/);
    circuitKey(app, "o", {});
    assert.match(screenText(state), /No native observation/);
    circuitKey(app, "e", {});
  }
  const probe = join(root, "probe.json");
  await writeFile(
    probe,
    JSON.stringify({
      state: { A: 0, B: 1 },
      inputs: { clk: 1 },
      previousClock: 0,
    }),
  );
  circuitKey(app, "p", {});
  await app.callback(probe);
  assert.equal(state.trace, nativeTrace);
  assert.equal(state.tick, 0);
  assert.match(screenText(state), /Q 0b0 -> next Q 0b1/);
  assert.match(screenText(state), /Selected load/);
  assert.throws(() => state.requireManualExperiment(), /read-only/);
  const session = state.session(),
    saved = join(root, "session.json");
  assert.equal(session.format, "chipsim-circuit-session");
  await writeFile(saved, JSON.stringify(session));
  await state.loadFile(saved);
  assert.equal(state.model.connected.model.spec.id, "swap");
  assert.deepEqual(state.model.connected.ui.probe, {
    state: { A: 0, B: 1 },
    inputs: { clk: 1 },
    previousClock: 0,
  });
  assert.match(screenText(state), /Q 0b0 -> next Q 0b1/);
  const current = state.model,
    trace = state.trace;
  session.sourceBytes = Buffer.from("changed").toString("base64");
  await writeFile(saved, JSON.stringify(session));
  await assert.rejects(state.loadFile(saved), /fingerprint/);
  assert.equal(state.model, current);
  assert.equal(state.trace, trace);
});

test(
  "native connected view follows actual time/cursor without replacing the recording; portable evidence reopens",
  { skip: process.env.CHIPSIM_TEST_CIRCUIT !== "1" },
  async (t) => {
    const root = await temporary(t),
      bundle = await buildCircuit(
        join(examples, "swap.json"),
        join(root, "run"),
        { operation: "run", stimulus: join(examples, "swap.stimulus.json") },
      );
    const state = new TuiState({ workspace: join(root, "ui") });
    await state.initialize();
    await state.loadCircuitFile(bundle.path);
    const trace = state.trace,
      model = state.model;
    state.seek(1);
    state.model.connected.ui.tab = "native";
    for (const [columns, rows] of [
      [80, 24],
      [120, 40],
    ]) {
      Object.assign(state, { columns, rows });
      const frame = screenText(state);
      assert.match(frame, /NATIVE sample 1/);
      assert.match(frame, /agrees with one-step relation/);
      assert.match(frame, /Q 0b0 -> next Q 0b1/);
    }
    state.setView("wave");
    state.setView("circuit");
    assert.equal(state.trace, trace);
    assert.equal(state.model, model);
    assert.equal(state.tick, 1);
    const saved = join(root, "saved.json");
    await writeFile(saved, JSON.stringify(state.session()));
    await state.loadCircuitFile(saved);
    assert.equal(state.tick, 1);
    assert.equal(state.model.connected.recorded, true);
    // The standalone session is a verified data payload suitable for managed
    // artifact inspection; it needs none of the neighboring bundle files.
    const detached = join(root, "detached.json");
    await writeFile(detached, await readFile(join(root, "run/session.json")));
    await rm(join(root, "run"), { recursive: true, force: true });
    await state.loadCircuitFile(detached);
    assert.equal(state.model.connected.recorded, true);
  },
);
