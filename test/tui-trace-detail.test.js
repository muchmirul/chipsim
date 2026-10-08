import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";
import { wrapText } from "../src/tui/text.js";
import { stepLines, transactionLines } from "../src/tui/trace-detail.js";
import { esp32c6Gpio } from "../src/model/profiles/esp32c6-gpio.js";
import manifest from "../docs/references/manifest.json" with { type: "json" };
const source = manifest.documents.find((source) =>
  source.chips.includes("esp32c6-gpio"),
);
async function setup(t) {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-detail-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const s = new TuiState({ workspace });
  await s.initialize();
  await s.installModel(esp32c6Gpio(source));
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = input.resume = input.pause = () => {};
  output.columns = 80;
  output.rows = 24;
  output.write = () => {};
  return { s, app: new TerminalApp(s, { input, output }), output };
}
const enter = (app) => app.key("\r", { name: "return" });

test("step details expose complete transaction, changes and original page evidence without changing an experiment", async (t) => {
  const { s, app, output } = await setup(t);
  s.seek(10);
  const before = structuredClone(s.session()),
    trace = s.trace,
    history = structuredClone(s.stimulus.history);
  s.playing = true;
  enter(app);
  assert.equal(s.playing, false);
  assert.equal(s.traceDetail.tick, 10);
  const lines = stepLines(s, s.snapshot).join("\n");
  assert.match(
    lines,
    /REGISTER TRANSACTION · accepted\nWrite 0x000C · GPIO_OUT_W1TC_REG\nWrite data: 0x00000003/,
  );
  assert.match(lines, /reg.gpio_out · GPIO_OUT_REG: 0x000001B3 → 0x000001B0/);
  assert.match(lines, /signal.selected_driver: 0x1 → 0x0/);
  assert.match(lines, /PDF page 271/);
  assert.match(
    lines,
    /written ones act on corresponding latch bits; zeros preserve them\./,
  );
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    output.columns = columns;
    output.rows = rows;
    app.draw();
    assert.equal(render(s).length, rows);
    assert.ok(render(s).every((row) => displayWidth(row.text) === columns));
    assert.match(screenText(s), /STEP 10/);
    app.key("$", { name: "end" });
    assert.match(screenText(s), /corresponding bit in GPIO_OUT_REG/);
    app.key("0");
  }
  app.key("F");
  assert.match(stepLines(s, s.snapshot).join("\n"), /GPIO_OUT_REG: 435 → 432/);
  assert.equal(s.tick, 10);
  assert.equal(s.trace, trace);
  app.key("F");
  app.key("F");
  app.key("F");
  app.key("", { name: "escape" });
  assert.deepEqual(s.session(), before);
  assert.deepEqual(s.stimulus.history, history);
  s.setView("log");
  s.logFilter = "GPIO_ENABLE_W1TC";
  s.logIndex = 0;
  enter(app);
  assert.equal(s.tick, 12);
  assert.equal(s.traceDetail.tick, 12);
  assert.match(
    stepLines(s, s.snapshot).join("\n"),
    /signal.selected_driver: 0x0 → Z/,
  );
  app.key("]");
  assert.equal(s.traceDetail.tick, 13);
  app.key("[");
  assert.equal(s.traceDetail.tick, 12);
  app.key("q");
  assert.equal(app.closed, false);
  assert.equal(s.traceDetail, null);
});

test("read results follow adapter acceptance and rejected or held requests cannot masquerade as reads", async (t) => {
  const { s } = await setup(t);
  const lines = (tick) =>
    transactionLines(s.model, s.trace[tick], s.trace[tick - 1], "hex").join(
      "\n",
    );
  assert.match(lines(14), /Read result: 0x000001B0/);
  assert.equal(lines(15), "");
  const rejected = structuredClone(s.trace[14]);
  rejected.signals.error = 1;
  const rejectedLines = transactionLines(
    s.model,
    rejected,
    s.trace[13],
    "hex",
  ).join("\n");
  assert.match(rejectedLines, /rejected/);
  assert.doesNotMatch(rejectedLines, /Read result:/);
  rejected.signals.error = 0;
  rejected.signals.valid = 0;
  const ignored = transactionLines(s.model, rejected, s.trace[13], "hex").join(
    "\n",
  );
  assert.match(ignored, /not accepted/);
  assert.doesNotMatch(ignored, /Read result:/);
  assert.equal(lines(0), "");
});

test("evidence opens the exact loaded source/page and unavailable citations preserve the detail view", async (t) => {
  const { s, app } = await setup(t);
  s.seek(10);
  enter(app);
  app.key("s");
  enter(app);
  assert.match(s.message, /Cited PDF is not loaded/);
  assert.ok(s.traceDetail);
  const document = {
    id: "loaded-source",
    sha256: source.sha256,
    filename: "manual.pdf",
    pages: [{ number: 271, text: "Original cited source page" }],
  };
  s.documents.push(document);
  app.key("s");
  app.key("", { name: "escape" });
  assert.ok(s.traceDetail);
  app.key("s");
  enter(app);
  assert.equal(s.traceDetail, null);
  assert.equal(s.view, "sources");
  assert.equal(s.documentId, document.id);
  assert.equal(s.page, 271);
  assert.equal(s.tick, 10);
  s.selectModel("pio");
  s.setView("wave");
  enter(app);
  app.key("s");
  assert.match(s.message, /No step-specific citation/);
  assert.match(
    stepLines(s, s.snapshot).join("\n"),
    /no individual page citation/,
  );
});

test("details keep unavailable, zero and Z distinct, preserve scheduled input order, and wrap hostile long text safely", async (t) => {
  const { s, app } = await setup(t);
  s.config.inputs.push(
    { tick: 0, signal: "write_data", value: 1 },
    { tick: 0, signal: "write_data", value: 0 },
  );
  const snapshot = structuredClone(s.trace[0]);
  snapshot.message =
    "Wide text 参考手册 🔧 " + "identifier".repeat(24) + "\x1b[2J\x07 tail";
  snapshot.detail = "Fault explanation\nsecond line";
  snapshot.phase = "fault";
  snapshot.changes = [
    { kind: "signals", id: "output_latch", before: undefined, after: 0 },
    { kind: "signals", id: "selected_driver", before: 0, after: "Z" },
  ];
  s.trace[0] = snapshot;
  s.seek(0);
  enter(app);
  const text = stepLines(s, snapshot).join("\n");
  assert.match(text, /output_latch: — → 0x00000000/);
  assert.match(text, /selected_driver: 0x0 → Z/);
  assert.match(text, /write_data = 0x00000001 · superseded at same tick/);
  assert.ok(
    text.indexOf("write_data = 0x00000001") <
      text.indexOf("write_data = 0x00000000"),
  );
  const wrapped = wrapText(snapshot.message, 60);
  assert.ok(wrapped.every((line) => displayWidth(line) <= 60));
  assert.equal(wrapped.join("").match(/identifier/g).length, 24);
  assert.ok(!wrapped.join("").includes("\x1b"));
  app.key("$", { name: "end" });
  assert.ok(render(s).every((row) => displayWidth(row.text) <= 80));
});
