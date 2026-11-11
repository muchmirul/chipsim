import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRun, runHDL, readProject } from "../src/hdl/run.js";
import {
  validateDebugRecording,
  HDLRecording,
  debugLimits,
  sourceDigest,
} from "../src/hdl/debug/recording.js";
import {
  normalizeCapture,
  selectCaptureObjects,
} from "../src/hdl/debug/capture.js";
import { debugFixture } from "./fixtures/hdl-debug.mjs";
import { TuiState } from "../src/tui/state.js";
import { screenText } from "../src/tui/render.js";
import { designRows } from "../src/tui/design-panel.js";
import { designGuide } from "../src/design/guide.js";
import { startJob, waitJob, jobLogs } from "../src/design/jobs.js";
import { checksForTarget, targetStatus } from "../src/design/service.js";
import { Store } from "../src/design/store.js";
import { verifyEvidence, inspectArtifact } from "../src/design/evidence.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-feedback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("HDL stage output arrives before exit, preserves UTF-8 and awaits asynchronous logging", async () => {
  const chunks = [];
  const result = await processRun(
    process.execPath,
    [
      "-e",
      `
    process.stdout.write(Buffer.from([0xe2]));
    setTimeout(()=>{process.stdout.write(Buffer.from([0x82,0xac]));process.stderr.write('assertion diagnostic');},20);
    setTimeout(()=>process.exit(1),120);
  `,
    ],
    {
      onOutput: async (stream, text) => {
        await new Promise((done) => setTimeout(done, 5));
        chunks.push({ stream, text });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "€");
  assert.equal(
    chunks
      .filter((c) => c.stream === "stdout")
      .map((c) => c.text)
      .join(""),
    "€",
  );
  assert.equal(
    chunks
      .filter((c) => c.stream === "stderr")
      .map((c) => c.text)
      .join(""),
    "assertion diagnostic",
  );
  const broken = await processRun(
    process.execPath,
    ["-e", "console.log('hello')"],
    {
      onOutput: async () => {
        throw new Error("disk full");
      },
    },
  );
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /diagnostic log write failed: disk full/);
});

test("capture limits identify malformed data separately and report actual counts", () => {
  const malformed = debugFixture(1);
  malformed.design.objects = {};
  assert.throws(
    () => validateDebugRecording(malformed),
    /objects and connections must be arrays/,
  );
  const oversized = debugFixture(1);
  oversized.design.objects = Array.from(
    { length: debugLimits.objects + 1 },
    (_, i) => ({ kind: "instance", id: "b:" + i, label: "block" }),
  );
  assert.throws(
    () => validateDebugRecording(oversized),
    (error) => {
      assert.equal(error.code, "HDL_DEBUG_LIMIT");
      assert.deepEqual(error.details, {
        stage: "elaboration",
        limit: "objects",
        observed: 16385,
        maximum: 16384,
      });
      assert.match(error.message, /16385 > 16384/);
      return true;
    },
  );
});

test("capture scope validation is bounded, exact and preserves ancestors without inventing connections", () => {
  assert.deepEqual(normalizeCapture({ scopes: ["tb.dut", "tb.g[0]"] }), {
    scopes: ["tb.dut", "tb.g[0]"],
  });
  for (const value of [
    {},
    { scopes: [] },
    { scopes: ["tb.*"] },
    { scopes: ["tb.dut\nother"] },
    { scopes: ["tb", "tb"] },
    { scopes: ["tb"], script: "bad" },
  ])
    assert.throws(() => normalizeCapture(value), /capture requires/);
  const all = new Map([
    ["tb", { id: "tb", kind: "instance", path: "tb" }],
    ["dut", { id: "dut", kind: "instance", path: "tb.dut", parent: "tb" }],
    ["q", { id: "q", kind: "signal", path: "tb.dut.q", parent: "dut" }],
    [
      "score",
      { id: "score", kind: "signal", path: "tb.scoreboard", parent: "tb" },
    ],
  ]);
  assert.deepEqual(
    [...selectCaptureObjects(all, ["tb.dut"]).keys()],
    ["tb", "dut", "q"],
  );
  assert.throws(
    () => selectCaptureObjects(all, ["tb.missing"]),
    /scope does not exist/,
  );
});

test("older fingerprinted observers cannot silently ignore requested capture scopes", async (t) => {
  const root = await temporary(t);
  const script = "#!/bin/sh\nexit 0\n";
  await writeFile(join(root, "probe"), script, { mode: 0o755 });
  const entry = { path: "probe", sha256: sourceDigest(script) };
  await writeFile(
    join(root, "chipsim-debug-tools.json"),
    JSON.stringify({
      format: "chipsim-hdl-debug-tools",
      version: 1,
      instrumentation: "chipsim-1",
      backends: {
        verilog: {
          iverilog: entry,
          vvp: entry,
          compiler: entry,
          target: entry,
        },
        vhdl: { ghdl: entry },
      },
    }),
  );
  await writeFile(join(root, "tb.sv"), "module tb; initial $finish; endmodule");
  await writeFile(
    join(root, "sim.json"),
    JSON.stringify({
      format: "chipsim-hdl-project",
      version: 1,
      language: "verilog",
      top: "tb",
      sources: ["tb.sv"],
      capture: { scopes: ["tb"] },
    }),
  );
  const previous = process.env.CHIPSIM_HDL_DEBUG_TOOLS;
  process.env.CHIPSIM_HDL_DEBUG_TOOLS = root;
  try {
    const { result, recording } = await runHDL(
      join(root, "sim.json"),
      join(root, "run"),
      {
        onOutput: async () => {
          throw new Error("managed log unavailable");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.stages[0].stage, "debug-setup");
    assert.match(result.error, /lacks capture-scopes-v1/);
    assert.equal(recording.events.length, 0);
    assert.equal(result.loggingError, "managed log unavailable");
    assert.equal(
      JSON.parse(await readFile(result.artifacts.debug, "utf8")).sources.length,
      1,
    );
    const manifestPath = join(root, "chipsim-debug-tools.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.capabilities = ["capture-scopes-v1"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const oldScope = await runHDL(
      join(root, "sim.json"),
      join(root, "old-scope"),
    );
    assert.equal(oldScope.result.ok, false);
    assert.match(oldScope.result.error, /lacks capture-process-file-v1/);
    await assert.rejects(
      runHDL(join(root, "sim.json"), join(root, "wave"), { debug: false }),
      /requires debug capture/,
    );
  } finally {
    if (previous === undefined) delete process.env.CHIPSIM_HDL_DEBUG_TOOLS;
    else process.env.CHIPSIM_HDL_DEBUG_TOOLS = previous;
  }
});

test("signal name search links a nested HDL object and preserves cursor, pins and saved replay stops", async (t) => {
  const root = await temporary(t);
  const state = new TuiState({ workspace: join(root, "workspace") });
  await state.initialize();
  const data = debugFixture(20);
  data.design.objects.push({
    id: "b:dut",
    kind: "instance",
    label: "top.dut",
    path: "top.dut",
    parent: "b:top",
    source: { file: "src", line: 1 },
  });
  const count = data.design.objects.find((o) => o.id === "s:count");
  Object.assign(count, {
    path: "top.dut.count",
    label: "top.dut.count",
    parent: "b:dut",
  });
  state.installDebugRecording(data);
  state.seek(2);
  state.debugUI.stops = [{ kind: "value", object: "s:count", value: "0010" }];
  const pins = [...state.debugUI.signals];
  state.playing = true;
  state.findSignal("top.dut.count");
  assert.equal(state.tick, 2);
  assert.equal(state.signal.id, "s:count");
  assert.equal(state.debugUI.selection, "s:count");
  assert.equal(state.debugUI.scope, "b:dut");
  assert.equal(state.debugUI.sourceFile, "src");
  assert.equal(state.debugUI.sourceLine, 3);
  assert.equal(state.debugUI.follow, false);
  assert.equal(state.playing, false);
  assert.deepEqual(state.debugUI.signals, pins);
  assert.equal(state.debugUI.stops.length, 1);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    Object.assign(state, { columns, rows, view: "debug" });
    const text = screenText(state);
    for (const title of ["HDL SOURCE", "RTL HARDWARE", "SIGNALS"])
      assert.ok(text.includes(title + " · e2"));
    assert.match(text, /BROWSE/);
  }
  state.findSignal("not-present");
  assert.equal(state.debugUI.selection, "s:count");
});

test("project status separates selected-target readiness, absent runs and historical stale evidence", () => {
  const current = { id: "a".repeat(64), target: "acceptance", stale: false };
  const old = { id: "b".repeat(64), target: "debug", stale: true };
  const state = {
    columns: 120,
    view: "project",
    design: {
      root: "/example",
      target: "acceptance",
      ready: true,
      artifacts: [],
      checks: [],
      selection: {},
      summary: {
        targets: ["acceptance", "debug", "new"],
        jobs: [],
        errors: [],
        runs: [current, old],
      },
    },
  };
  const text = () =>
    designRows(state, 20)
      .map((r) => r.text)
      .join("\n");
  assert.match(text(), /READY · acceptance · run aaaaaaaa/);
  assert.match(text(), /Historical debug run bbbbbbbb is stale/);
  assert.doesNotMatch(text(), /Inputs changed · affected/);
  state.design.target = "new";
  state.design.ready = false;
  assert.match(text(), /NO RUN · new · no captured run/);
  state.design.target = "acceptance";
  current.stale = true;
  assert.match(text(), /BLOCKED · acceptance/);
  assert.match(text(), /Current acceptance run aaaaaaaa is stale/);
});

const native = {
  skip: process.env.CHIPSIM_TEST_HDL_DEBUG !== "1",
  timeout: 120000,
};
test(
  "real scoped observers exclude a large testbench scoreboard on both backends and retain outside assertions",
  native,
  async (t) => {
    const root = await temporary(t);
    const bodies = {
      verilog: `module tb; reg clk=0; always #1 clk=~clk; reg [7:0] scoreboard[0:16383];
      generate begin:dut reg [3:0] q=0; always @(posedge clk) q<=q+1; end endgenerate
      initial begin scoreboard[0]=8'h5a; #8; $display("score=%h",scoreboard[0]); $finish; end endmodule`,
      vhdl: `entity tb is end; architecture a of tb is signal clk:bit:='0'; signal scoreboard:bit_vector(16383 downto 0):=(others=>'0'); begin
      clk<=not clk after 1 ns; dut:block is signal q:integer:=0; begin p:process(clk) begin if clk'event and clk='1' then q<=q+1; end if; end process; end block;
      process begin wait for 8 ns; std.env.finish; end process; end;`,
    };
    for (const [language, body] of Object.entries(bodies)) {
      const dir = join(root, language);
      await mkdir(dir);
      await writeFile(
        join(dir, "tb." + (language === "vhdl" ? "vhdl" : "sv")),
        body,
      );
      const manifest = {
        format: "chipsim-hdl-project",
        version: 1,
        language,
        standard: language === "vhdl" ? "08" : "2012",
        top: "tb",
        sources: ["tb." + (language === "vhdl" ? "vhdl" : "sv")],
        capture: { scopes: ["tb.dut"] },
      };
      const file = join(dir, "sim.json");
      await writeFile(file, JSON.stringify(manifest));
      if (language === "verilog") {
        const unscoped = { ...manifest };
        delete unscoped.capture;
        const full = join(dir, "full.json");
        await writeFile(full, JSON.stringify(unscoped));
        const overflow = await runHDL(full, join(dir, "overflow"));
        assert.equal(overflow.result.ok, false);
        assert.equal(overflow.result.simulation.ok, true);
        assert.equal(overflow.result.capture.ok, false);
        assert.equal(
          overflow.result.capture.diagnostic.code,
          "HDL_DEBUG_LIMIT",
        );
        assert.equal(
          overflow.result.capture.diagnostic.details.limit,
          "objects",
        );
        assert.ok(overflow.result.capture.diagnostic.details.observed > 16384);
      }
      const { result, recording } = await runHDL(file, join(dir, "run"));
      assert.equal(result.ok, true, result.error);
      assert.equal(result.simulation.ok, true);
      assert.deepEqual(result.capture.scopes, ["tb.dut"]);
      assert.equal(recording.status.complete, true);
      assert.ok(recording.design.objects.length < 100);
      const replay = new HDLRecording(recording);
      assert.ok(replay.signals.length > 0);
      assert.ok(replay.signals.every((s) => s.path.startsWith("tb.dut.")));
      assert.ok(recording.events.some((e) => e.kind === "process"));
      assert.ok(recording.events.every((e, i) => e.seq === i));
      const q = replay.signals.find((s) => s.path.endsWith(".q"));
      assert.equal(
        parseInt(replay.snapshot(recording.events.length - 1).signals[q.id], 2),
        4,
      );
      manifest.capture.scopes = ["tb.missing"];
      await writeFile(file, JSON.stringify(manifest));
      const missing = await runHDL(file, join(dir, "missing"));
      assert.equal(missing.result.ok, false);
      assert.equal(missing.result.simulation.ok, true);
      assert.match(
        missing.result.capture.diagnostic.message,
        /scope does not exist/,
      );
      manifest.capture.scopes = ["tb.dut"];
      await writeFile(file, JSON.stringify(manifest));
      const failing =
        language === "verilog"
          ? body.replace("$finish;", '$fatal(1,"OUTSIDE_SCOPE_FAIL");')
          : body.replace(
              "std.env.finish;",
              'assert false report "OUTSIDE_SCOPE_FAIL" severity failure;',
            );
      await writeFile(join(dir, manifest.sources[0]), failing);
      const bad = await runHDL(file, join(dir, "bad"));
      assert.equal(bad.result.ok, false);
      assert.match(bad.result.error, /OUTSIDE_SCOPE_FAIL/);
      assert.ok(bad.recording.events.some((e) => e.kind === "assertion"));
    }
  },
);

test(
  "installed-style FIFO flow proves native correspondence and exposes the deliberate fault directly in job logs/status",
  native,
  async (t) => {
    const root = join(await temporary(t), "fifo");
    await cp(designGuide("rtl").recipe.verificationExample, root, {
      recursive: true,
    });
    const store = new Store(root);
    const job = await waitJob(
      store,
      (await startJob(root, "acceptance", { reuse: false })).id,
      { timeoutMs: 60000 },
    );
    assert.equal(job.state, "completed", JSON.stringify(job));
    assert.equal(job.ready, true, JSON.stringify(job));
    const checks = await checksForTarget(root, "acceptance", job.run);
    assert.ok(checks.required.every((c) => c.verdict === "pass"));
    const run = await verifyEvidence(store, job.run);
    assert.ok(run.artifacts.length > 0);
    await promisify(execFile)("python3", [join(root, "mutate.py"), "apply"]);
    const bad = await waitJob(
      store,
      (await startJob(root, "debug", { reuse: false })).id,
      { timeoutMs: 30000 },
    );
    assert.equal(bad.state, "failed");
    assert.equal(bad.ready, false);
    assert.match(
      (await jobLogs(store, bad.id)).text,
      /\[debug simulate stdout\][\s\S]*LEVEL.*expected=4 actual=5/,
    );
    assert.match(bad.tasks.debug.diagnostic.message, /FATAL:.*LEVEL/);
    assert.equal(
      bad.diagnostics[0].artifact,
      bad.tasks.debug.diagnostic.artifact,
    );
    const report = await inspectArtifact(
      store,
      bad.tasks.debug.diagnostic.artifact,
    );
    assert.equal(report.artifact.path, "native-result.json");
    assert.equal(
      (await targetStatus(root, "debug")).latestJob.diagnostics[0].task,
      "debug",
    );
    await promisify(execFile)("python3", [join(root, "mutate.py"), "restore"]);
    assert.equal((await checksForTarget(root, "acceptance")).ready, true);
  },
);
