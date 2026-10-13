import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  chmod,
  symlink,
  cp,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store, identity, json } from "../src/design/store.js";
import { planDesign, dependencyIdentity } from "../src/design/project.js";
import {
  startJob,
  waitJob,
  jobStatus,
  cancelJob,
  retryJob,
  jobLogs,
  jobPath,
} from "../src/design/jobs.js";
import {
  verifyEvidence,
  exportEvidence,
  importEvidence,
} from "../src/design/evidence.js";
import {
  checksForTarget,
  projectSummary,
  targetStatus,
  compareRuns,
} from "../src/design/service.js";
import { normalizeChecks } from "../src/design/adapters.js";
import { designCommand } from "../src/design/cli.js";
import { DesignPanel, designRows } from "../src/tui/design-panel.js";
import { TuiState } from "../src/tui/state.js";
import { screenText } from "../src/tui/render.js";
import { displayWidth } from "../src/tui/text.js";

const cli = new URL("../scripts/chipsim.mjs", import.meta.url).pathname;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-design-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "before");
  await writeFile(join(root, "timing.sdc"), "create_clock -period 10");
  await writeFile(
    join(root, "task.mjs"),
    `import {readFile,writeFile,mkdir} from 'node:fs/promises';
await new Promise(r=>setTimeout(r,Number(process.argv[2]||0)));
await mkdir('out',{recursive:true});
await writeFile('out/result.json',JSON.stringify({value:await readFile('source.txt','utf8')}));
console.log('task finished');
`,
  );
  const config = {
    format: "chipsim-design",
    version: 1,
    id: "fixture",
    tasks: {
      sim: {
        adapter: "command",
        inputs: ["source.txt", "task.mjs"],
        options: {
          command: process.execPath,
          args: ["task.mjs", String(options.delay || 0)],
        },
        outputs: [{ path: "out/result.json", kind: "report" }],
        checks: [
          {
            name: "value",
            path: "out/result.json",
            field: "value",
            operator: "eq",
            value: "before",
            scope: "Captured fixture value",
          },
        ],
      },
    },
    targets: {
      sim: { tasks: ["sim"], requiredChecks: ["sim:value", "sim:outputs"] },
    },
  };
  await writeFile(join(root, "chipsim.design.json"), JSON.stringify(config));
  await writeFile(
    join(root, "chipsim.lock.json"),
    JSON.stringify({ format: "chipsim-lock", version: 1, dependencies: [] }),
  );
  return { root, store: new Store(root), config };
}
async function finish(f, job) {
  const state = await waitJob(f.store, job.id, { timeoutMs: 15000 });
  assert.ok(
    ["completed", "failed", "cancelled", "interrupted"].includes(state.state),
    JSON.stringify(state),
  );
  return state;
}
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await pause(30);
  }
  throw new Error("Timed out");
}

test("snapshots execute captured dirty files, reuse unchanged tasks, and detect relevant edits", async (t) => {
  const f = await fixture(t, { delay: 400 });
  const job = await startJob(f.root, "sim");
  await writeFile(join(f.root, "source.txt"), "after");
  const finished = await finish(f, job);
  assert.equal(finished.state, "completed");
  assert.equal(finished.ready, true);
  const run = await verifyEvidence(f.store, finished.run);
  const artifacts = await Promise.all(
    run.artifacts.map((id) => f.store.get(id)),
  );
  const report = artifacts.find((a) => a.path === "out/result.json");
  assert.equal(
    (await json(f.store.blobPath(report.payload.sha256))).value,
    "before",
  );
  assert.equal((await checksForTarget(f.root, "sim")).ready, false);
  assert.equal(
    (await checksForTarget(f.root, "sim")).required[0].verdict,
    "stale",
  );
  await writeFile(join(f.root, "source.txt"), "before");
  await writeFile(join(f.root, "timing.sdc"), "unrelated edit");
  assert.equal((await projectSummary(f.root)).runs[0].stale, false);
  const reused = await finish(f, await startJob(f.root, "sim"));
  assert.equal(reused.tasks.sim.state, "reused");
  assert.equal(
    (await compareRuns(f.store, finished.run, reused.run)).artifacts.every(
      (a) => a.change === "identical",
    ),
    true,
  );
});

test("a closed CLI leaves an accepted job running; cancellation retains partial evidence", async (t) => {
  const f = await fixture(t, { delay: 2500 });
  const { stdout } = await promisify(execFile)(process.execPath, [
    cli,
    "design",
    "run",
    "--project",
    f.root,
  ]);
  const accepted = JSON.parse(stdout);
  assert.equal(accepted.accepted, true);
  await until(
    async () =>
      (await jobStatus(f.store, accepted.job.id)).tasks.sim?.state ===
      "running",
  );
  await cancelJob(f.store, accepted.job.id);
  const cancelled = await finish(f, accepted.job);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.ready, false);
  const run = await verifyEvidence(f.store, cancelled.run);
  assert.ok(run.artifacts.length > 0);
  const retried = await retryJob(f.store, accepted.job.id);
  await writeFile(join(f.root, "source.txt"), "changed after cancellation");
  const complete = await finish(f, retried);
  assert.equal(complete.id, accepted.job.id);
  assert.equal(complete.generation, 2);
  assert.equal(complete.ready, true);
  assert.ok(complete.attempts.length > cancelled.attempts.length);
});

test("worker crashes are recovered and retried without changing the input snapshot", async (t) => {
  const f = await fixture(t, { delay: 1500 });
  const job = await startJob(f.root, "sim");
  let running;
  await until(async () => {
    running = await jobStatus(f.store, job.id);
    return running.tasks.sim?.state === "running";
  });
  process.kill(running.owner.pid, "SIGKILL");
  await until(
    async () => (await jobStatus(f.store, job.id)).state === "interrupted",
  );
  const retried = await retryJob(f.store, job.id);
  assert.equal(retried.snapshot, job.snapshot);
  assert.equal((await finish(f, retried)).ready, true);
});

test("dependency outputs are materialized from verified artifacts and changes invalidate consumers only", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "consume.mjs"),
    `import {readFile,writeFile,mkdir} from 'node:fs/promises'; await mkdir('out'); await writeFile('out/copy.json',await readFile('generated.json'));`,
  );
  f.config.tasks.consume = {
    adapter: "command",
    inputs: ["consume.mjs", "timing.sdc"],
    bindings: [
      { task: "sim", output: "out/result.json", path: "generated.json" },
    ],
    options: { command: process.execPath, args: ["consume.mjs"] },
    outputs: [{ path: "out/copy.json", kind: "report" }],
  };
  f.config.targets.sim.tasks = ["consume"];
  await writeFile(
    join(f.root, "chipsim.design.json"),
    JSON.stringify(f.config),
  );
  const run = await finish(f, await startJob(f.root, "sim"));
  assert.equal(run.state, "completed");
  await writeFile(join(f.root, "timing.sdc"), "different timing");
  const current = (await projectSummary(f.root)).runs[0];
  assert.deepEqual(current.taskFreshness, [
    { task: "sim", stale: false },
    { task: "consume", stale: true },
  ]);
  const next = await finish(f, await startJob(f.root, "sim"));
  assert.equal(next.tasks.sim.state, "reused");
  assert.equal(next.tasks.consume.state, "completed");
});

test("evidence bundles inspect offline; tampered payloads or records fail verification", async (t) => {
  const f = await fixture(t),
    run = await finish(f, await startJob(f.root, "sim"));
  const exported = join(f.root, "exported");
  await exportEvidence(f.store, run.run, exported);
  const second = await fixture(t);
  await importEvidence(second.store, exported);
  await verifyEvidence(second.store, run.run);
  const incomplete = join(f.root, "incomplete-bundle");
  await cp(exported, incomplete, { recursive: true });
  const manifest = await json(join(incomplete, "bundle.json"));
  manifest.objects.pop();
  await writeFile(join(incomplete, "bundle.json"), JSON.stringify(manifest));
  const emptyStore = new Store(join(f.root, "empty-import"));
  await assert.rejects(
    importEvidence(emptyStore, incomplete),
    /complete evidence closure/,
  );
  await assert.rejects(emptyStore.get(run.run), { code: "ENOENT" });
  const record = await f.store.get(run.run),
    artifact = await f.store.get(record.artifacts[0]);
  const blob = f.store.blobPath(artifact.payload.sha256);
  await chmod(blob, 0o644);
  await writeFile(blob, "changed");
  await assert.rejects(verifyEvidence(f.store, run.run), /integrity/);
  await assert.rejects(
    exportEvidence(f.store, run.run, join(f.root, "bad-export")),
    /integrity/,
  );
  const file = second.store.recordPath(run.run);
  await chmod(file, 0o644);
  await writeFile(file, JSON.stringify({ ...record, state: "failed" }));
  await assert.rejects(verifyEvidence(second.store, run.run), /integrity/);
});

test("historical imports never manufacture provenance or reusable checks", async (t) => {
  const f = await fixture(t),
    older = join(f.root, "older");
  await mkdir(older);
  await writeFile(join(older, "result.json"), '{"ok":true}');
  const imported = await importEvidence(f.store, older),
    record = await f.store.get(imported.id);
  assert.equal(record.provenance, "unknown");
  assert.equal(record.reusable, false);
  assert.deepEqual(record.checks, []);
});

test("empty tests, solver timeouts, missing outputs and changed policy cannot falsely pass", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "results.xml"),
    '<testsuite tests="0"></testsuite>',
  );
  const tests = await normalizeChecks(
    { definition: { adapter: "cocotb" } },
    f.root,
    { ok: true },
  );
  assert.equal(tests.find((c) => c.name === "tests").verdict, "inconclusive");
  for (const xml of [
    '<testsuite tests="2"><testcase name="passed"/></testsuite>',
    '<testsuite failures="1"><testcase name="passed"/></testsuite>',
    '<testsuite><error message="fixture failed"/><testcase name="passed"/></testsuite>',
    '<testsuite tests="2"><testcase name="passed"/><testcase name="skipped"><skipped/></testcase></testsuite>',
  ]) {
    await writeFile(join(f.root, "results.xml"), xml);
    const incomplete = await normalizeChecks(
      { definition: { adapter: "cocotb" } },
      f.root,
      { ok: true },
    );
    assert.equal(
      incomplete.find((c) => c.name === "tests").verdict,
      "inconclusive",
    );
  }
  await writeFile(
    join(f.root, "results.xml"),
    '<testsuite tests="2" failures="1"><testcase name="passed"/><testcase name="failed"><failure/></testcase></testsuite>',
  );
  const failedTests = await normalizeChecks(
    { definition: { adapter: "cocotb" } },
    f.root,
    { ok: true },
  );
  assert.equal(failedTests.find((c) => c.name === "tests").verdict, "fail");
  await mkdir(join(f.root, "out"));
  await writeFile(join(f.root, "out/status"), "UNKNOWN\n");
  const formal = await normalizeChecks(
    { definition: { adapter: "sby" } },
    f.root,
    { ok: true },
  );
  assert.equal(formal.find((c) => c.name === "formal").verdict, "inconclusive");
  f.config.tasks.sim.outputs.push({ path: "out/missing.gds", kind: "layout" });
  await writeFile(
    join(f.root, "chipsim.design.json"),
    JSON.stringify(f.config),
  );
  const run = await finish(f, await startJob(f.root, "sim"));
  assert.equal(run.ready, false);
  assert.equal(
    (await checksForTarget(f.root, "sim")).required.find(
      (c) => c.name === "sim:outputs",
    ).verdict,
    "fail",
  );
});

test("planner rejects cycles, symlink traversal and output bindings over source inputs", async (t) => {
  const f = await fixture(t);
  f.config.tasks.sim.needs = ["sim"];
  await writeFile(
    join(f.root, "chipsim.design.json"),
    JSON.stringify(f.config),
  );
  await assert.rejects(planDesign(f.root, "sim"), /cycle/);
  delete f.config.tasks.sim.needs;
  await symlink(f.root, join(f.root, "alias"));
  f.config.tasks.sim.inputs = ["alias/source.txt"];
  await writeFile(
    join(f.root, "chipsim.design.json"),
    JSON.stringify(f.config),
  );
  await assert.rejects(planDesign(f.root, "sim"), /symbolic/);
});

test("dependency locks include internal symbolic link targets and reject external links", async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, "pdk");
  await mkdir(directory);
  await writeFile(join(directory, "typical.lib"), "cells");
  await writeFile(join(directory, "other.lib"), "cells");
  await symlink("typical.lib", join(directory, "selected.lib"));
  const before = await dependencyIdentity(directory);
  await rm(join(directory, "selected.lib"));
  await symlink("other.lib", join(directory, "selected.lib"));
  assert.notEqual(await dependencyIdentity(directory), before);
  await rm(join(directory, "selected.lib"));
  await symlink("../source.txt", join(directory, "selected.lib"));
  await assert.rejects(dependencyIdentity(directory), /escapes/);
});

test("project TUI exposes graph at both terminal sizes, preserves selection, and stores inspection separately", async (t) => {
  const f = await fixture(t);
  const job = await finish(f, await startJob(f.root, "sim"));
  const state = new TuiState({ workspace: join(f.root, "workspace") });
  await state.initialize();
  const panel = await new DesignPanel(state, f.root).initialize();
  const id = state.design.artifacts[0].id;
  state.design.selection.artifacts = id;
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ])
    for (const view of ["project", "pipeline", "artifacts", "checks"]) {
      Object.assign(state, { columns, rows, view });
      const lines = screenText(state).split("\n");
      assert.equal(lines.length, rows);
      assert.ok(lines.every((l) => displayWidth(l) === columns));
      assert.ok(lines.join("\n").includes(view.toUpperCase()));
    }
  await panel.refresh();
  assert.equal(state.design.selection.artifacts, id);
  await panel.close();
  await verifyEvidence(f.store, job.run);
  const saved = await json(join(f.store.root, "sessions/tui.json"));
  assert.equal(saved.selection.artifacts, id);
});

test("headless commands are structured, bounded and do not execute on import/inspect", async (t) => {
  const f = await fixture(t);
  const finished = await finish(f, await startJob(f.root, "sim"));
  const listed = await designCommand([
    "artifact",
    "list",
    "--project",
    f.root,
    "--limit",
    "1",
  ]);
  assert.equal(listed.result.artifacts.length, 1);
  assert.equal(listed.result.nextOffset, 1);
  const logs = await jobLogs(f.store, finished.id, { limit: 4 });
  assert.equal(logs.text.length, 4);
  assert.equal(logs.nextOffset, 4);
  const bad = await designCommand([
    "artifact",
    "verify",
    "../../etc/passwd",
    "--project",
    f.root,
  ]);
  assert.equal(bad.result.ok, false);
  assert.equal((await designCommand(["design", "run"])).exitCode, 2);
});

test("freshness inspection never executes configured version commands and applies the current policy", async (t) => {
  const f = await fixture(t);
  const run = await finish(f, await startJob(f.root, "sim"));
  f.config.targets.sim.requiredChecks.push("sim:new-review");
  await writeFile(
    join(f.root, "chipsim.design.json"),
    JSON.stringify(f.config),
  );
  const checks = await checksForTarget(f.root, "sim");
  assert.equal(checks.ready, false);
  assert.equal(
    checks.required.find((c) => c.name === "sim:new-review").verdict,
    "missing",
  );
  const sentinel = join(f.root, "executed-on-inspect");
  f.config.tasks.sim.options.versionArgs = [
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`,
  ];
  await writeFile(
    join(f.root, "chipsim.design.json"),
    JSON.stringify(f.config),
  );
  const summary = await projectSummary(f.root);
  assert.equal(summary.runs.find((r) => r.id === run.run).stale, true);
  await assert.rejects(stat(sentinel), { code: "ENOENT" });
});

test("MCP sessions preserve requests, responses, output files and failures", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "server.mjs"),
    `
import {createInterface} from 'node:readline';
import {writeFile, mkdir} from 'node:fs/promises';
const lines = createInterface({input:process.stdin});
for await (const line of lines) {
  const q = JSON.parse(line);
  if (q.method === 'notifications/initialized') continue;
  if (q.method === 'initialize') {
    console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}));
    continue;
  }
  if (q.params.name === 'malformed') { console.log('broken response'); continue; }
  const failed = ['fail','payload-failure'].includes(q.params.name);
  if (!failed) {
    await mkdir(q.params.arguments.directory,{recursive:true});
    await writeFile(q.params.arguments.directory+'/layout.odb',process.env.CHIPSIM_MCP_FIXTURE);
  }
  console.error('server diagnostic');
  const payload = {error:failed?'tool failed':null, output:'saved', truncated:q.params.name==='truncated'};
  console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{isError:q.params.name==='fail',content:[{type:'text',text:JSON.stringify(payload)}]}}));
}
`,
  );
  f.config.tools = {
    mcp: {
      command: process.execPath,
      args: ["server.mjs"],
      env: { CHIPSIM_MCP_FIXTURE: "fixture database" },
    },
  };
  f.config.tasks.sim = {
    adapter: "openroad-mcp",
    tool: "mcp",
    inputs: ["server.mjs"],
    timeoutMs: 10000,
    options: {
      requests: [{ name: "save", arguments: { directory: "{out}" } }],
    },
    outputs: [{ path: "out/layout.odb", kind: "physical-database" }],
  };
  f.config.targets.sim.requiredChecks = ["sim:execution", "sim:outputs"];
  await writeFile(
    join(f.root, "chipsim.design.json"),
    JSON.stringify(f.config),
  );
  const completed = await finish(f, await startJob(f.root, "sim"));
  assert.equal(completed.ready, true);
  const run = await verifyEvidence(f.store, completed.run);
  const artifacts = await Promise.all(
    run.artifacts.map((id) => f.store.get(id)),
  );
  const transcript = artifacts.find((a) => a.path === "mcp-session.jsonl");
  const messages = (
    await readFile(f.store.blobPath(transcript.payload.sha256), "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    messages
      .filter((r) => r.direction === "request")
      .map((r) => r.message.method),
    ["initialize", "notifications/initialized", "tools/call"],
  );
  assert.ok(
    messages.some((r) =>
      r.message.result?.content?.[0].text.includes('"output":"saved"'),
    ),
  );
  assert.ok(
    (await jobLogs(f.store, completed.id)).text.includes("server diagnostic"),
  );
  for (const name of ["fail", "malformed", "payload-failure", "truncated"]) {
    delete f.config.tasks.sim.tool;
    Object.assign(f.config.tasks.sim.options, f.config.tools.mcp);
    f.config.tasks.sim.options.requests[0].name = name;
    await writeFile(
      join(f.root, "chipsim.design.json"),
      JSON.stringify(f.config),
    );
    const failed = await finish(f, await startJob(f.root, "sim"));
    assert.equal(failed.state, "failed");
    assert.equal(failed.ready, false);
    const failedRun = await verifyEvidence(f.store, failed.run);
    const outputs = await Promise.all(
      failedRun.artifacts.map((id) => f.store.get(id)),
    );
    assert.ok(outputs.some((a) => a.path === "mcp-session.jsonl"));
    assert.ok(outputs.some((a) => a.path === "mcp-results.json"));
  }
});

test("controller discovers contracts, waits briefly without cancelling, and resumes logs at EOF", async (t) => {
  const f = await fixture(t, { delay: 800 });
  const catalog = await designCommand(["design", "commands"]);
  assert.equal(catalog.exitCode, 0);
  assert.ok(
    catalog.result.commands.some(
      (c) => c.command === "status" && c.family === "design",
    ),
  );
  assert.ok(
    catalog.result.integrations
      .find((i) => i.adapter === "orfs")
      .outputs.includes("LVSDB"),
  );
  for (const args of [
    ["design", "run", "--timeout-ms", "50"],
    ["job", "status", "--wait"],
    ["design", "run", "--wait", "--timeout-ms", "60001"],
    ["job", "cancel", "id", "--wait"],
  ])
    assert.equal(
      (await designCommand([...args, "--project", f.root])).exitCode,
      2,
    );
  assert.equal((await f.store.list("execution-plan")).length, 0);
  const before = await targetStatus(f.root, "sim");
  assert.equal(before.ready, false);
  assert.equal(before.required[0].verdict, "missing");
  assert.ok(before.actions.some((a) => a.args[1] === "run"));
  const accepted = await designCommand([
    "design",
    "run",
    "--project",
    f.root,
    "--wait",
    "--timeout-ms",
    "1",
  ]);
  assert.equal(accepted.exitCode, 0);
  assert.equal(accepted.result.accepted, true);
  assert.equal(accepted.result.job.waitingStopped, true);
  assert.equal(accepted.result.job.waitReason, "timeout");
  const job = accepted.result.job;
  const first = await jobLogs(f.store, job.id);
  assert.equal(typeof first.cursor, "number");
  await finish(f, job);
  const rest = await jobLogs(f.store, job.id, { offset: first.cursor });
  assert.ok((first.text + rest.text).includes("task finished"));
  assert.equal(rest.nextOffset, null);
  assert.ok(rest.cursor > first.cursor);
  assert.equal(
    (await jobLogs(f.store, job.id, { offset: rest.cursor })).text,
    "",
  );
  const current = await targetStatus(f.root, "sim");
  assert.equal(current.ready, true);
  assert.equal(current.activeJobCount, 0);
  await writeFile(join(f.root, "source.txt"), "changed");
  const changed = await targetStatus(f.root, "sim");
  assert.equal(changed.ready, false);
  assert.equal(changed.required[0].verdict, "stale");
});
