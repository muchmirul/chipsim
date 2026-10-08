import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import {
  compileDocument,
  profileForDocument,
} from "../src/model/profiles/index.js";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { simulateModel, runChecks } from "../src/model/engine.js";
import { validateModel } from "../src/model/validate.js";
import { registerAccessInputs } from "../src/model/register-access.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, displayWidth, screenText } from "../src/tui/render.js";
import { exportVCD } from "../src/trace/export.js";
import { op, assign } from "../src/model/builders/shared.js";

const path = new URL("../docs/references/ti-pca9555.pdf", import.meta.url)
  .pathname;
const docPromise = extractPDFFile(path);
const specPromise = docPromise.then(
  (document) => compileDocument(document).spec,
);
const event = (tick, signal, value) => ({ tick, signal, value });
const access = (tick, address, write, value, request) => [
  event(tick, "address", address),
  event(tick, "write", write),
  event(tick, "write_data", value),
  event(tick, "request", request),
];

test("a faulting authored register experiment retains the previous working trace and configuration", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-register-fault-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const model = structuredClone(await specPromise);
  model.id = "pca9555-fault-experiment";
  const trigger = op(
    "and",
    op("eq", "signal.write_data", 42),
    op("and", "signal.valid", "signal.write"),
  );
  for (const state of model.states)
    state.tick.push(
      assign(
        "reg.output0",
        op("select", trigger, op("div", 1, 0), "reg.output0"),
      ),
    );
  const s = new TuiState({ workspace });
  await s.initialize();
  await s.installModel(model);
  const trace = s.trace,
    config = structuredClone(s.config);
  assert.throws(
    () => s.accessRegister("write", 2, 42),
    /Simulation fault at tick 1: Division by zero/,
  );
  assert.equal(s.trace, trace);
  assert.equal(s.tick, 0);
  assert.deepEqual(s.config, config);
});

test("PCA9555 profile validates actual vendor pages, checks, and exact-source rejection", async () => {
  const doc = await docPromise,
    spec = await specPromise;
  assert.equal(profileForDocument(doc).id, "pca9555");
  assert.deepEqual(validateModel(spec, [doc]).warnings, []);
  assert.equal(spec.registerMap.length, 8);
  assert.ok(runChecks(spec).every((check) => check.passed));
  assert.equal(compileDocument({ ...doc, sha256: "f".repeat(64) }), null);
  assert.throws(
    () => compileDocument({ ...doc, pages: [] }),
    /quote does not occur/,
  );
  assert.match(spec.scope, /interrupt erratum/);
});

test("all latch bytes in either port respect per-bit direction, inversion, readback, and bank independence", async () => {
  const spec = await specPromise;
  for (const port of [0, 1])
    for (let byte = 0; byte < 256; byte++)
      for (const config of [0, 85, 170, 255]) {
        const external = (byte * 17 + 49) & 255;
        const polarity = byte ^ 0xff;
        const inputs = [
          event(0, "external" + port, external),
          ...access(1, 2 + port, 1, byte, 1),
          ...access(2, 6 + port, 1, config, 0),
          ...access(3, 4 + port, 1, polarity, 1),
          ...access(4, port, 0, 0, 0),
          ...access(5, 2 + port, 0, 0, 1),
        ];
        const trace = simulateModel(spec, {}, { inputs, ticks: 5 });
        let expectedRead = 0;
        for (let bit = 0; bit < 8; bit++) {
          const inputMode = (config >> bit) & 1;
          const level = inputMode
            ? ((external >> bit) & 1) ^ ((polarity >> bit) & 1)
            : (byte >> bit) & 1;
          expectedRead += level * 2 ** bit;
          assert.equal(
            trace[4].signals[`p${port}${bit}_driver`],
            inputMode ? "Z" : (byte >> bit) & 1,
          );
        }
        assert.equal(trace[4].signals.read_data, expectedRead);
        assert.equal(trace[5].signals.read_data, byte);
        assert.equal(trace[5].registers["output" + (1 - port)], 255);
        assert.equal(trace[5].registers["configuration" + (1 - port)], 255);
        assert.equal(trace[5].signals.interrupt_pending, 0);
      }
});

test("independent transaction oracle covers mixed reads, writes, masks, hold, invalid addresses, resets, and interrupts", async () => {
  const spec = await specPromise;
  let seed = 0x5295;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const inputs = [];
  let token = 0;
  for (let tick = 1; tick <= 1000; tick++) {
    if (tick % 13 === 0) token ^= 1;
    else if (random(3)) token ^= 1;
    inputs.push(
      ...access(tick, random(11), random(2), random(256), token),
      event(tick, "external0", random(256)),
      event(tick, "external1", random(256)),
      event(tick, "power_reset", tick % 17 === 0 ? 1 : 0),
    );
  }
  const trace = simulateModel(spec, {}, { ticks: 1000, inputs });
  const latches = [255, 255, 0, 0, 255, 255],
    sampled = [255, 255];
  let previous = 0,
    retained = 0;
  for (const snapshot of trace) {
    const s = snapshot.signals;
    const accepted =
      snapshot.tick > 0 && !s.power_reset && s.request !== previous;
    const error = accepted && s.address > 7;
    if (snapshot.tick > 0 && s.power_reset)
      latches.splice(0, 6, 255, 255, 0, 0, 255, 255);
    else if (accepted && s.write && s.address >= 2 && s.address <= 7)
      latches[s.address - 2] = s.write_data;
    const pinBytes = [0, 0],
      inputBytes = [0, 0];
    let pending = false;
    for (const port of [0, 1]) {
      for (let bit = 0; bit < 8; bit++) {
        const isInput = (latches[4 + port] >> bit) & 1;
        const physical =
          ((isInput ? s["external" + port] : latches[port]) >> bit) & 1;
        pinBytes[port] += physical * 2 ** bit;
        inputBytes[port] +=
          (physical ^ (isInput ? (latches[2 + port] >> bit) & 1 : 0)) *
          2 ** bit;
        assert.equal(s[`p${port}${bit}_driver`], isInput ? "Z" : physical);
      }
      if (
        snapshot.tick === 0 ||
        s.power_reset ||
        (accepted && !s.write && s.address === port)
      )
        sampled[port] = pinBytes[port];
      for (let bit = 0; bit < 8; bit++)
        if (
          (latches[4 + port] >> bit) & 1 &&
          ((sampled[port] >> bit) & 1) !== ((pinBytes[port] >> bit) & 1)
        )
          pending = true;
      assert.equal(s["input" + port], inputBytes[port]);
      assert.equal(snapshot.registers["sampled" + port], sampled[port]);
    }
    if (s.power_reset) retained = 0;
    else if (accepted && !s.write && !error)
      retained = [...inputBytes, ...latches][s.address];
    assert.equal(s.read_data, retained);
    assert.equal(s.valid, Number(accepted));
    assert.equal(s.error, Number(error));
    assert.equal(s.interrupt_pending, Number(pending));
    assert.equal(s.int_driver, pending ? 0 : "Z");
    previous = s.request;
  }
});

test("transaction insertion and replacement preserve future accesses even with held fields and request tokens", async () => {
  const spec = await specPromise;
  const inputs = [
    ...access(2, 2, 1, 179, 1),
    event(4, "request", 0),
    event(5, "request", 0),
    ...access(6, 6, 1, 0, 1),
    event(8, "external1", 0),
  ];
  let edited = registerAccessInputs(spec, inputs, {
    tick: 3,
    operation: "write",
    address: 2,
    value: 0,
  });
  let trace = simulateModel(spec, {}, { ticks: 8, inputs: edited });
  assert.equal(trace[3].registers.output0, 0);
  assert.equal(trace[4].registers.output0, 179);
  assert.equal(trace[5].signals.valid, 0);
  assert.equal(trace[6].registers.configuration0, 0);
  assert.equal(trace[8].signals.external1, 0);
  edited = registerAccessInputs(spec, edited, {
    tick: 3,
    operation: "read",
    address: 2,
  });
  trace = simulateModel(spec, {}, { ticks: 8, inputs: edited });
  assert.equal(trace[3].signals.read_data, 179);
  assert.equal(trace[4].signals.valid, 1);
  assert.equal(trace[6].registers.configuration0, 0);
  for (const options of [
    { tick: 0 },
    { tick: 10001 },
    { tick: 1, address: 256 },
    { tick: 1, value: 256 },
    { tick: 1, operation: "execute" },
  ])
    assert.throws(() =>
      registerAccessInputs(spec, inputs, {
        tick: 1,
        address: 2,
        operation: "write",
        value: 0,
        ...options,
      }),
    );
});

test("register metadata rejects malformed mappings rather than inferring peripheral semantics", async () => {
  const spec = await specPromise;
  const corruptions = [
    (m) => (m.registerInterface.request = "external0"),
    (m) => (m.registerInterface.valid = "write"),
    (m) => (m.registerInterface.kind = "i2c"),
    (m) => (m.registerInterface.address = "request"),
    (m) => (m.registerMap[0].value = "signal.request"),
    (m) => (m.registerMap[0].evidence = ["imaginary"]),
    (m) => (m.registerMap[0].address = 256),
    (m) => (m.registerMap[1].address = 0),
    (m) => (m.registerMap[0].name = ""),
    (m) => (m.registerMap[0] = null),
    (m) => delete m.registerInterface,
  ];
  for (const corrupt of corruptions) {
    const model = structuredClone(spec);
    corrupt(model);
    assert.throws(() => validateModel(model), /registerInterface|registerMap/);
  }
});

test("real PDF TUI register menus accept numeric formats, preserve sessions, and reject failed accesses atomically", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-registers-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const s = new TuiState({ workspace });
  await s.initialize();
  await s.loadFile(path);
  assert.equal(s.modelId, "pca9555");
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.isRaw = false;
  input.setRawMode = () => {};
  input.resume = input.pause = () => {};
  output.columns = 80;
  output.rows = 24;
  output.write = () => {};
  const app = new TerminalApp(s, { input, output });
  app.key("u", { name: "u" });
  assert.match(s.menu.title, /REGISTER ACCESS/);
  app.key("j", { name: "j" });
  app.key("j", { name: "j" });
  app.key("\r", { name: "return" });
  app.key("j", { name: "j" });
  app.key("\r", { name: "return" });
  for (const text of "0o245") app.key(text, { name: text });
  app.key("\r", { name: "return" });
  assert.equal(s.tick, 1);
  assert.equal(s.snapshot.registers.output0, 165);
  assert.equal(s.trace[2].registers.output0, 179);
  s.seek(24);
  s.accessRegister("read", 2);
  assert.equal(s.tick, 25);
  assert.equal(s.config.duration, 25);
  const previous = structuredClone(s.config),
    trace = s.trace,
    cursor = s.tick;
  assert.throws(() => s.accessRegister("write", 255, 0), /not accepted/);
  assert.throws(() => s.accessRegister("write", 2, 256), /input value/);
  assert.deepEqual(s.config, previous);
  assert.equal(s.trace, trace);
  assert.equal(s.tick, cursor);
  s.seek(19);
  assert.throws(() => s.accessRegister("write", 2, 0), /not accepted/);
  assert.equal(s.trace, trace);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ])
    for (const view of ["wave", "inspect", "registers", "log", "model"]) {
      s.columns = columns;
      s.rows = rows;
      s.setView(view);
      const frame = render(s);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
    }
  s.setView("registers");
  s.registerFilter = "Configuration 0";
  assert.equal(s.registers()[0].id, "reg.configuration0");
  assert.match(screenText(s), /0x06 Configuration 0/);
  const session = s.session(),
    restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(session);
  assert.deepEqual(restored.config.inputs, s.config.inputs);
  assert.equal(restored.trace[1].registers.output0, 165);
  const vcd = exportVCD(s.model, s.trace, s.config.parameters);
  assert.match(vcd, /int_driver/);
  assert.match(vcd, /\nbz /);
});
