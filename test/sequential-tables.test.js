import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { extractPDFFile } from "../src/documents/extract-node.js";
import { analyzeDocument } from "../src/model/from-document.js";
import { readTableLayouts } from "../src/model/tables/layout.js";
import { readSequentialTable } from "../src/model/tables/sequential-read.js";
import { simulateModel } from "../src/model/engine.js";
import { validateModel, ModelError } from "../src/model/validate.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";
const path = (part) =>
  new URL(`../docs/references/nexperia-74hc${part}.pdf`, import.meta.url)
    .pathname;
const documents = Promise.all(
  ["377", "273"].map((part) => extractPDFFile(path(part))),
);
const compiled = documents.then((docs) =>
  docs.map((doc) => analyzeDocument(doc).models[0].spec),
);
const event = (tick, signal, value) => ({
  tick,
  signal: "pin_" + signal.toLowerCase(),
  value,
});
const data = (tick, value) =>
  Array.from({ length: 8 }, (_, bit) =>
    event(tick, "D" + bit, (value >> bit) & 1),
  );
const word = (snapshot) =>
  Array.from(
    { length: 8 },
    (_, bit) => snapshot.signals["pin_q" + bit] << bit,
  ).reduce((a, b) => a | b, 0);
test("two real sequential PDFs derive eight channels, clock history, and configurable retained state without fingerprints", async () => {
  const docs = await documents;
  for (const doc of docs) {
    const result = analyzeDocument(doc);
    assert.equal(result.models.length, 1);
    assert.deepEqual(result.diagnostics, []);
    const { spec, checks, method } = result.models[0];
    assert.equal(method, "sequential function table");
    assert.ok(checks.every((check) => check.passed));
    assert.equal(spec.sourceTable.compiler, "sequential-function-table-v1");
    assert.equal(spec.sourceTable.instances.length, 8);
    assert.equal(spec.signals.length, 18);
    assert.equal(spec.checks.length, 32);
    assert.equal(spec.registers.length, 2);
    const unknown = {
      ...doc,
      sha256: "b".repeat(64),
      filename: "unknown.pdf",
      title: "Unfamiliar vendor",
    };
    assert.equal(analyzeDocument(unknown).models[0].spec.checks.length, 32);
  }
});
test("independent byte oracle covers both clock histories, control levels, held states, and all 256 data words", async () => {
  const specs = await compiled;
  for (let kind = 0; kind < 2; kind++)
    for (const initial of [0x55, 0xaa])
      for (let previous = 0; previous < 2; previous++)
        for (let clock = 0; clock < 2; clock++)
          for (let control = 0; control < 2; control++)
            for (let payload = 0; payload < 256; payload++) {
              const inputs = [
                event(0, "CP", previous),
                event(0, kind ? "MR" : "E", 1),
                ...data(0, 0),
                event(1, "CP", clock),
                event(1, kind ? "MR" : "E", control),
                ...data(1, payload),
              ];
              const trace = simulateModel(
                specs[kind],
                { initialOutputs: initial },
                { inputs, ticks: 1 },
              );
              const rising = previous === 0 && clock === 1;
              const expected = kind
                ? control === 0
                  ? 0
                  : rising
                    ? payload
                    : initial
                : control === 0 && rising
                  ? payload
                  : initial;
              assert.equal(
                word(trace[0]),
                initial,
                "tick zero must not invent an edge",
              );
              assert.equal(
                word(trace[1]),
                expected,
                `kind ${kind}, old ${previous}, clock ${clock}, control ${control}, byte ${payload}`,
              );
              assert.equal(trace[1].phase, "running");
            }
});
test("state persists across disabled clocks, static-high data changes, falling edges, and control release", async () => {
  const [enable, reset] = await compiled;
  const inputs = [
    event(0, "CP", 1),
    event(0, "E", 1),
    ...data(0, 0x11),
    event(1, "E", 0),
    ...data(2, 0x33),
    event(3, "CP", 0),
    event(4, "CP", 1),
    ...data(5, 0xff),
    event(6, "E", 1),
    event(6, "CP", 0),
    event(7, "CP", 1),
    event(8, "E", 0),
    event(9, "CP", 0),
    event(10, "CP", 1),
  ];
  const trace = simulateModel(
    enable,
    { initialOutputs: 0xb3 },
    { inputs, ticks: 11 },
  );
  assert.deepEqual(
    trace.map(word),
    [0xb3, 0xb3, 0xb3, 0xb3, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0xff, 0xff],
  );
  assert.match(trace[4].message, /Source table row/);
  assert.match(trace[7].message, /no change/);
  const resetTrace = simulateModel(
    reset,
    { initialOutputs: 0xb3 },
    {
      inputs: [
        event(0, "CP", 1),
        event(0, "MR", 0),
        ...data(0, 0xff),
        event(1, "MR", 1),
        event(2, "CP", 0),
        event(3, "CP", 1),
        event(4, "MR", 0),
        event(5, "MR", 1),
        event(5, "CP", 0),
        ...data(5, 0xb3),
        event(6, "CP", 1),
      ],
      ticks: 7,
    },
  );
  assert.deepEqual(resetTrace.map(word), [0, 0, 0, 0xff, 0, 0, 0xb3, 0xb3]);
});
test("changing published edge/output symbols changes executable behavior rather than selecting a chip implementation", async () => {
  const doc = structuredClone((await documents)[0]);
  doc.sha256 = "c".repeat(64);
  const rows = doc.pages[2].layoutLines.filter((line) =>
    line.cells.some((cell) => cell.text === '"1"' || cell.text === '"0"'),
  );
  for (const row of rows)
    row.cells.at(-1).text = row.cells.at(-1).text === "H" ? "L" : "H";
  const spec = analyzeDocument(doc).models[0].spec;
  const trace = simulateModel(
    spec,
    {},
    {
      inputs: [
        event(0, "E", 0),
        event(0, "CP", 0),
        ...data(0, 0xb3),
        event(1, "CP", 1),
      ],
      ticks: 1,
    },
  );
  assert.equal(word(trace[1]), 0x4c);
  // Change the documented arrow and its pin/legend definition together.
  // The resulting model must sample falling edges, rather than retaining a
  // chip-name-specific rising-edge implementation.
  for (const page of doc.pages) {
    page.text = page.text
      .replaceAll("LOW-to-HIGH", "HIGH-to-LOW")
      .replaceAll("positive", "negative");
    for (const line of page.layoutLines || [])
      for (const cell of line.cells)
        cell.text = cell.text
          .replaceAll("LOW-to-HIGH", "HIGH-to-LOW")
          .replaceAll("↑", "↓");
  }
  const falling = analyzeDocument(doc).models[0].spec;
  const captured = simulateModel(
    falling,
    {},
    {
      inputs: [
        event(0, "E", 0),
        event(0, "CP", 0),
        ...data(0, 0xb3),
        event(1, "CP", 1),
        event(2, "CP", 0),
      ],
      ticks: 2,
    },
  );
  assert.equal(word(captured[1]), 0);
  assert.equal(word(captured[2]), 0x4c);
});
test("undefined active edges, conflicting rows, missing legends, and unsupported state symbols require review", async () => {
  const doc = (await documents)[0],
    raw = readTableLayouts(doc).tables[0];
  for (const mutate of [
    (copy) => copy.rawRows.splice(1, 1),
    (copy) => copy.rawRows.push({ inputs: ["↑", "l", "h"], outputs: ["L"] }),
    (copy) =>
      (copy.legend = copy.legend.replace("↑ = LOW-to-HIGH", "↑ = unknown")),
    (copy) =>
      (copy.legend = copy.legend.replace(
        "h = HIGH voltage level one set-up time prior",
        "h = unspecified",
      )),
    (copy) => (copy.rawRows[2].outputs = ["Z"]),
    (copy) => (copy.rawRows[0].inputs[2] = "↑"),
    (copy) =>
      (copy.legend = copy.legend.replace("X = don’t care", "X = unknown")),
  ]) {
    const copy = structuredClone(raw);
    mutate(copy);
    assert.throws(() => readSequentialTable(copy, doc));
  }
  const copy = structuredClone(doc);
  for (const page of copy.pages)
    page.text = page.text.replace(
      /edge[- ]trigger(?:ed)?/gi,
      "level sensitive",
    );
  assert.throws(
    () => readSequentialTable(raw, copy),
    /documented edge-triggered/,
  );
  const clockless = structuredClone(doc);
  for (const line of clockless.pages[2].layoutLines)
    if (
      line.cells[0]?.text === "CP" &&
      line.cells.some((cell) => cell.text === "clock")
    )
      line.cells.find((cell) => cell.text === "clock").text = "data";
  assert.equal(analyzeDocument(clockless).models.length, 0);
});
test("malformed sequential table metadata rejects as model errors before either frontend renders it", async () => {
  const spec = (await compiled)[0];
  for (const mutate of [
    (copy) => (copy.sourceTable.rows = null),
    (copy) => (copy.sourceTable.rows[0] = null),
    (copy) => (copy.sourceTable.rows[0].inputs = "bad"),
    (copy) => (copy.sourceTable.clock = null),
    (copy) => (copy.sourceTable.clock.index = 8),
    (copy) => (copy.sourceTable.matrix = []),
    (copy) => (copy.sourceTable.symbolRows = "bad"),
    (copy) => (copy.sourceTable.symbolRows[0].inputs[0] = "<img>"),
  ]) {
    const copy = structuredClone(spec);
    mutate(copy);
    assert.throws(
      () => validateModel(copy),
      (error) =>
        error instanceof ModelError && /sourceTable/.test(error.message),
    );
  }
});
test("TUI import persists the source symbols, edits initial state/input pins, and navigates all hardware blocks", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-sequential-tui-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = new TuiState({ workspace });
  await state.initialize();
  await state.loadFile(path("377"));
  assert.match(state.message, /sequential function table/);
  const output = new EventEmitter();
  output.columns = 80;
  output.rows = 24;
  output.write = () => {};
  const app = new TerminalApp(state, { input: new EventEmitter(), output });
  app.key("p", { name: "p" });
  app.key("\r", { name: "return" });
  for (const char of "0xB3") app.key(char, { name: char });
  app.key("\r", { name: "return" });
  assert.equal(word(state.snapshot), 0xb3);
  state.setView("wave");
  state.seek(2);
  app.key("i", { name: "i" });
  app.key("j", { name: "j" });
  app.key("\r", { name: "return" });
  app.key("1", { name: "1" });
  app.key("\r", { name: "return" });
  assert.equal(state.tick, 2);
  assert.equal(state.snapshot.signals.pin_e, 1);
  assert.equal(word(state.snapshot), 0xb3);
  state.setView("model");
  state.rows = 100;
  state.columns = 120;
  assert.match(screenText(state), /↑ l h → H/);
  assert.match(screenText(state), /no change/);
  const observed = new Set();
  state.setView("inspect");
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    state.blockScroll = 0;
    for (let index = 0; index < 25; index++) {
      const text = screenText(state);
      for (const node of state.model.topology.nodes)
        if (text.includes(node.label)) observed.add(node.id);
      const frame = render(state);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((line) => displayWidth(line.text) <= columns));
      state.blockScroll++;
    }
  }
  assert.equal(observed.size, state.model.topology.nodes.length);
  const restored = new TuiState({ workspace });
  await restored.initialize();
  await restored.loadSession(state.session());
  assert.equal(word(restored.snapshot), 0xb3);
  assert.equal(restored.tick, 2);
  assert.equal(restored.model.sourceTable.clock.input, "CP");
});
test("document CLI exports an executable sequential model with exact source fingerprint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chipsim-sequential-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "model.json");
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/document.mjs", path("273"), "--out", output, "--json"],
      { encoding: "utf8" },
    ),
  );
  assert.equal(report.models[0].method, "sequential function table");
  const spec = JSON.parse(await readFile(output, "utf8"));
  assert.equal(spec.sources[0].sha256, report.source.sha256);
  validateModel(spec);
});
