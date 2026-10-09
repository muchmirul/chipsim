import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { extractPDFFile } from "../src/documents/extract-node.js";
import {
  compileDocument,
  compileDocumentProfiles,
} from "../src/model/profiles/index.js";
import { simulateModel } from "../src/model/engine.js";
import { validateModel } from "../src/model/validate.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { screenText, render, displayWidth } from "../src/tui/render.js";
import { exportJSON, exportCSV, exportVCD } from "../src/trace/export.js";
const root = new URL("../", import.meta.url).pathname;
const path = join(root, "docs/references/esp32-c6/espressif-esp32-c6-trm.pdf");
const documentPromise = extractPDFFile(path);
const modelPromise = documentPromise.then(
  (document) => compileDocument(document, { profileId: "esp32c6-gpio" }).spec,
);
const event = (tick, signal, value) => ({ tick, signal, value });
const enter = (app) => app.key("\r", { name: "return" });

test("one pinned ESP32-C6 PDF compiles two distinct reviewed peripherals and checks actual GPIO pages", async (t) => {
  const document = await documentPromise;
  assert.throws(() => compileDocument(document), /choose profileId/);
  const results = compileDocumentProfiles(document);
  assert.deepEqual(
    results.map((r) => r.spec.id),
    ["esp32c6-pcnt", "esp32c6-gpio"],
  );
  assert.ok(
    results.every(
      (r) => r.checks.length === 16 && r.checks.every((c) => c.passed),
    ),
  );
  const spec = await modelPromise;
  assert.deepEqual(
    spec.registerMap.map(({ address, access }) => [address, access]),
    [
      [4, "rw"],
      [8, "wo"],
      [12, "wo"],
      [32, "rw"],
      [36, "wo"],
      [40, "wo"],
    ],
  );
  const changed = structuredClone(document);
  changed.pages.find((p) => p.number === 271).text = "Unrelated page";
  assert.throws(
    () => compileDocument(changed, { profileId: spec.id }),
    /quote does not occur/,
  );
  assert.equal(
    compileDocument(
      { ...document, sha256: "f".repeat(64) },
      { profileId: spec.id },
    ),
    null,
  );
  for (const mutate of [
    (s) => {
      s.registerMap[1].value = "reg.gpio_out";
    },
    (s) => {
      s.registerMap[1].access = "rw";
    },
    (s) => {
      s.registerMap[0].access = "invalid";
    },
  ]) {
    const bad = structuredClone(spec);
    mutate(bad);
    assert.throws(() => validateModel(bad), /registerMap/);
  }
  const folder = await mkdtemp(join(tmpdir(), "chipsim-c6-select-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const out = join(folder, "gpio.json");
  execFileSync(
    process.execPath,
    ["scripts/document.mjs", path, "--model", spec.id, "--out", out],
    { cwd: root },
  );
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), spec);
});

test("GPIO atomic masks, every logical bit, reset and rejected accesses match an independent BigInt oracle", async () => {
  const spec = await modelPromise;
  let seed = 0x6410a;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const levels = [],
    inputs = [],
    addresses = [4, 8, 12, 32, 36, 40, 60, 5];
  let token = 1;
  for (let tick = 0; tick <= 350; tick++) {
    if (tick % 7 !== 0) token ^= 1;
    const bus = {
      request: token,
      address: addresses[Math.floor(tick / 2) % addresses.length],
      write: tick % 4 < 2 ? 1 : 0,
      write_data: random(),
      reset: Number(tick % 43 === 0 || tick % 43 === 1),
    };
    levels.push(bus);
    for (const [signal, value] of Object.entries(bus))
      inputs.push(event(tick, signal, value));
  }
  // Explicit single-bit transactions make every bit, zero masks and bit 31
  // unavoidable coverage, in addition to mixed deterministic words above.
  for (let bit = 0; bit < 32; bit++)
    for (const address of [8, 36, 12, 40]) {
      const tick = levels.length;
      token ^= 1;
      const bus = {
        request: token,
        address,
        write: 1,
        write_data: 2 ** bit,
        reset: 0,
      };
      levels.push(bus);
      for (const [signal, value] of Object.entries(bus))
        inputs.push(event(tick, signal, value));
    }
  for (let watch = 0; watch < 31; watch++) {
    const trace = simulateModel(
      spec,
      { watch_gpio: watch },
      { inputs, ticks: levels.length - 1 },
    );
    let out = 0n,
      enable = 0n,
      read = 0,
      previous = levels[0].request;
    for (const [tick, bus] of levels.entries()) {
      const valid = Number(!bus.reset && tick > 0 && bus.request !== previous);
      const supported = bus.write
        ? [4, 8, 12, 32, 36, 40].includes(bus.address)
        : [4, 32].includes(bus.address);
      const error = Number(valid && !supported);
      if (bus.reset) {
        out = 0n;
        enable = 0n;
        read = 0;
      } else if (valid && !error) {
        const word = BigInt(bus.write_data) & 0x7fffffffn;
        if (!bus.write) read = Number(bus.address === 4 ? out : enable);
        else
          switch (bus.address) {
            case 4:
              out = word;
              break;
            case 8:
              out |= word;
              break;
            case 12:
              out &= ~word;
              break;
            case 32:
              enable = word;
              break;
            case 36:
              enable |= word;
              break;
            case 40:
              enable &= ~word;
              break;
          }
      }
      const snapshot = trace[tick],
        mask = 1n << BigInt(watch);
      assert.notEqual(snapshot.phase, "fault");
      assert.equal(snapshot.registers.gpio_out, Number(out));
      assert.equal(snapshot.registers.gpio_enable, Number(enable));
      assert.equal(snapshot.signals.output_latch, Number(out));
      assert.equal(snapshot.signals.enable_mask, Number(enable));
      assert.equal(
        snapshot.signals.selected_driver,
        enable & mask ? Number(Boolean(out & mask)) : "Z",
      );
      assert.equal(snapshot.signals.read_data, read);
      assert.equal(snapshot.signals.valid, valid);
      assert.equal(snapshot.signals.error, error);
      assert.equal(snapshot.registers.previous_request, bus.request);
      previous = bus.request;
    }
  }
  for (const value of [-1, 31, 1.5])
    assert.throws(
      () => simulateModel(spec, { watch_gpio: value }),
      /must be an integer/,
    );
});

test("terminal selects GPIO from the same manual, handles write actions honestly, and preserves numeric experiments", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-c6-gpio-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const s = new TuiState({ workspace });
  await s.initialize();
  await s.loadFile(path);
  assert.equal(s.modelId, "esp32c6-pcnt");
  s.setParameter("positive_mode", 2);
  s.seek(13);
  const pcntInputs = structuredClone(s.config.inputs);
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = input.resume = input.pause = () => {};
  output.columns = 80;
  output.rows = 24;
  output.write = () => {};
  const app = new TerminalApp(s, { input, output });
  app.key("o");
  assert.equal(s.menu.items[1].value.id, "esp32c6-gpio");
  app.key("j");
  enter(app);
  assert.equal(s.modelId, "esp32c6-gpio");
  assert.deepEqual(
    [0, 4, 10, 12].map((tick) => s.trace[tick].signals.selected_driver),
    ["Z", 1, 0, "Z"],
  );
  assert.equal(s.trace[14].signals.read_data, 432);
  assert.equal(s.trace[16].signals.read_data, 270);
  s.seek(0);
  app.key("u");
  app.key("j");
  assert.match(s.menu.items[1].label, /wo · write action/);
  assert.doesNotMatch(s.menu.items[1].label, /=/);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    s.columns = columns;
    s.rows = rows;
    assert.match(screenText(s), /GPIO_OUT_W1TS_REG/);
    assert.ok(render(s).every((line) => displayWidth(line.text) <= columns));
  }
  enter(app);
  assert.deepEqual(
    s.menu.items.map((item) => item.value),
    ["write"],
  );
  enter(app);
  for (const c of "0b1000000000000000000000000000001") app.key(c);
  enter(app);
  assert.equal(s.snapshot.registers.gpio_out, 0x40000001);
  assert.equal(
    s.trace[2].registers.gpio_out,
    179,
    "future scheduled full write retained",
  );
  for (const format of ["decimal", "binary", "octal", "hex"]) {
    s.format = format;
    assert.equal(s.snapshot.registers.gpio_out, 0x40000001);
  }
  s.seek(24);
  const before = structuredClone(s.session()),
    trace = s.trace;
  assert.throws(() => s.accessRegister("read", 8), /not accepted/);
  assert.deepEqual(s.session(), before);
  assert.equal(s.trace, trace);
  s.accessRegister("write", 4, 0xffffffff);
  s.accessRegister("read", 4);
  assert.equal(s.snapshot.signals.read_data, 0x7fffffff);
  s.setParameter("watch_gpio", 30);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ])
    for (const view of [
      "wave",
      "inspect",
      "registers",
      "log",
      "model",
      "sources",
    ]) {
      s.columns = columns;
      s.rows = rows;
      s.setView(view);
      assert.equal(render(s).length, rows);
      assert.ok(render(s).every((line) => displayWidth(line.text) <= columns));
    }
  const json = JSON.parse(
    exportJSON(s.model, s.trace, s.config.parameters, s.config.inputs),
  );
  assert.equal(json.trace[0].signals.selected_driver, "Z");
  assert.match(exportCSV(s.model, s.trace), /selected_driver/);
  assert.match(exportVCD(s.model, s.trace), /\nbz /);
  const session = s.session(),
    restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(session);
  assert.deepEqual(restored.trace, s.trace);
  app.key("o");
  enter(app);
  assert.equal(s.modelId, "esp32c6-pcnt");
  assert.equal(s.config.parameters.positive_mode, 2);
  assert.deepEqual(s.config.inputs, pcntInputs);
});
