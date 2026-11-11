import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { collectDebugRecording } from "../src/hdl/debug/collector.js";
import { processRun, runHDL } from "../src/hdl/run.js";
import { sourceDigest } from "../src/hdl/debug/recording.js";

const jsonl = (records) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
function capture(events, scoped = true) {
  return collectDebugRecording({
    project: {
      language: "verilog",
      top: "tb",
      ...(scoped ? { capture: { scopes: ["tb.dut"] } } : {}),
    },
    sourceRoot: "/tmp",
    sources: [
      {
        id: "source",
        path: "tb.sv",
        text: "module tb;\nendmodule\n",
        sha256: sourceDigest("module tb;\nendmodule\n"),
      },
    ],
    tools: [],
    stages: [{ stage: "simulate", ok: true }],
    design: jsonl([
      { record: "design", protocol: 1, instrumentation: "chipsim-1" },
      { record: "object", id: "b:tb", kind: "instance", path: "tb" },
      { record: "object", id: "b:dut", kind: "instance", path: "tb.dut" },
      {
        record: "object",
        id: "p:dut",
        kind: "process",
        scope: "tb.dut",
        processType: 0,
      },
      {
        record: "object",
        id: "p:tb",
        kind: "process",
        scope: "tb",
        processType: 0,
      },
      {
        record: "object",
        id: "s:dut",
        kind: "signal",
        path: "tb.dut.q",
        width: 1,
      },
      { record: "object", id: "s:tb", kind: "signal", path: "tb.q", width: 1 },
      { record: "design-end" },
    ]),
    stream: jsonl([
      {
        record: "header",
        protocol: 1,
        instrumentation: "chipsim-1",
        backend: "iverilog-12.0",
        precision: -9,
      },
      { record: "observe", id: "s:dut", width: 1 },
      { record: "observe", id: "s:tb", width: 1 },
      ...events.map((e) => ({ record: "event", ...e })),
      { record: "end", events: events.length },
    ]),
  });
}

test("validate every raw event against the full graph before scope projection", () => {
  const good = [
    {
      seq: 0,
      time: "0",
      kind: "initialize",
      changes: { "s:dut": "0", "s:tb": "0" },
    },
    { seq: 1, time: "1", kind: "process", process: "p:tb" },
    { seq: 2, time: "2", kind: "signal", changes: { "s:tb": "1" } },
    { seq: 3, time: "3", kind: "process", process: "p:dut" },
    { seq: 4, time: "4", kind: "signal", changes: { "s:dut": "1" } },
    { seq: 5, time: "5", kind: "assertion", message: "outside assertion" },
  ];
  const valid = capture(good);
  assert.equal(valid.status.complete, true);
  assert.deepEqual(
    valid.events.map((e) => e.observerSeq),
    [0, 3, 4, 5],
  );
  assert.deepEqual(
    valid.events.map((e) => e.seq),
    [0, 1, 2, 3],
  );
  assert.equal(valid.events.at(-1).message, "outside assertion");
  assert.deepEqual(valid.events[0].changes, { "s:dut": "0" });
  const mutations = [
    [
      "missing first event",
      (e) => {
        e[0].seq = 25;
      },
    ],
    [
      "duplicate outside sequence",
      (e) => {
        e[1].seq = 0;
      },
    ],
    [
      "unknown process",
      (e) => {
        e[1].process = "p:missing";
      },
    ],
    [
      "signal used as process",
      (e) => {
        e[1].process = "s:tb";
      },
    ],
    [
      "unknown writer",
      (e) => {
        e[2].writer = "p:missing";
      },
    ],
    [
      "unknown signal",
      (e) => {
        e[2].changes = { "s:missing": "1" };
      },
    ],
    [
      "outside value width",
      (e) => {
        e[2].changes = { "s:tb": "01" };
      },
    ],
    [
      "outside value alphabet",
      (e) => {
        e[2].changes = { "s:tb": "2" };
      },
    ],
    [
      "backward outside time",
      (e) => {
        e[2].time = "0";
      },
    ],
    [
      "outside invalid phase",
      (e) => {
        e[2].phase = 7;
      },
    ],
    [
      "outside invalid delta",
      (e) => {
        e[2].delta = -1;
      },
    ],
    [
      "outside invalid kind",
      (e) => {
        e[2].kind = "invented";
      },
    ],
    [
      "outside invalid mapped source",
      (e) => {
        e[2].source = { file: "tb.sv", line: 999 };
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const events = structuredClone(good);
    mutate(events);
    for (const scoped of [false, true])
      assert.throws(
        () => capture(events, scoped),
        /HDL debug:/,
        `${name}, scoped=${scoped}`,
      );
  }
});

test("successful child completion stops execution timeout and cancellation before draining slow logs", async () => {
  const controller = new AbortController();
  let abort;
  const result = await processRun(
    process.execPath,
    ["-e", "console.log('done')"],
    {
      timeoutMs: 500,
      signal: controller.signal,
      onOutput: async () => {
        abort = setTimeout(() => controller.abort(), 600);
        await new Promise((done) => setTimeout(done, 850));
      },
    },
  );
  clearTimeout(abort);
  assert.equal(result.code, 0);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reason, null);
  const timed = await processRun(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeoutMs: 100 },
  );
  assert.equal(timed.ok, false);
  assert.equal(timed.reason, "timeout");
});

const native = {
  skip: process.env.CHIPSIM_TEST_HDL_DEBUG !== "1",
  timeout: 120000,
};
test(
  "a 16000-process scoped design fits the native budget without an oversized environment variable",
  native,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-process-selection-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "tb.sv"),
      "module tb;\n" + "initial begin #1; end\n".repeat(16000) + "endmodule\n",
    );
    const project = {
      format: "chipsim-hdl-project",
      version: 1,
      language: "verilog",
      standard: "2012",
      top: "tb",
      sources: ["tb.sv"],
    };
    const file = join(root, "project.json");
    await writeFile(file, JSON.stringify(project));
    const all = await runHDL(file, join(root, "all"));
    assert.equal(all.result.ok, true, all.result.error);
    project.capture = { scopes: ["tb"] };
    await writeFile(file, JSON.stringify(project));
    const scoped = await runHDL(file, join(root, "scoped"));
    assert.equal(scoped.result.ok, true, scoped.result.error);
    assert.equal(scoped.recording.status.complete, true);
    assert.equal(
      scoped.recording.design.objects.filter((o) => o.kind === "process")
        .length,
      16000,
    );
    assert.equal(
      scoped.recording.events.filter((e) => e.kind === "process").length,
      all.recording.events.filter((e) => e.kind === "process").length,
    );
    assert.equal(scoped.recording.events.length, all.recording.events.length);
    const selection = await readFile(
      scoped.result.artifacts.processSelection,
      "utf8",
    );
    assert.equal(selection.split("\n").length, 16003);
    assert.equal(selection.split("\n")[0], "chipsim-capture-processes-v1");
    assert.equal(selection.split("\n")[1], "16000");
  },
);

test(
  "missing or malformed native process selections fail capture and preserve diagnostics",
  native,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-bad-selection-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "tb.sv"),
      "module tb; generate begin:dut reg q=0; initial #1 q=1; end endgenerate initial #2 $finish; endmodule\n",
    );
    const project = join(root, "project.json");
    await writeFile(
      project,
      JSON.stringify({
        format: "chipsim-hdl-project",
        version: 1,
        language: "verilog",
        standard: "2012",
        top: "tb",
        sources: ["tb.sv"],
        capture: { scopes: ["tb.dut"] },
      }),
    );
    const mutations = [
      ["missing", (file) => unlinkSync(file)],
      ["header", (file) => writeFileSync(file, "bad-header\n")],
      [
        "missing-row",
        (file) =>
          writeFileSync(file, "chipsim-capture-processes-v1\n2\np:T_1\n"),
      ],
      [
        "invalid-count",
        (file) => writeFileSync(file, "chipsim-capture-processes-v1\n-1\n"),
      ],
      [
        "truncated",
        (file) => writeFileSync(file, "chipsim-capture-processes-v1\n1\np:T_1"),
      ],
      [
        "invalid-id",
        (file) =>
          writeFileSync(
            file,
            "chipsim-capture-processes-v1\n1\nnot-a-process\n",
          ),
      ],
      [
        "duplicate",
        (file) =>
          writeFileSync(
            file,
            "chipsim-capture-processes-v1\n2\np:T_1\np:T_1\n",
          ),
      ],
      [
        "oversized",
        (file) =>
          writeFileSync(
            file,
            "chipsim-capture-processes-v1\n1\np:T_" + "1".repeat(256) + "\n",
          ),
      ],
      [
        "count",
        (file) =>
          writeFileSync(
            file,
            "chipsim-capture-processes-v1\n16385\n" +
              Array.from({ length: 16385 }, (_, i) => `p:T_${i}\n`).join(""),
          ),
      ],
    ];
    for (const [name, mutate] of mutations) {
      const out = join(root, name);
      const run = await runHDL(project, out, {
        onProgress: (stage) => {
          if (stage === "simulate") mutate(join(out, "capture-processes.txt"));
        },
      });
      assert.equal(run.result.ok, false, name);
      assert.equal(run.result.simulation.ok, true, name);
      assert.equal(run.result.capture.ok, false, name);
      assert.match(
        run.result.error,
        /missing or malformed capture process selection file/,
        name,
      );
      assert.equal(run.recording.status.complete, false, name);
      assert.ok(run.recording.sources.length > 0, name);
      assert.equal(
        JSON.parse(await readFile(run.result.artifacts.result, "utf8")).ok,
        false,
      );
    }
    await writeFile(
      join(root, "tb.sv"),
      "module tb; reg drive=0; initial begin #1 drive=1; #1 $finish; end generate begin:dut wire q=~drive; end endgenerate endmodule\n",
    );
    const combinational = await runHDL(project, join(root, "combinational"));
    assert.equal(combinational.result.ok, true, combinational.result.error);
    assert.equal(
      await readFile(combinational.result.artifacts.processSelection, "utf8"),
      "chipsim-capture-processes-v1\n0\n",
    );
  },
);
