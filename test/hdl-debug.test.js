import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugFixture } from "./fixtures/hdl-debug.mjs";
import {
  HDLRecording,
  validateDebugRecording,
  validateDebugSession,
  debugLimits,
} from "../src/hdl/debug/recording.js";
import { parseObserverStream } from "../src/hdl/debug/collector.js";
import { runHDL } from "../src/hdl/run.js";
import { scaleFs } from "../src/hdl/time.js";

test("debug snapshots preserve event order and reconstruct every event backwards", () => {
  const data = debugFixture(),
    recording = new HDLRecording(data);
  const expected = [],
    values = {};
  for (const e of data.events) {
    Object.assign(values, e.changes);
    expected.push({ ...values });
  }
  assert.equal(
    recording.checkpoints.size,
    1 + Math.ceil(data.events.length / debugLimits.checkpointInterval),
  );
  for (let i = data.events.length - 1; i >= 0; i--) {
    const snap = recording.snapshot(i);
    assert.deepEqual({ ...snap.signals }, expected[i]);
    assert.equal(snap.runId, data.run.id);
    assert.equal(snap.eventIndex, i);
    assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.signals));
    assert.deepEqual(
      snap.executed,
      snap.event.kind === "process" ? ["p:count"] : [],
    );
  }
  assert.equal(recording.snapshot(2).signals["s:count"], "0000");
  assert.equal(recording.snapshot(3).signals["s:count"], "0001");
  assert.equal(recording.snapshot(2).time, recording.snapshot(3).time);
  assert.deepEqual(recording.snapshot(3).executed, []);
  assert.equal(recording.trace.length, data.events.length);
  assert.equal(recording.trace.slice(2, 4)[1].eventIndex, 3);
  assert.ok(recording.cache.size <= 128);
  assert.throws(() => recording.snapshot(-1), /cursor/);
  assert.throws(
    () => (recording.snapshot(2).signals["s:clk"] = "0"),
    TypeError,
  );
  data.events[3].changes["s:count"] = "1111";
  assert.equal(recording.snapshot(3).signals["s:count"], "0001");
});

test("debug recording validation rejects corrupt identity, mappings, values and time", () => {
  for (const mutate of [
    (d) => d.version++,
    (d) => (d.sources[0].text += "modified"),
    (d) => (d.design.objects[1].source.file = "missing"),
    (d) => (d.design.objects[0].parent = "p:count"),
    (d) => (d.design.connections[0].to = "missing"),
    (d) => (d.events[2].process = "b:top"),
    (d) => (d.events[3].changes["s:count"] = "1"),
    (d) => (d.events[3].changes["s:count"] = "real"),
    (d) => d.events[4].seq++,
    (d) => (d.events[4].time = "1"),
    (d) => (d.events[3].writer = "missing"),
    (d) => (d.status.complete = "yes"),
  ]) {
    const data = debugFixture(10);
    mutate(data);
    assert.throws(() => validateDebugRecording(data), /HDL debug/);
  }
  const data = debugFixture(10);
  data.events[3].changes["s:count"] = "UZWL";
  assert.doesNotThrow(() => validateDebugRecording(data));
});

test("replay stop conditions distinguish process execution, value changes and binary edges", () => {
  const recording = new HDLRecording(debugFixture(40));
  assert.equal(
    recording.nextMatch(0, { kind: "process", object: "p:count" }),
    2,
  );
  assert.equal(
    recording.nextMatch(2, { kind: "change", object: "s:count" }),
    3,
  );
  assert.equal(
    recording.nextMatch(0, { kind: "value", object: "s:count", value: "0010" }),
    7,
  );
  assert.equal(recording.nextMatch(0, { kind: "rising", object: "s:clk" }), 1);
  assert.equal(recording.nextMatch(0, { kind: "falling", object: "s:clk" }), 5);
  assert.equal(recording.nextMatch(0, { kind: "assertion" }), null);
  assert.throws(
    () => recording.nextMatch(0, { kind: "rising", object: "s:count" }),
    /one-bit/,
  );
});

test("portable session validates cursor, source hashes, linked selection and stops before use", () => {
  const session = {
    format: "chipsim-hdl-debug-session",
    version: 1,
    recording: debugFixture(20),
    ui: {
      eventIndex: 2,
      focus: "source",
      maximized: false,
      format: "hex",
      scope: "b:top",
      signals: ["s:count"],
      selection: "p:count",
      stops: [{ kind: "process", object: "p:count" }],
    },
  };
  assert.equal(
    validateDebugSession(session).recording.snapshot(2).event.kind,
    "process",
  );
  session.ui.stops[0].object = "unknown";
  assert.throws(() => validateDebugSession(session), /process/);
});

test("observer transport permits only a truncated last record, never malformed complete records", () => {
  assert.deepEqual(
    parseObserverStream('{"record":"end"}\n{"rec', { partial: true }),
    {
      records: [{ record: "end" }],
      truncated: true,
    },
  );
  assert.throws(
    () => parseObserverStream('{"record":"end"}\nbad\n', { partial: true }),
    /record 2/,
  );
  assert.throws(
    () => parseObserverStream('{"record":"end"}\n{"rec'),
    /record 2/,
  );
});

const real = process.env.CHIPSIM_TEST_HDL_DEBUG === "1";
test(
  "real debug captures preserve stock simulator waveforms and independent adder oracle",
  { skip: !real, timeout: 120000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-debug-test-"));
    try {
      for (const language of ["verilog", "vhdl"]) {
        const project = `examples/hdl/adder-${language}.project.json`;
        const ordinary = await runHDL(
          project,
          join(root, language + "-ordinary"),
        );
        const captured = await runHDL(
          project,
          join(root, language + "-debug"),
          { debug: true },
        );
        assert.equal(ordinary.result.ok, true, ordinary.result.error);
        assert.equal(captured.result.ok, true, captured.result.error);
        assert.deepEqual(
          captured.waveform.events,
          ordinary.waveform.events,
          "instrumentation must not change simulation",
        );
        const data = captured.recording,
          recording = new HDLRecording(data);
        assert.ok(data.design.objects.some((obj) => obj.kind === "port"));
        assert.ok(
          data.design.connections.some((edge) => edge.kind === "reads"),
        );
        assert.ok(
          data.design.connections.some((edge) => edge.kind === "writes"),
        );
        assert.ok(
          data.events.some(
            (event, i) => i && event.time === data.events[i - 1].time,
          ),
        );
        assert.ok(
          data.events.some(
            (event, i) =>
              event.kind === "process" &&
              data.events[i + 1]?.kind === "process",
          ),
          "no-change activations are retained",
        );
        let cursor = 0;
        const values = {};
        for (const sample of ordinary.waveform.events) {
          while (
            cursor < data.events.length &&
            BigInt(data.events[cursor].time) * scaleFs(data.timescale) <=
              BigInt(sample.time) * scaleFs(ordinary.waveform.timescale)
          )
            Object.assign(values, data.events[cursor++].changes);
          for (const [id, bits] of Object.entries(sample.changes)) {
            const signal = "s:" + id.replace(/\[-?\d+:-?\d+\]$/, "");
            assert.equal(
              values[signal],
              bits,
              `${language} ${id} at ${sample.time}`,
            );
          }
          const timeNs =
            (BigInt(sample.time) * scaleFs(ordinary.waveform.timescale)) /
            1000000n;
          if (timeNs < 1280n) {
            const pair = Number(timeNs / 5n),
              a = Math.floor(pair / 16),
              b = pair % 16;
            const key =
              language === "verilog" ? "s:adder_tb.X" : "s:adder_tb.x";
            assert.equal(
              parseInt(values[key], 2),
              a + b,
              `independent sum at ${timeNs}ns`,
            );
          }
        }
        // Compare reverse reconstruction to a forward fold independently of checkpoints.
        const wanted = new Map(),
          forward = {};
        data.events.forEach((event, i) => {
          Object.assign(forward, event.changes);
          if (i % 37 === 0 || i === data.events.length - 1)
            wanted.set(i, { ...forward });
        });
        for (const [i, expected] of [...wanted].reverse())
          assert.deepEqual({ ...recording.snapshot(i).signals }, expected);
        assert.deepEqual(
          JSON.parse(await readFile(captured.result.artifacts.debug, "utf8")),
          data,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// These exercise the real renderer/state on every event, including reverse seeks.
import { writeFile } from "node:fs/promises";
import { TuiState } from "../src/tui/state.js";
import {
  render,
  screenText,
  displayWidth,
  display,
} from "../src/tui/render.js";
import { debugDetails } from "../src/tui/debug-render.js";
import {
  selectDebugObject,
  advanceDebugReplay,
} from "../src/tui/debug-state.js";
import { DebugPanel } from "../src/tui/debug-panel.js";
import { debugCSV, debugVCD } from "../src/hdl/debug/model.js";
import { parseVCD } from "../src/hdl/vcd.js";
import { debugTools } from "../src/hdl/debug/tools.js";

async function terminal(t) {
  const dir = await mkdtemp(join(tmpdir(), "chipsim-debug-ui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = new TuiState({ workspace: join(dir, "workspace") });
  await state.initialize();
  state.installDebugRecording(debugFixture(40));
  return { state, dir };
}

test("all three panes and full-screen views match each after-event snapshot at both sizes", async (t) => {
  const { state: s } = await terminal(t);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    Object.assign(s, { columns, rows });
    for (let index = s.lastTick; index >= 0; index--) {
      s.seek(index);
      s.view = "debug";
      const frame = render(s),
        text = frame.map((r) => r.text).join("\n");
      assert.equal(frame.length, rows);
      assert.ok(frame.every((r) => displayWidth(r.text) === columns));
      for (const title of ["HDL SOURCE", "RTL HARDWARE", "SIGNALS"])
        assert.ok(text.includes(`${title} · e${index}`));
      assert.match(text, /EVENT ORDER/);
      const detail = debugDetails(s, "s:count");
      assert.ok(detail.includes(`Bits (4): ${s.snapshot.signals["s:count"]}`));
      assert.ok(detail.includes(`Event: ${index} (snapshot after event)`));
      for (const [view, title] of [
        ["program", "HDL SOURCE"],
        ["inspect", "RTL HARDWARE"],
        ["wave", "SIGNALS"],
      ]) {
        s.setView(view);
        assert.ok(screenText(s).includes(`${title} · e${index}`));
        assert.equal(s.tick, index);
      }
    }
  }
  s.seek(2);
  selectDebugObject(s, "s:count");
  assert.equal(s.tick, 2);
  assert.equal(s.debugUI.sourceLine, 3);
  assert.equal(s.debugUI.follow, false);
  assert.equal(s.signal.id, "s:count");
  s.setView("program");
  assert.match(screenText(s), /BROWSE/);
});

test("pane focus, maximize, selection and replay stops preserve the shared cursor", async (t) => {
  const { state: s } = await terminal(t),
    panel = new DebugPanel({ state: s });
  s.seek(2);
  panel.handle("", { name: "f2" });
  assert.equal(s.debugUI.focus, "hardware");
  panel.handle("", { name: "f3" });
  assert.equal(s.debugUI.maximized, true);
  panel.handle("", { name: "f3" });
  assert.equal(s.debugUI.maximized, false);
  panel.handle("j", { name: "j" });
  assert.equal(s.tick, 2);
  assert.equal(s.debugUI.follow, false);
  panel.handle("G", { name: "g" });
  assert.equal(s.debugUI.selection, "p:count");
  s.debugUI.stops = [{ kind: "value", object: "s:count", value: "0010" }];
  panel.handle("C", { name: "c" });
  assert.equal(s.tick, 7);
  panel.handle("J", { name: "j" });
  assert.equal(s.tick, 6);
  panel.handle("N", { name: "n" });
  assert.equal(s.tick, 7);
  s.seek(0);
  s.playing = true;
  for (let i = 0; i < 7; i++) advanceDebugReplay(s);
  assert.equal(s.tick, 7);
  assert.equal(s.playing, false);
  assert.match(s.message, /Replay stopped/);
  assert.throws(() => s.requireManualExperiment(), /read-only/);
});

test("portable debug sessions restore browsing, cursor, signals, display and stops atomically", async (t) => {
  const { state: s, dir } = await terminal(t);
  s.seek(7);
  selectDebugObject(s, "s:count");
  s.debugUI.focus = "hardware";
  s.debugUI.maximized = true;
  s.debugUI.signals = ["s:count"];
  s.debugUI.stops = [{ kind: "change", object: "s:count" }];
  s.format = "binary";
  s.zoom = 2;
  s.offset = 1;
  const session = structuredClone(s.session()),
    file = join(dir, "session.json");
  await writeFile(file, JSON.stringify(session));
  s.seek(0);
  await s.loadDebugFile(file);
  assert.deepEqual(s.session(), session);
  const before = s.model,
    trace = s.trace;
  session.recording.sources[0].sha256 = "bad";
  await writeFile(file, JSON.stringify(session));
  await assert.rejects(s.loadDebugFile(file), /fingerprint/);
  assert.equal(s.model, before);
  assert.equal(s.trace, trace);
  assert.equal(s.tick, 7);
  const bad = debugFixture();
  bad.events[0].changes.missing = "1";
  assert.throws(() => s.installDebugRecording(bad), /unmapped/);
  assert.equal(s.model, before);
});

test("event CSV is lossless in order while VCD explicitly projects final values per timestamp", () => {
  const data = debugFixture(10),
    csv = debugCSV(data),
    vcd = debugVCD(data);
  assert.equal(csv.trim().split("\n").length, data.events.length + 1);
  assert.match(csv, /"2","10","1ns"/);
  assert.match(vcd, /intermediate same-time values are omitted/);
  const wave = parseVCD(vcd);
  assert.ok(wave.events.length < data.events.length);
  assert.equal(
    wave.events.find((e) => e.time === "10").changes["s:count"],
    "0001",
  );
});

test("missing/incompatible debug toolchain is an explicit result; imports do not consult it", async (t) => {
  const { state: s, dir } = await terminal(t),
    old = process.env.CHIPSIM_HDL_DEBUG_TOOLS;
  try {
    process.env.CHIPSIM_HDL_DEBUG_TOOLS = dir;
    assert.equal((await debugTools()).verilog.available, false);
    await writeFile(
      join(dir, "chipsim-debug-tools.json"),
      JSON.stringify({ format: "chipsim-hdl-debug-tools", version: 99 }),
    );
    assert.match((await debugTools()).vhdl.reason, /incompatible/);
    const path = join(dir, "recording.json");
    await writeFile(path, JSON.stringify(debugFixture()));
    await s.loadDebugFile(path);
    assert.equal(s.hdlDebug.data.run.id, "fixture");
  } finally {
    if (old === undefined) delete process.env.CHIPSIM_HDL_DEBUG_TOOLS;
    else process.env.CHIPSIM_HDL_DEBUG_TOOLS = old;
  }
});

test("signed debug display preserves exact bits and does not coerce nine-state values", () => {
  assert.equal(display("11111101", "decimal", 8, true), "-3");
  assert.equal(display("11111101", "hex", 8, true), "0xFD");
  assert.equal(display("11111101", "decimal", 8), "253");
  assert.equal(display("10XZ", "decimal", 4, true), "10XZ");
});

test("unmapped process activation clears prior source context and empty partial recordings remain inspectable", async (t) => {
  const { state: s } = await terminal(t),
    data = debugFixture(5);
  data.design.objects.find((o) => o.kind === "process").source = null;
  data.capabilities.sourceLocations = "partial";
  s.installDebugRecording(data);
  s.seek(2);
  assert.equal(s.debugUI.sourceFile, null);
  assert.match(screenText(s), /No source location recorded/);
  assert.equal(s.snapshot.executed[0], "p:count");
  const partial = debugFixture(1);
  partial.events = [];
  partial.design = { objects: [], connections: [] };
  partial.status = { complete: false, reason: "compile failed" };
  s.installDebugRecording(partial);
  assert.match(screenText(s), /PARTIAL/);
  assert.match(screenText(s), /no simulation events/);
  advanceDebugReplay(s);
  assert.equal(s.playing, false);
});

test("combined pane colors cannot imply execution of an unrelated adjacent source line", async (t) => {
  const { state: s } = await terminal(t);
  s.columns = 120;
  s.rows = 40;
  s.seek(2);
  const frame = render(s),
    sourceRow = frame.find((r) => r.parts?.[0].style === "event");
  assert.ok(sourceRow);
  assert.match(sourceRow.parts[0].text, /▶/);
  const hardwareRow = frame.find((r) => r.parts?.[2].style === "event");
  assert.ok(hardwareRow);
  assert.match(hardwareRow.parts[2].text, /▶/);
  assert.equal(
    hardwareRow.parts[0].style === "event",
    hardwareRow.parts[0].text.includes("▶"),
  );
  const malicious = debugFixture(4);
  malicious.sources[0].text += "\x1b[2J";
  const { sourceDigest } = await import("../src/hdl/debug/recording.js");
  malicious.sources[0].sha256 = sourceDigest(malicious.sources[0].text);
  s.installDebugRecording(malicious);
  s.seek(2);
  assert.ok(!screenText(s).includes("\x1b"));
});
