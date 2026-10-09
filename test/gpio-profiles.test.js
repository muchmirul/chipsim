import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import {
  compileDocument,
  profileForDocument,
} from "../src/model/profiles/index.js";
import { gpioRegisterCore } from "../src/model/registers/gpio-expander.js";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { simulateModel } from "../src/model/engine.js";
import { validateModel } from "../src/model/validate.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, displayWidth } from "../src/tui/render.js";
import { exportVCD } from "../src/trace/export.js";

const path = new URL("../docs/references/tca9534/ti-tca9534.pdf", import.meta.url)
  .pathname;
const documentPromise = extractPDFFile(path);
const modelPromise = documentPromise.then(
  (document) => compileDocument(document).spec,
);
const event = (tick, signal, value) => ({ tick, signal, value });
const access = (tick, address, write, value, request) => [
  event(tick, "address", address),
  event(tick, "write", write),
  event(tick, "write_data", value),
  event(tick, "request", request),
];

test("TCA9534 exact vendor PDF compiles with checked quotes and independent acceptance cases", async () => {
  const document = await documentPromise,
    compiled = compileDocument(document);
  assert.equal(profileForDocument(document).id, "tca9534");
  assert.deepEqual(validateModel(compiled.spec, [document]).warnings, []);
  assert.equal(compiled.checks.length, 16);
  assert.ok(compiled.checks.every((check) => check.passed));
  assert.deepEqual(
    compiled.spec.registerMap.map(({ address, access }) => [address, access]),
    [
      [0, "ro"],
      [1, "rw"],
      [2, "rw"],
      [3, "rw"],
    ],
  );
  assert.equal(compileDocument({ ...document, sha256: "f".repeat(64) }), null);
  assert.throws(
    () => compileDocument({ ...document, pages: [] }),
    /quote does not occur/,
  );
  assert.match(compiled.spec.scope, /persistent command pointer/);
  assert.match(
    compiled.spec.assumptions.join(" "),
    /not a specified numeric Input Port reset/,
  );
});

test("single-port GPIO covers all latch bytes with independently computed direction and inversion", async () => {
  const spec = await modelPromise;
  for (let byte = 0; byte < 256; byte++)
    for (const direction of [0, 85, 170, 255]) {
      const external = (byte * 23 + 97) % 256,
        polarity = 255 - byte;
      const trace = simulateModel(
        spec,
        {},
        {
          ticks: 5,
          inputs: [
            event(0, "external0", external),
            ...access(1, 1, 1, byte, 1),
            ...access(2, 3, 1, direction, 0),
            ...access(3, 2, 1, polarity, 1),
            ...access(4, 0, 0, 0, 0),
            ...access(5, 1, 0, 0, 1),
          ],
        },
      );
      let expected = 0;
      for (let bit = 0; bit < 8; bit++) {
        const input = (direction >> bit) & 1;
        const level = input
          ? ((external >> bit) & 1) ^ ((polarity >> bit) & 1)
          : (byte >> bit) & 1;
        expected += level * 2 ** bit;
        assert.equal(
          trace[4].signals[`p0${bit}_driver`],
          input ? "Z" : (byte >> bit) & 1,
        );
      }
      assert.equal(trace[4].signals.read_data, expected);
      assert.equal(trace[5].signals.read_data, byte);
      assert.equal(trace[5].signals.int_driver, "Z");
      assert.equal(trace[5].registers.output1, undefined);
    }
});

test("TCA9534 mixed-operation oracle verifies every tick including held requests, unmapped bytes and reset", async () => {
  const spec = await modelPromise;
  let seed = 9534,
    token = 0;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 16) % max;
  };
  const inputs = [];
  for (let tick = 1; tick <= 1000; tick++) {
    if (tick % 13 === 0 || random(3)) token ^= 1;
    inputs.push(
      ...access(tick, random(8), random(2), random(256), token),
      event(tick, "external0", random(256)),
      event(tick, "power_reset", tick % 17 === 0 ? 1 : 0),
    );
  }
  let output = 255,
    inversion = 0,
    direction = 255,
    sampled = 255,
    previous = 0,
    read = 0;
  for (const snapshot of simulateModel(spec, {}, { ticks: 1000, inputs })) {
    const s = snapshot.signals;
    const accepted =
      snapshot.tick > 0 && !s.power_reset && s.request !== previous;
    const mapped = s.address < 4;
    if (snapshot.tick > 0 && s.power_reset) {
      output = 255;
      inversion = 0;
      direction = 255;
    } else if (accepted && s.write) {
      if (s.address === 1) output = s.write_data;
      if (s.address === 2) inversion = s.write_data;
      if (s.address === 3) direction = s.write_data;
    }
    let pins = 0,
      observed = 0;
    for (let bit = 0; bit < 8; bit++) {
      const input = (direction >> bit) & 1;
      const physical = ((input ? s.external0 : output) >> bit) & 1;
      pins += physical * 2 ** bit;
      observed += (physical ^ (input ? (inversion >> bit) & 1 : 0)) * 2 ** bit;
      assert.equal(s[`p0${bit}_driver`], input ? "Z" : physical);
    }
    if (
      snapshot.tick === 0 ||
      s.power_reset ||
      (accepted && !s.write && s.address === 0)
    )
      sampled = pins;
    let pending = false;
    for (let bit = 0; bit < 8; bit++)
      if (
        (direction >> bit) & 1 &&
        ((sampled >> bit) & 1) !== ((pins >> bit) & 1)
      )
        pending = true;
    if (s.power_reset) read = 0;
    else if (accepted && !s.write && mapped)
      read = [observed, output, inversion, direction][s.address];
    assert.equal(s.input0, observed);
    assert.equal(s.read_data, read);
    assert.equal(s.valid, Number(accepted));
    assert.equal(s.error, Number(accepted && !mapped));
    assert.equal(s.interrupt_pending, Number(pending));
    assert.equal(s.int_driver, pending ? 0 : "Z");
    assert.equal(snapshot.registers.sampled0, sampled);
    assert.equal(snapshot.registers.output0, output);
    assert.equal(snapshot.registers.polarity0, inversion);
    assert.equal(snapshot.registers.configuration0, direction);
    previous = s.request;
  }
});

test("reviewed GPIO core requires explicit complete addresses, names and writable defaults", () => {
  const options = {
    addresses: { input: [0], output: [1], polarity: [2], configuration: [3] },
    names: {
      input: ["Input"],
      output: ["Output"],
      polarity: ["Polarity"],
      configuration: ["Direction"],
    },
    defaults: { output: [255], polarity: [0], configuration: [255] },
  };
  for (const corrupt of [
    (o) => delete o.addresses.polarity,
    (o) => (o.addresses.input = []),
    (o) => (o.addresses.output = [0]),
    (o) => (o.addresses.configuration = [256]),
    (o) => (o.addresses.configuration = ["3"]),
    (o) => (o.names.input = [""]),
    (o) => (o.names.input = ["a".repeat(161)]),
    (o) => delete o.defaults,
    (o) => (o.defaults.output = [-1]),
    (o) => (o.defaults.configuration = [false]),
    (o) => (o.defaults.polarity = []),
  ]) {
    const o = structuredClone(options);
    corrupt(o);
    assert.throws(() => gpioRegisterCore(o), /GPIO/);
  }
  const relocated = structuredClone(options);
  relocated.addresses = {
    input: [16],
    output: [32],
    polarity: [48],
    configuration: [64],
  };
  relocated.defaults = { output: [0], polarity: [170], configuration: [85] };
  const core = gpioRegisterCore(relocated);
  assert.deepEqual(
    core.map.map(({ address }) => address),
    [16, 32, 48, 64],
  );
  assert.deepEqual(
    core.registers.slice(0, 3).map(({ initial }) => initial),
    [0, 170, 85],
  );
});

test("TCA9534 PDF-only TUI access accepts octal and preserves sessions, authored edits and released drivers", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-tca9534-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const s = new TuiState({ workspace });
  await s.initialize();
  await s.loadFile(path);
  assert.equal(s.modelId, "tca9534");
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = input.pause = () => {};
  output.write = () => {};
  output.columns = 80;
  output.rows = 24;
  const app = new TerminalApp(s, { input, output });
  for (const key of ["u", "j", "\r", "j", "\r", ..."0o245", "\r"])
    app.key(key, { name: key === "\r" ? "return" : key });
  assert.equal(s.tick, 1);
  assert.equal(s.snapshot.registers.output0, 165);
  s.accessRegister("write", 3, 0);
  assert.equal(s.snapshot.signals.p01_driver, 0);
  s.accessRegister("read", 1);
  assert.equal(s.snapshot.signals.read_data, 165); // explicit tick-2 access replaces that demonstration transaction
  s.seek(8);
  assert.equal(s.snapshot.signals.int_driver, 0);
  s.accessRegister("read", 1);
  assert.equal(s.snapshot.signals.int_driver, 0);
  s.accessRegister("read", 0);
  assert.equal(s.snapshot.signals.int_driver, "Z");
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
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(s.session());
  assert.deepEqual(restored.config.inputs, s.config.inputs);
  assert.equal(restored.trace[1].registers.output0, 165);
  assert.match(exportVCD(s.model, s.trace, s.config.parameters), /\nbz /);
  const authored = JSON.parse(
    await readFile(join(workspace, "models/tca9534.json"), "utf8"),
  );
  authored.name = "Reviewed local TCA9534 experiment";
  await restored.installModel(authored);
  await restored.loadFile(path);
  assert.equal(restored.model.name, authored.name);
});
