import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  chmod,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkbench } from "../src/workbench/service.js";
import { compileImage } from "../src/design/program-image.js";
import { Store, hash } from "../src/design/store.js";
import { waitJob } from "../src/design/jobs.js";
import { compareRuns } from "../src/design/service.js";
import { debugFixture } from "./fixtures/hdl-debug.mjs";
import { HDLRecording } from "../src/hdl/debug/recording.js";
import {
  recordingGraph,
  graphWindow,
  traceWindow,
  netlistGraph,
} from "../src/workbench/inspect.js";
import { validateEngineering } from "../src/design/engineering.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { availableViews } from "../src/tui/views.js";
import { screenText } from "../src/tui/render.js";
import { selectDebugObject } from "../src/tui/debug-state.js";
import { displayWidth } from "../src/tui/text.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-workbench-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, wb: await createWorkbench(root) };
}
const good = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.result;
};

test("root-bound text editing: CAS, concurrent writers, Unicode paging, paths, candidates and invalid drafts", async (t) => {
  const { root, wb } = await setup(t);
  const first = good(
    await wb.call("file_write", {
      path: "rtl/top.sv",
      text: "a😀b\n",
      expectedHash: null,
    }),
  );
  assert.equal(
    good(
      await wb.call("file_read", { path: "rtl/top.sv", offset: 1, limit: 1 }),
    ).text,
    "😀",
  );
  const results = await Promise.all(
    [1, 2].map((n) =>
      wb.call("file_write", {
        path: "rtl/top.sv",
        text: String(n),
        expectedHash: first.sha256,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok).error.code, "EDIT_CONFLICT");
  for (const path of [
    "../outside",
    "/tmp/outside",
    ".git/config",
    ".chipsim/design/x",
    "rtl/../outside",
    "node_modules/a",
  ])
    assert.equal(
      (await wb.call("file_write", { path, text: "no", expectedHash: null }))
        .ok,
      false,
    );
  await symlink("/tmp", join(root, "escape"));
  assert.equal((await wb.call("file_read", { path: "escape/a" })).ok, false);
  await rm(join(root, "escape"));
  const candidate = good(await wb.call("candidate_create", { label: "draft" }));
  const before = good(await wb.call("file_read", { path: "rtl/top.sv" }));
  good(
    await wb.call("file_write", {
      candidate: candidate.id,
      path: "rtl/top.sv",
      text: "invalid HDL draft",
      expectedHash: before.sha256,
    }),
  );
  assert.equal(
    good(await wb.call("file_read", { path: "rtl/top.sv" })).sha256,
    before.sha256,
  );
  assert.equal(
    good(
      await wb.call("file_search", {
        candidate: candidate.id,
        query: "invalid",
      }),
    ).items[0].line,
    1,
  );
  assert.equal(
    (
      await wb.call("validate", {
        candidate: candidate.id,
        target: "simulation",
      })
    ).ok,
    false,
  );
  const revision = good(await wb.call("revision", { candidate: candidate.id }));
  assert.match(revision.revision, /^[a-f0-9]{64}$/);
  assert.equal(
    (await wb.call("file_read", { path: "rtl/top.sv", limit: -1 })).error.code,
    "INVALID_ARGUMENTS",
  );
  assert.equal(
    (await wb.call("file_write", { path: "rtl/top.sv", text: "oops" })).error
      .code,
    "INVALID_ARGUMENTS",
  );
  assert.equal(
    (
      await wb.call("project", {
        candidate: "00000000-0000-0000-0000-000000000000",
      })
    ).ok,
    false,
  );
});

test("immutable evidence inspection shares exact IDs/events/values with terminal at both dimensions", async (t) => {
  const { root, wb } = await setup(t),
    store = new Store(root),
    data = debugFixture(20);
  const payload = await store.putBytes(JSON.stringify(data));
  const artifact = await store.put("artifact", {
    path: "out/debug.json",
    kind: "hdl-debug",
    payload,
    inputs: [],
  });
  const graph = good(
    await wb.call("hardware", {
      artifact: artifact.id,
      object: "p:count",
      relation: "fanin",
    }),
  );
  assert.equal(graph.items[0].from, "s:clk");
  const trace = good(
    await wb.call("trace", { artifact: artifact.id, at: 3, object: "s:count" }),
  );
  assert.equal(trace.values["s:count"], "0001");
  const source = good(
    await wb.call("source", { artifact: artifact.id, source: "src" }),
  );
  assert.equal(source.sha256, hash(data.sources[0].text));
  assert.equal(source.stale, "unknown");
  await writeFile(join(root, "counter.sv"), data.sources[0].text);
  assert.equal(
    good(await wb.call("source", { artifact: artifact.id, source: "src" }))
      .stale,
    false,
  );
  await writeFile(join(root, "counter.sv"), "changed");
  assert.equal(
    good(await wb.call("source", { artifact: artifact.id, source: "src" }))
      .stale,
    true,
  );
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    const result = good(
      await wb.call("snapshot", {
        artifact: artifact.id,
        at: 3,
        object: "s:count",
        columns,
        rows,
      }),
    );
    const state = new TuiState();
    await state.loadDebugFile(store.blobPath(payload.sha256));
    state.seek(3);
    selectDebugObject(state, "s:count");
    state.setView("schematic");
    state.columns = columns;
    state.rows = rows;
    assert.equal(result.text, screenText(state));
    assert.match(result.text, /s:count/);
    assert.match(result.text, /0001/);
    assert.equal(result.text.split("\n").length, rows);
    assert.ok(
      result.text.split("\n").every((line) => displayWidth(line) <= columns),
    );
  }
  assert.equal(
    (await wb.call("trace", { artifact: artifact.id, at: 999 })).error.code,
    "EVENT_RANGE",
  );
  await chmod(store.blobPath(payload.sha256), 0o644);
  await writeFile(store.blobPath(payload.sha256), "corrupt");
  assert.equal(
    (await wb.call("hardware", { artifact: artifact.id })).ok,
    false,
  );
});

test("partial capture and synthesized netlists preserve unknowns and abstraction boundaries", () => {
  const data = debugFixture(10);
  data.status = { complete: false, reason: "event limit" };
  data.events[3].changes["s:count"] = "XZ01";
  const model = recordingGraph(new HDLRecording(data));
  assert.equal(traceWindow(model, { at: 3 }).values["s:count"], "XZ01");
  assert.equal(traceWindow(model, { at: 3 }).capture.complete, false);
  const netlist = netlistGraph({
    modules: {
      top: {
        ports: {
          a: { direction: "input", bits: [2] },
          q: { direction: "output", bits: [3] },
        },
        netnames: { a: { bits: [2] }, q: { bits: [3] } },
        cells: {
          inv: {
            type: "$not",
            port_directions: { A: "input", Y: "output" },
            connections: { A: [2], Y: [3] },
          },
        },
      },
    },
  });
  assert.equal(netlist.abstraction, "synthesized-module-definitions");
  assert.equal(
    graphWindow(netlist, { object: "y:top/cell/inv", relation: "fanin" })
      .items[0].kind,
    "reads",
  );
  assert.throws(() => traceWindow(netlist), /no recorded events/);
  assert.equal(netlist.capabilities.nextState, "unsupported");
});

test("source freshness uses the captured nested HDL origin and ignores root namesakes and live task edits", async (t) => {
  const { root, wb } = await setup(t),
    store = new Store(root),
    data = debugFixture(10),
    text = data.sources[0].text;
  await mkdir(join(root, "sim"));
  await writeFile(join(root, "counter.sv"), text);
  await writeFile(join(root, "sim/counter.sv"), text);
  const input = { path: "sim/counter.sv", ...(await store.putBytes(text)) };
  const snapshot = await store.put("input-snapshot", {
    config: {
      tasks: {
        simulate: { adapter: "hdl", options: { project: "sim/run.json" } },
      },
    },
    inputs: [input],
  });
  const artifact = await store.put("artifact", {
    path: "out/debug.json",
    kind: "hdl-debug",
    payload: await store.putBytes(JSON.stringify(data)),
    snapshot: snapshot.id,
    producer: { task: "simulate" },
    inputs: [input],
  });
  const source = async () =>
    good(await wb.call("source", { artifact: artifact.id, source: "src" }));
  assert.equal((await source()).currentPath, "sim/counter.sv");
  assert.equal((await source()).stale, false);
  await writeFile(
    join(root, "sim/counter.sv"),
    text + "// changed actual source\n",
  );
  // Live configuration is an invalid draft; provenance still comes from the capture.
  await writeFile(join(root, "chipsim.design.json"), "{ draft");
  assert.equal((await source()).stale, true);
  assert.equal(
    (await source()).currentHash,
    hash(text + "// changed actual source\n"),
  );
  await rm(join(root, "sim/counter.sv"));
  assert.equal((await source()).stale, "unknown");
  assert.equal((await source()).currentHash, null);
  assert.equal((await source()).text, text);
  // Generated or unmapped source names must not acquire freshness from a namesake.
  const generated = await store.put("artifact", {
    ...artifact,
    inputs: [],
  });
  const unresolved = good(
    await wb.call("source", { artifact: generated.id, source: "src" }),
  );
  assert.equal(unresolved.currentPath, null);
  assert.equal(unresolved.stale, "unknown");
});

test("accepted request replay survives missing/invalid manifests and preserves conflicts without launching another job", async (t) => {
  const { root, wb } = await setup(t),
    store = new Store(root),
    config = JSON.stringify({
      format: "chipsim-design",
      version: 1,
      id: "requests",
      tasks: {
        run: {
          adapter: "command",
          options: {
            command: process.execPath,
            args: ["-e", "console.log('accepted')"],
          },
        },
      },
      targets: { test: { tasks: ["run"], requiredChecks: ["run:execution"] } },
    }),
    lock = JSON.stringify({
      format: "chipsim-lock",
      version: 1,
      dependencies: [],
    });
  await writeFile(join(root, "chipsim.design.json"), config);
  await writeFile(join(root, "chipsim.lock.json"), lock);
  const args = { target: "test", requestId: "durable" },
    accepted = good(await wb.call("job_start", args));
  const finished = await waitJob(store, accepted.id, { timeoutMs: 20000 });
  assert.equal(finished.state, "completed", JSON.stringify(finished));
  for (const path of ["chipsim.design.json", "chipsim.lock.json"]) {
    for (const draft of ["{ incomplete", null]) {
      if (draft === null) await rm(join(root, path));
      else await writeFile(join(root, path), draft);
      const replay = good(
        await (await createWorkbench(root)).call("job_start", args),
      );
      assert.equal(replay.id, accepted.id);
      assert.equal(replay.run, finished.run);
      assert.equal(replay.deduplicated, true);
      for (const changed of [{ target: "other" }, { reuse: false }])
        assert.equal(
          (await wb.call("job_start", { ...args, ...changed })).error.code,
          "REQUEST_CONFLICT",
        );
      assert.equal(
        (await wb.call("job_start", { ...args, requestId: "new" })).ok,
        false,
      );
    }
    await writeFile(
      join(root, path),
      path === "chipsim.design.json" ? config : lock,
    );
  }
  const removedTarget = JSON.parse(config);
  removedTarget.targets = { other: removedTarget.targets.test };
  await writeFile(
    join(root, "chipsim.design.json"),
    JSON.stringify(removedTarget),
  );
  assert.equal(good(await wb.call("job_start", args)).id, accepted.id);
  assert.equal((await store.list("run")).length, 1);
});

test("metric deltas require meaningful explicit matching contexts, scopes and units", async (t) => {
  const { root } = await setup(t),
    store = new Store(root);
  const makeRun = async (
    context,
    observed,
    unit = "ns",
    scope = "Reported timing",
  ) => {
    const check = await store.put("check", {
      subject: { task: "physical" },
      name: "timing",
      verdict: "pass",
      scope,
      context,
      metrics: [{ field: "delay", unit, observed }],
      evidence: [],
    });
    return (
      await store.put("run", {
        artifacts: [],
        attempts: [],
        checks: [check.id],
      })
    ).id;
  };
  for (const context of [
    undefined,
    null,
    {},
    [],
    "",
    { stage: null },
    { constraints: [], units: {} },
  ]) {
    const left = await makeRun(context, 1),
      right = await makeRun(context, 2);
    const comparison = (await compareRuns(store, left, right)).checks[0];
    assert.equal(comparison.matchingReportedContext, false);
    assert.equal(comparison.metrics[0].comparable, false);
    assert.equal(comparison.metrics[0].delta, null);
    assert.equal(comparison.metrics[0].left, 1);
    assert.equal(comparison.metrics[0].right, 2);
  }
  const context = {
    stage: "final",
    corner: "nom",
    constraints: [{ path: "clock.sdc", sha256: "fixed" }],
  };
  const left = await makeRun(context, 1),
    right = await makeRun(structuredClone(context), 2);
  const matched = (await compareRuns(store, left, right)).checks[0];
  assert.equal(matched.matchingReportedContext, true);
  assert.equal(matched.metrics[0].comparable, true);
  assert.equal(matched.metrics[0].delta, 1);
  for (const other of [
    await makeRun({ ...context, corner: "slow" }, 2),
    await makeRun(context, 2, "ps"),
    await makeRun(context, 2, "ns", "Different timing scope"),
  ]) {
    const compared = (await compareRuns(store, left, other)).checks[0];
    assert.equal(compared.metrics[0].comparable, false);
    assert.equal(compared.metrics[0].delta, null);
  }
});

test("program image validation rejects unsupported operations, capacity, schedule and resource use", async () => {
  const fixture = new URL(
    "../examples/workbench/programmable/",
    import.meta.url,
  );
  const contract = JSON.parse(
    await readFile(new URL("contract.json", fixture), "utf8"),
  );
  const program = JSON.parse(
    await readFile(new URL("program.json", fixture), "utf8"),
  );
  assert.deepEqual(compileImage(contract, program).words, [17, 18, 19, 20]);
  for (const [code, edit] of [
    ["UNSUPPORTED_OPCODE", (p) => (p.instructions[0].op = "wait")],
    ["OPERAND_RANGE", (p) => (p.instructions[0].value = 16)],
    ["UNSUPPORTED_SCHEDULE", (p) => (p.instructions[1].cycle = 5)],
    ["IMAGE_CAPACITY", (p) => p.instructions.push(p.instructions[0])],
  ]) {
    const p = structuredClone(program);
    edit(p);
    const result = compileImage(contract, p);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((d) => d.code === code));
  }
  const c = structuredClone(contract);
  c.instructions.add.cycles = 2;
  assert.ok(
    compileImage(c, program).diagnostics.some(
      (d) => d.code === "RESOURCE_CONFLICT",
    ),
  );
  assert.deepEqual(
    contract,
    JSON.parse(await readFile(new URL("contract.json", fixture), "utf8")),
  );
  assert.throws(
    () => validateEngineering({ roles: { hardware: ["../private"] } }),
    /relative path/,
  );
});

test("static netlist terminal inspection links real ports, preserves failed imports and navigates connections", async (t) => {
  const { root, wb } = await setup(t),
    store = new Store(root);
  const data = {
    modules: {
      top: {
        ports: {
          a: { direction: "input", bits: [2] },
          q: { direction: "output", bits: [3] },
        },
        cells: {
          inv: {
            type: "$not",
            port_directions: { A: "input", Y: "output" },
            connections: { A: [2], Y: [3] },
          },
        },
      },
    },
  };
  const payload = await store.putBytes(JSON.stringify(data));
  const artifact = await store.put("artifact", {
    path: "netlist.json",
    kind: "netlist",
    payload,
    inputs: [],
  });
  const state = new TuiState();
  await state.loadNetlistFile(store.blobPath(payload.sha256));
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    const result = good(
      await wb.call("snapshot", { artifact: artifact.id, columns, rows }),
    );
    assert.equal(result.text, screenText(state));
    assert.match(result.text, /synthesized netlist/);
    assert.ok(
      result.text.split("\n").every((line) => displayWidth(line) <= columns),
    );
  }
  const { schematicKey } = await import("../src/tui/schematic.js");
  const app = {
    state,
    menu: (_title, items, select) => {
      assert.ok(items.length);
      select(items[0].value);
    },
  };
  schematicKey(app, "j", { name: "j" });
  const selected = state.netlistSelection;
  schematicKey(app, "", { name: "return" });
  assert.notEqual(state.netlistSelection, selected);
  const previous = state.netlistGraph;
  await writeFile(join(root, "bad.json"), "{}");
  await assert.rejects(() => state.loadNetlistFile(join(root, "bad.json")));
  assert.equal(state.netlistGraph, previous);
});

test("netlist shortcuts cannot expose, replay, edit or export the preserved simulation", async (t) => {
  const { root } = await setup(t),
    file = join(root, "netlist.json"),
    state = new TuiState();
  await writeFile(
    file,
    JSON.stringify({
      modules: { top: { ports: { q: { direction: "output", bits: [2] } } } },
    }),
  );
  state.rebuild();
  state.seek(17);
  const original = {
    trace: state.trace,
    tick: state.tick,
    model: state.model,
    config: JSON.stringify(state.config),
  };
  await state.loadNetlistFile(file);
  const app = new TerminalApp(state);
  app.draw = () => {};
  const unchanged = () => {
    assert.equal(state.trace, original.trace);
    assert.equal(state.tick, original.tick);
    assert.equal(state.model, original.model);
    assert.equal(JSON.stringify(state.config), original.config);
    assert.equal(state.playing, false);
    assert.equal(state.menu ?? null, null);
    assert.equal(state.prompt ?? null, null);
    assert.equal(state.traceDetail, null);
  };
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    state.columns = columns;
    state.rows = rows;
    for (const key of [
      "1",
      "2",
      "3",
      "9",
      "g",
      "v",
      "D",
      "O",
      "I",
      "r",
      " ",
      "N",
      "J",
      "S",
      "x",
      "p",
      "i",
      "P",
      "t",
      "]",
      "[",
    ]) {
      app.key(key, { name: key === " " ? "space" : key });
      assert.equal(state.view, "schematic", key);
      unchanged();
    }
    state.setView("wave");
    assert.equal(state.view, "schematic");
    const screen = screenText(state);
    assert.match(screen, /synthesized netlist/);
    assert.doesNotMatch(screen, /DATA|Selected: data|HDL SOURCE/);
    assert.equal(screen.split("\n").length, rows);
    assert.ok(
      screen.split("\n").every((line) => displayWidth(line) <= columns),
    );
  }
  app.key("H", { name: "H" });
  assert.ok(state.menu);
  assert.ok(!state.menu.items.some((item) => item.value === "compare"));
  app.key("", { name: "escape" });
  unchanged();
  state.design = {};
  assert.deepEqual(availableViews(state), [
    "schematic",
    "project",
    "pipeline",
    "artifacts",
    "checks",
  ]);
  app.key("\t", { name: "tab" });
  assert.equal(state.view, "project");
  app.key("1", { name: "1" });
  app.key(" ", { name: "space" });
  assert.equal(state.view, "project");
  unchanged();
  assert.throws(() => state.selectModel("nonexistent"), /Unknown model/);
  assert.ok(state.netlistGraph);
  state.selectModel("pio");
  assert.equal(state.netlistGraph, null);
  assert.equal(state.view, "wave");
  app.key(" ", { name: "space" });
  assert.equal(state.playing, true);
});

test("physical verdicts require captured constraints and native report integrity; failed and skipped checks remain explicit", async (t) => {
  const { root } = await setup(t);
  const { mkdir } = await import("node:fs/promises");
  const { fileDigest } = await import("../src/design/store.js");
  const { tinyTapeoutChecks } = await import("../src/design/tinytapeout.js");
  for (const path of ["out", "runs/wokwi/final", "tt/precheck/reports"])
    await mkdir(join(root, path), { recursive: true });
  const metrics = {
    timing__setup_vio__count: 0,
    timing__hold_vio__count: 0,
    klayout__drc_error__count: 0,
    design__lvs_error__count: 0,
    timing__setup__ws: 1,
    timing__hold__ws: 0.2,
    design__instance__area__stdcell: 120,
    design__instance__count__stdcell: 20,
  };
  await writeFile(
    join(root, "runs/wokwi/final/metrics.json"),
    JSON.stringify(metrics),
  );
  await writeFile(
    join(root, "runs/wokwi/resolved.json"),
    JSON.stringify({ STA_CORNERS: ["nom"] }),
  );
  await writeFile(
    join(root, "runs/wokwi/final/timing.sdc"),
    "create_clock -period 20 [get_ports clk]",
  );
  const sources = await Promise.all(
    [
      "runs/wokwi/final/metrics.json",
      "runs/wokwi/resolved.json",
      "runs/wokwi/final/timing.sdc",
    ].map(async (path) => ({ path, ...(await fileDigest(join(root, path))) })),
  );
  const report = { metrics, sources, corners: ["nom"] };
  await writeFile(join(root, "out/physical.json"), JSON.stringify(report));
  await writeFile(
    join(root, "tt/precheck/reports/results.xml"),
    '<testsuite tests="1"><testcase name="native"/></testsuite>',
  );
  const task = {
    definition: {
      options: {
        pdk: "ihp-sg13cmos5l",
        image: "pinned",
        pdkRevision: "pinned",
        supportRevision: "pinned",
      },
    },
    dependencies: [],
  };
  const check = async () => tinyTapeoutChecks(task, root, { ok: true });
  assert.ok((await check()).every((c) => c.verdict === "pass"));
  report.sources = sources.filter((s) => !s.path.endsWith(".sdc"));
  await writeFile(join(root, "out/physical.json"), JSON.stringify(report));
  assert.equal(
    (await check()).find((c) => c.name === "timing").verdict,
    "inconclusive",
  );
  report.sources = sources;
  report.metrics = { ...metrics, klayout__drc_error__count: 1 };
  await writeFile(join(root, "out/physical.json"), JSON.stringify(report));
  assert.equal((await check()).find((c) => c.name === "drc").verdict, "fail");
  await writeFile(
    join(root, "runs/wokwi/resolved.json"),
    "changed after normalization",
  );
  assert.ok(
    (await check())
      .filter((c) => ["timing", "drc", "lvs"].includes(c.name))
      .every((c) => c.verdict === "inconclusive"),
  );
  await writeFile(
    join(root, "tt/precheck/reports/results.xml"),
    '<testsuite tests="1" skipped="1"><testcase name="native"><skipped/></testcase></testsuite>',
  );
  assert.equal(
    (await check()).find((c) => c.name === "precheck").verdict,
    "inconclusive",
  );
});

test("evidence closure verifies shared payloads once per query and rechecks on the next query", async (t) => {
  const { root } = await setup(t),
    store = new Store(root);
  const { verifyEvidence } = await import("../src/design/evidence.js");
  const payload = await store.putBytes("shared source");
  const snapshot = await store.put("input-snapshot", {
    inputs: [{ path: "source.txt", ...payload }],
  });
  const artifacts = await Promise.all(
    ["a.txt", "b.txt"].map((path) =>
      store.put("artifact", {
        path,
        payload,
        snapshot: snapshot.id,
        inputs: [{ path: "source.txt", ...payload }],
      }),
    ),
  );
  const run = await store.put("run", {
    snapshot: snapshot.id,
    artifacts: artifacts.map((a) => a.id),
    attempts: [],
    checks: [],
  });
  const original = store.verifyBlob.bind(store);
  let reads = 0;
  store.verifyBlob = async (blob) => {
    reads++;
    return original(blob);
  };
  await verifyEvidence(store, run.id);
  assert.equal(reads, 1);
  await verifyEvidence(store, run.id);
  assert.equal(reads, 2);
  await chmod(store.blobPath(payload.sha256), 0o644);
  await writeFile(store.blobPath(payload.sha256), "corrupt");
  await assert.rejects(() => verifyEvidence(store, run.id), /integrity/);
});

test("captured source revisions export and import with their complete payload inventory", async (t) => {
  const { root, wb } = await setup(t);
  good(
    await wb.call("file_write", {
      path: "top.sv",
      text: "module top; endmodule\n",
      expectedHash: null,
    }),
  );
  const revision = good(await wb.call("revision"));
  const { exportEvidence, importEvidence, verifyEvidence } =
    await import("../src/design/evidence.js");
  const destination = await mkdtemp(join(tmpdir(), "chipsim-revision-export-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const bundle = await exportEvidence(
    new Store(root),
    revision.revision,
    join(destination, "bundle"),
  );
  const imported = new Store(join(destination, "project"));
  await importEvidence(imported, bundle.bundle);
  const record = await verifyEvidence(imported, revision.revision);
  assert.equal(record.format, "chipsim-workbench-revision");
  assert.equal(record.inputs.length, 1);
  assert.equal(
    await readFile(imported.blobPath(record.inputs[0].sha256), "utf8"),
    "module top; endmodule\n",
  );
});
