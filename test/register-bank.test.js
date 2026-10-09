import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { readRegisterRows } from "../src/model/register-bank/read.js";
import { buildRegisterBank } from "../src/model/register-bank/build.js";
import { simulateModel } from "../src/model/engine.js";
import { validateModel } from "../src/model/validate.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { textRows } from "../src/tui/authoring.js";
import { render, displayWidth } from "../src/tui/render.js";
import { exportJSON, exportCSV, exportVCD } from "../src/trace/export.js";
import { extractPDFFile } from "../src/documents/extract-node.js";
const excerpt = "Explicit register storage and access rules for this test.";
const document = {
  sha256: "a".repeat(64),
  filename: "register-test.pdf",
  pages: [{ number: 1, text: excerpt }],
};
const settings = {
  name: "Entered register test",
  width: 8,
  hardwarePriority: "before",
  page: 1,
  quote: excerpt,
  claim: "Test fixture; behavior entered by developer.",
};
const modes = ["rw", "ro", "w1c", "w1s", "rc"];
const event = (tick, signal, value) => ({ tick, signal, value });
const access = (tick, address, write, value, request) => [
  event(tick, "address", address),
  event(tick, "write", write),
  event(tick, "write_data", value),
  event(tick, "request", request),
];
const build = (options = {}) =>
  buildRegisterBank(document, {
    ...settings,
    rows: "CONTROL 0 rw 0 255",
    ...options,
  }).spec;
const actualPath = new URL(
  "../docs/references/rp2040/rp2040-datasheet.pdf",
  import.meta.url,
).pathname;
const actualPromise = extractPDFFile(actualPath);
const scratchOptions = async () => ({
  ...settings,
  name: "RP2040 scratch storage experiment",
  width: 32,
  rows: await readFile(
    new URL(
      "../examples/rp2040-watchdog-scratch.registers.txt",
      import.meta.url,
    ),
    "utf8",
  ),
  page: 549,
  quote: "Information persists through soft reset of the chip.",
  claim:
    "Table 549 defines eight 32-bit RW scratch words and zero reset values. The model selects their relative offsets and word storage only.",
  assumptions:
    "No watchdog counter, soft reset domains, bus aliases, bootrom checks or physical bus are modeled. Synthetic hardware-set inputs are testing injections, not documented scratch-register pins.",
});

test("register rows require explicit bounded unique names, addresses, modes, reset values and masks", () => {
  assert.deepEqual(
    readRegisterRows("Control 0x10 rw 0b1010 0o17; Status 20 ro 0 0", 8),
    [
      { name: "Control", address: 16, mode: "rw", reset: 10, mask: 15 },
      { name: "Status", address: 20, mode: "ro", reset: 0, mask: 0 },
    ],
  );
  for (const rows of [
    "",
    "A 0 rw 0",
    "A 0 rw 0 1 extra",
    "A 0 auto 0 1",
    "A 0 ro 0 1",
    "A 0 rw -1 1",
    "A 0 rw 0 256",
    "A 0x100000000 rw 0 1",
    "A 1e2 rw 0 1",
    "1A 0 rw 0 1",
    "A 0 rw 0 1; a 1 rw 0 1",
    "A 0 rw 0 1; B 0 rw 0 1",
    "A 0 rw Z 0",
    "// inferred default",
    Array.from({ length: 17 }, (_, i) => `A${i} ${i} rw 0 1`).join("\n"),
  ])
    assert.throws(() => readRegisterRows(rows, 8));
  for (const width of [0, 33, 1.5, "8"])
    assert.throws(() => readRegisterRows("A 0 rw 0 0", width));
  assert.throws(() => readRegisterRows("A".repeat(65537), 8), /64 KiB/);
  assert.throws(
    () => build({ hardwarePriority: "inferred" }),
    /before or after/,
  );
  assert.throws(
    () => build({ quote: "Unrelated invented register description" }),
    /quote does not occur/,
  );
});

test("all write bytes follow mask/mode semantics with protected bits and no cross-address writes", () => {
  for (const mask of [0, 85, 255])
    for (const priority of ["before", "after"]) {
      const spec = build({
        hardwarePriority: priority,
        rows: modes
          .map(
            (mode, i) =>
              `R${i} ${i * 4} ${mode} 211 ${mode === "ro" ? 0 : mask}`,
          )
          .join(";"),
      });
      for (let byte = 0; byte < 256; byte++) {
        const inputs = modes.flatMap((_, i) =>
          access(i + 1, i * 4, 1, byte, (i + 1) % 2),
        );
        const trace = simulateModel(spec, {}, { ticks: 5, inputs });
        for (let i = 0; i < modes.length; i++) {
          let expected = 0;
          for (let bit = 0; bit < 8; bit++) {
            let value = (211 >> bit) & 1;
            if ((mask >> bit) & 1) {
              if (modes[i] === "rw") value = (byte >> bit) & 1;
              if (modes[i] === "w1c" && (byte >> bit) & 1) value = 0;
              if (modes[i] === "w1s" && (byte >> bit) & 1) value = 1;
            }
            expected += value * 2 ** bit;
          }
          assert.equal(trace[i + 1].registers["value_R" + i], expected);
          for (let other = i + 1; other < modes.length; other++)
            assert.equal(trace[i + 1].registers["value_R" + other], 211);
        }
      }
    }
});

test("mixed 32-bit operations independently verify event priority, masks, read-before-clear, errors and resets", () => {
  const rows = modes.map((mode, i) => ({
    name: "R" + i,
    address: i * 4,
    mode,
    reset: 0x40000001,
    mask: mode === "ro" ? 0 : 0x80000003,
  }));
  for (const priority of ["before", "after"]) {
    const spec = build({
      width: 32,
      hardwarePriority: priority,
      rows: rows
        .map((r) => `${r.name} ${r.address} ${r.mode} ${r.reset} ${r.mask}`)
        .join(";"),
    });
    let seed = 78419,
      request = 0;
    const random = (max) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 2 ** 32) * max);
    };
    const inputs = [];
    for (let tick = 1; tick <= 1000; tick++) {
      if (random(3)) request ^= 1;
      inputs.push(
        ...access(tick, random(8) * 4, random(2), random(2 ** 32), request),
        event(tick, "reset", tick % 29 === 0 ? 1 : 0),
        ...rows.map((r) =>
          event(tick, "set_" + r.name, tick % 5 === 0 ? random(2 ** 32) : 0),
        ),
      );
    }
    const storage = rows.map((r) => BigInt(r.reset));
    let read = 0n,
      previous = 0;
    for (const snapshot of simulateModel(spec, {}, { ticks: 1000, inputs })) {
      const s = snapshot.signals;
      const valid = snapshot.tick > 0 && !s.reset && s.request !== previous;
      const selected = rows.findIndex((r) => r.address === s.address);
      if (snapshot.tick > 0) {
        if (s.reset) {
          rows.forEach((r, i) => (storage[i] = BigInt(r.reset)));
          read = 0n;
        } else {
          if (priority === "before")
            rows.forEach((r, i) => (storage[i] |= BigInt(s["set_" + r.name])));
          if (valid && selected !== -1) {
            const r = rows[selected],
              mask = BigInt(r.mask),
              data = BigInt(s.write_data) & mask;
            if (!s.write) {
              read = storage[selected];
              if (r.mode === "rc") storage[selected] &= ~mask;
            } else if (r.mode === "rw")
              storage[selected] = (storage[selected] & ~mask) | data;
            else if (r.mode === "w1c") storage[selected] &= ~data;
            else if (r.mode === "w1s") storage[selected] |= data;
          }
          if (priority === "after")
            rows.forEach((r, i) => (storage[i] |= BigInt(s["set_" + r.name])));
        }
      }
      assert.equal(s.valid, Number(valid));
      assert.equal(s.error, Number(valid && selected === -1));
      assert.equal(s.read_data, Number(read));
      rows.forEach((r, i) =>
        assert.equal(snapshot.registers["value_" + r.name], Number(storage[i])),
      );
      previous = s.request;
    }
  }
});

test("word-width extremes and full register bound remain valid within model/check limits", () => {
  for (const width of [1, 8, 16, 32])
    for (const hardwarePriority of ["before", "after"]) {
      const max = 2 ** width - 1;
      const spec = build({
        width,
        hardwarePriority,
        rows: Array.from(
          { length: 16 },
          (_, i) =>
            `R${i} ${i === 15 ? 0xffffffff : i * 4} ${modes[i % 5]} ${max} ${modes[i % 5] === "ro" ? 0 : max}`,
        ).join(";"),
      });
      assert.deepEqual(validateModel(spec, [document]).warnings, []);
      assert.equal(spec.registerMap.length, 16);
      assert.equal(spec.signals[0].width, 32);
      assert.equal(spec.checks.length, 52);
    }
});

test("real RP2040 table supplies explicit scratch words, which retain independent 32-bit writes", async () => {
  const d = await actualPromise,
    { spec, checks } = buildRegisterBank(d, await scratchOptions());
  assert.ok(checks.every((c) => c.passed));
  assert.deepEqual(validateModel(spec, [d]).warnings, []);
  assert.deepEqual(
    spec.registerMap.map((r) => r.address),
    [12, 16, 20, 24, 28, 32, 36, 40],
  );
  const inputs = Array.from({ length: 8 }, (_, i) =>
    access(i + 1, 12 + i * 4, 1, 0xffffffff - i, (i + 1) % 2),
  ).flat();
  inputs.push(
    ...Array.from({ length: 8 }, (_, i) =>
      access(i + 9, 12 + i * 4, 0, 0, (i + 9) % 2),
    ).flat(),
  );
  const trace = simulateModel(spec, {}, { ticks: 16, inputs });
  for (let i = 0; i < 8; i++) {
    assert.equal(trace[8].registers["value_SCRATCH" + i], 0xffffffff - i);
    assert.equal(trace[i + 9].signals.read_data, 0xffffffff - i);
  }
});

test("register bank TUI retries invalid rows/quotes and preserves sessions, high-bit exports and terminal size", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-register-bank-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const s = new TuiState({ workspace });
  await s.initialize();
  await s.loadFile(actualPath);
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = input.pause = () => {};
  output.write = () => {};
  output.columns = 80;
  output.rows = 24;
  const app = new TerminalApp(s, { input, output });
  app.key("c");
  for (let i = 0; i < 4; i++) app.key("j");
  app.key("\r", { name: "return" });
  const submit = async (text) => {
    app.key("", { name: "u", ctrl: true });
    for (const c of text || "") app.key(c, { name: c });
    app.key("\r", { name: "return" });
    for (let i = 0; i < 300 && s.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(s.busy, false);
  };
  await submit("Scratch experiment");
  await submit("32");
  await submit("BAD 0 rw 0");
  assert.match(s.prompt.error, /NAME ADDRESS MODE RESET MASK/);
  assert.equal(s.modelId, "pio");
  const rowPath = new URL(
    "../examples/rp2040-watchdog-scratch.registers.txt",
    import.meta.url,
  ).pathname;
  await submit("@" + rowPath);
  await submit("after");
  await submit("549");
  await submit("Unrelated fabricated text");
  assert.match(s.prompt.error, /Quote must occur/);
  await submit((await scratchOptions()).quote);
  await submit((await scratchOptions()).claim);
  await submit();
  assert.equal(s.modelId, "scratch-experiment");
  assert.equal(s.view, "wave");
  assert.equal(s.model.spec.registerMap.length, 8);
  s.setInputs([]);
  s.accessRegister("write", 12, 0xdeadbeef);
  s.accessRegister("read", 12);
  assert.equal(s.snapshot.signals.read_data, 0xdeadbeef);
  const config = structuredClone(s.config),
    trace = s.trace;
  assert.throws(() => s.accessRegister("write", 11, 1), /not accepted/);
  assert.deepEqual(s.config, config);
  assert.equal(s.trace, trace);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ])
    for (const view of [
      "wave",
      "inspect",
      "log",
      "registers",
      "model",
      "stimulus",
    ]) {
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
  assert.deepEqual(restored.trace, trace);
  const exported = JSON.parse(
    exportJSON(s.model, trace, s.config.parameters, s.config.inputs),
  );
  assert.equal(exported.trace[2].signals.read_data, 0xdeadbeef);
  assert.match(exportCSV(s.model, trace), /3735928559/);
  assert.match(exportVCD(s.model, trace), /11011110101011011011111011101111/);
  const big = join(workspace, "oversize.txt");
  await writeFile(big, "a".repeat(65537));
  await assert.rejects(textRows("@" + big, "Registers"), /64 KiB/);
  await assert.rejects(
    textRows("@" + workspace, "Registers"),
    /regular text file/,
  );
  app.key("c");
  for (let i = 0; i < 4; i++) app.key("j");
  app.key("\r", { name: "return" });
  app.key("", { name: "escape" });
  assert.equal(s.modelId, "scratch-experiment");
  assert.equal(s.prompt, null);
});
