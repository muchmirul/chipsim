import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import {
  render,
  screenText,
  clean,
  displayWidth,
  clip,
} from "../src/tui/render.js";
import { buildScenario } from "../src/model/templates.js";
import { exportVCD } from "../src/trace/export.js";
import { sourceBundle } from "../src/documents/recognize.js";
async function state(t) {
  const path = await mkdtemp(join(tmpdir(), "chipsim-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const s = new TuiState({ workspace: path });
  await s.initialize();
  return s;
}
const text =
  "Example manual. A 16-bit counter increments when enabled and has a reset input.";
test("TUI preserves values and cursor while changing display, and vi edge jumps are strict", async (t) => {
  const s = await state(t);
  s.selected = 1;
  s.jumpEdge("rise");
  assert.equal(s.tick, 2);
  s.jumpEdge("rise");
  assert.equal(s.tick, 6);
  s.jumpEdge("rise", -1);
  assert.equal(s.tick, 2);
  s.jumpEdge("fall");
  assert.equal(s.tick, 4);
  s.format = "decimal";
  assert.equal(s.tick, 4);
  assert.match(screenText(s), /format decimal/);
  s.setParameter("payload", 300);
  assert.equal(
    s.trace.find((p) => p.phase === "success").registers.decoded,
    44,
  );
});
test("all TUI views fit normal and compact terminal frames", async (t) => {
  const s = await state(t);
  for (const columns of [80, 120])
    for (const rows of [24, 40])
      for (const view of [
        "wave",
        "inspect",
        "registers",
        "log",
        "sources",
        "model",
        "stimulus",
      ]) {
        s.columns = columns;
        s.rows = rows;
        s.setView(view);
        const frame = render(s);
        assert.equal(frame.length, rows);
        assert.ok(frame.every((row) => displayWidth(row.text) <= columns));
        assert.match(screenText(s), /q quit/);
      }
  assert.equal(clean("\x1b[2Jhello\x07").includes("\x1b"), false);
});
test("keyboard parameter editor accepts octal, handles errors, and preserves prior configuration", async (t) => {
  const s = await state(t),
    input = new EventEmitter(),
    output = new EventEmitter();
  input.isRaw = false;
  input.setRawMode = (raw) => (input.isRaw = raw);
  input.resume = input.pause = () => {};
  output.columns = 120;
  output.rows = 40;
  output.write = () => {};
  const app = new TerminalApp(s, { input, output });
  app.key("p", { name: "p" });
  app.key("\r", { name: "return" });
  for (const text of "0o263") app.key(text, { name: text });
  app.key("\r", { name: "return" });
  assert.equal(s.config.parameters.payload, 179);
  assert.equal(s.prompt, null);
  app.key("l", { name: "l" });
  app.key("F", { name: "f" });
  assert.equal(s.tick, 1);
  assert.equal(s.format, "decimal");
  app.key("p", { name: "p" });
  app.key("\r", { name: "return" });
  for (const text of "0b102") app.key(text, { name: text });
  app.key("\r", { name: "return" });
  assert.match(s.prompt.error, /whole numbers/);
  assert.equal(s.config.parameters.payload, 179);
  app.key("", { name: "escape" });
});
test("TUI model workspace persists sourced models and restores shared sessions", async (t) => {
  const s = await state(t),
    doc = {
      id: "a".repeat(24),
      sha256: "a".repeat(64),
      filename: "example.pdf",
      pages: [{ number: 1, text }],
    };
  s.documents.push(doc);
  const spec = buildScenario(doc, {
    name: "Sourced counter",
    kind: "counter",
    width: 16,
    value: 3,
    direction: "up",
    match: "repeat",
    page: 1,
    quote: text,
    claim: "The excerpt describes a 16-bit counter.",
  }).spec;
  await s.installModel(spec);
  s.seek(3);
  s.format = "octal";
  const session = s.session();
  s.selectModel("pio");
  await s.loadSession(session);
  assert.equal(s.modelId, "sourced-counter");
  assert.equal(s.tick, 3);
  assert.equal(s.format, "octal");
  const files = await s.workspace.records("models");
  assert.equal(files.entries[0].id, spec.id);
  assert.equal(s.config.parameters.period, 3);
});
test("Poppler import, source search, and PDF association operate without a browser", async (t) => {
  const s = await state(t);
  const doc = await s.loadFile(
    join(s.root, "docs/references/s32k144/nxp-flexio-an12174.pdf"),
  );
  assert.equal(doc.pages.length, 46);
  assert.equal(s.modelId, "flexio");
  s.searchSources("16-bit timers");
  assert.equal(s.page, 3);
  assert.match(s.document.pages[2].text, /16-bit timers/);
  const bundle = sourceBundle([doc]);
  assert.equal(bundle.documents[0].filePath, undefined);
  assert.equal(bundle.documents[0].bytes, undefined);
  const s2 = new TuiState({ workspace: s.workspace.path });
  await s2.initialize();
  assert.equal(s2.documents.length, 1);
  assert.equal(s2.documents[0].sha256, doc.sha256);
});
test("VCD preserves an unarmed register as unknown until its value exists", async (t) => {
  const s = await state(t),
    vcd = exportVCD(s.model, s.trace);
  const definition = /\$var wire 32 (v\d+) registers_deadline \$end/.exec(vcd);
  assert.ok(definition);
  assert.ok(vcd.includes("b" + "x".repeat(32) + " " + definition[1]));
  assert.ok(
    vcd.includes(
      "b" + (40).toString(2).padStart(32, "0") + " " + definition[1],
    ),
  );
});
test("snapshot CLI works without a TTY and rejects an invalid cursor", async (t) => {
  const s = await state(t);
  const output = execFileSync(
    process.execPath,
    [
      "scripts/chipsim.mjs",
      "--snapshot",
      "--workspace",
      s.workspace.path,
      "--at",
      "2",
      "--view",
      "registers",
      "--columns",
      "80",
      "--rows",
      "24",
    ],
    { cwd: s.root, encoding: "utf8" },
  );
  assert.match(output, /tick 2\/59/);
  assert.match(output, /reg.osr/);
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        "scripts/chipsim.mjs",
        "--snapshot",
        "--workspace",
        s.workspace.path,
        "--at",
        "not-a-number",
      ],
      { cwd: s.root, stdio: "pipe" },
    ),
  );
});

test("terminal cell sizing handles wide source text, combining marks, and tiny windows", async (t) => {
  const s = await state(t);
  assert.equal(displayWidth("参考手册"), 8);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(displayWidth("🔧"), 2);
  assert.equal(displayWidth(clip("参考手册", 5)), 5);
  s.models = s.models.map((model) =>
    model.id === s.modelId ? { ...model, name: "参考手册 🔧" } : model,
  );
  s.columns = 80;
  s.rows = 24;
  assert.ok(render(s).every((row) => displayWidth(row.text) === 80));
  s.columns = 25;
  s.rows = 10;
  const frame = render(s);
  assert.equal(frame.length, 10);
  assert.ok(frame.every((row) => displayWidth(row.text) === 25));
  assert.match(frame[1].text, /q quit/);
});
