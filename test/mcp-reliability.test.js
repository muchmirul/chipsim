import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseXunit } from "../src/design/xunit.js";
import { acceptanceStatus } from "../src/manufacturing/profiles.js";
import { requirementCoverage } from "../src/manufacturing/coverage.js";
import { createWorkbench } from "../src/workbench/service.js";
test("profile support requires matching runtime and host evidence", () => {
  const runtime = { sha256: "a", platform: "linux", arch: "x64" };
  const record = { digest: "b", nativeAcceptance: true, runtime };
  assert.equal(acceptanceStatus(record, "b", runtime).status, "supported");
  for (const key of ["sha256", "platform", "arch"])
    assert.equal(
      acceptanceStatus(record, "b", { ...runtime, [key]: "changed" }).status,
      "candidate",
    );
  assert.equal(acceptanceStatus(null, "b", runtime).status, "candidate");
});
test("xunit preserves explicit failure detail and rejects unfinished reports", () => {
  const cases = parseXunit(
    '<testsuite><testcase name="interlock"><failure message="wrong output"><![CDATA[pin < 2]]></failure></testcase></testsuite>',
  );
  assert.equal(cases[0].verdict, "fail");
  assert.match(cases[0].message, /wrong output/);
  assert.match(cases[0].message, /pin/);
  assert.throws(
    () => parseXunit('<testsuite><testcase name="reset"/>'),
    /malformed/,
  );
  assert.throws(() => parseXunit("<!DOCTYPE a><testsuite/>"), /entities/);
});
test("requirement mapping reports gaps and rejects nonexistent cases", () => {
  const req = [{ id: "R1" }, { id: "R2" }];
  assert.deepEqual(
    requirementCoverage(
      { cases: ["reset"], requirements: { R1: ["reset"] } },
      req,
    ).unmapped,
    ["R2"],
  );
  assert.throws(() =>
    requirementCoverage(
      { cases: ["reset"], requirements: { R1: ["missing"] } },
      req,
    ),
  );
  assert.throws(() =>
    requirementCoverage(
      { cases: ["reset"], requirements: { R3: ["reset"] } },
      req,
    ),
  );
});
test("workflow discovery works before setup and preserves invalid drafts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chipsim-workflow-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wb = await createWorkbench(root);
  const initial = await wb.call("workflow_status");
  assert.equal(initial.ok, true);
  assert.equal(initial.result.prepared, false);
  assert.equal(initial.result.jobs.length, 0);
  await writeFile(join(root, "chipsim.design.json"), "invalid");
  const draft = await wb.call("workflow_status");
  assert.equal(draft.ok, true);
  assert.equal(draft.result.prepared, false);
  assert.ok(draft.result.diagnostic);
  const p = await wb.call("project");
  assert.match(p.result.toolInventorySha256, /^[a-f0-9]{64}$/);
});

test("official workflow journal replays completed work and rejects conflicting ownership", async (t) => {
  let runWorkflow;
  try {
    ({ runWorkflow } = await import("../extensions/mcp/workflow.mjs"));
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("Install optional MCP SDK");
      return;
    }
    throw e;
  }
  const parent = await mkdtemp(join(tmpdir(), "chipsim-helper-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { mkdir, readFile, open } = await import("node:fs/promises");
  const root = join(parent, "project");
  await mkdir(root);
  await writeFile(
    join(root, "task.mjs"),
    "import {writeFile} from 'node:fs/promises'; if(process.env.CHIPSIM_HELPER_TEST_TOKEN!=='forwarded') throw Error('Transport environment missing'); await writeFile('result.json',JSON.stringify({passed:true}));console.log('x'.repeat(20000));",
  );
  await writeFile(
    join(root, "chipsim.design.json"),
    JSON.stringify({
      format: "chipsim-design",
      version: 1,
      id: "helper-test",
      tasks: {
        sim: {
          adapter: "command",
          inputs: ["task.mjs"],
          options: { command: process.execPath, args: ["task.mjs"] },
          outputs: [{ path: "result.json", kind: "report" }],
          checks: [
            {
              name: "passed",
              path: "result.json",
              field: "passed",
              operator: "eq",
              value: true,
              scope: "Original lifecycle fixture",
            },
          ],
        },
      },
      targets: {
        simulation: {
          tasks: ["sim"],
          requiredChecks: ["sim:passed", "sim:outputs"],
        },
      },
    }),
  );
  await writeFile(
    join(root, "chipsim.lock.json"),
    JSON.stringify({ format: "chipsim-lock", version: 1, dependencies: [] }),
  );
  const journal = join(parent, "operation.json");
  const oldToken = process.env.CHIPSIM_HELPER_TEST_TOKEN;
  process.env.CHIPSIM_HELPER_TEST_TOKEN = "forwarded";
  t.after(() => {
    if (oldToken === undefined) delete process.env.CHIPSIM_HELPER_TEST_TOKEN;
    else process.env.CHIPSIM_HELPER_TEST_TOKEN = oldToken;
  });
  const first = await runWorkflow("run", {
    project: root,
    target: "simulation",
    state: journal,
  });
  assert.equal(first.complete, true);
  const id = first.results.run.id;
  const logKey = id + ":" + first.results.run.generation;
  assert.equal(first.logs[logKey].truncated, true);
  assert.ok(first.logs[logKey].cursor >= 20000);
  assert.ok(first.logs[logKey].text.length <= 16384);
  const wb = await createWorkbench(root);
  const discovery = await wb.call("workflow_status");
  assert.equal(discovery.ok, true);
  assert.equal(discovery.result.jobs[0].id, id);
  await writeFile(join(root, "chipsim.design.json"), "invalid live draft");
  const replay = await runWorkflow("resume", { state: journal });
  assert.equal(replay.results.run.id, id);
  assert.deepEqual(replay.requests, first.requests);
  assert.equal(replay.logs[logKey].cursor, first.logs[logKey].cursor);
  const { rename } = await import("node:fs/promises");
  await rename(root, root + ".saved");
  await mkdir(root);
  await assert.rejects(
    runWorkflow("resume", { state: journal }),
    /directory was replaced/,
  );
  await rm(root, { recursive: true });
  await rename(root + ".saved", root);
  await assert.rejects(
    runWorkflow("run", {
      project: root,
      target: "simulation",
      state: join(root, "inside.json"),
    }),
    /outside project/,
  );
  await assert.rejects(readFile(join(root, "inside.json")), { code: "ENOENT" });
  const h = await open(journal + ".lock", "wx");
  await h.close();
  await assert.rejects(runWorkflow("resume", { state: journal }), {
    code: "EEXIST",
  });
  assert.equal(JSON.parse(await readFile(journal)).results.run.id, id);
});

test("helper resumes an accepted job after abrupt client death without duplicate submission", async (t) => {
  let runWorkflow;
  try {
    ({ runWorkflow } = await import("../extensions/mcp/workflow.mjs"));
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("Install optional MCP SDK");
      return;
    }
    throw e;
  }
  const { mkdir, readdir, readFile, unlink } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const parent = await mkdtemp(join(tmpdir(), "chipsim-helper-disconnect-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await mkdir(root);
  await writeFile(
    join(root, "task.mjs"),
    "import {writeFile} from 'node:fs/promises';await new Promise(r=>setTimeout(r,2000));await writeFile('result.json',JSON.stringify({passed:true}));",
  );
  await writeFile(
    join(root, "chipsim.design.json"),
    JSON.stringify({
      format: "chipsim-design",
      version: 1,
      id: "disconnect",
      tasks: {
        sim: {
          adapter: "command",
          inputs: ["task.mjs"],
          options: { command: process.execPath, args: ["task.mjs"] },
          outputs: [{ path: "result.json", kind: "report" }],
          checks: [
            {
              name: "passed",
              path: "result.json",
              field: "passed",
              operator: "eq",
              value: true,
              scope: "Lifecycle fixture",
            },
          ],
        },
      },
      targets: {
        simulation: {
          tasks: ["sim"],
          requiredChecks: ["sim:passed", "sim:outputs"],
        },
      },
    }),
  );
  await writeFile(
    join(root, "chipsim.lock.json"),
    JSON.stringify({ format: "chipsim-lock", version: 1, dependencies: [] }),
  );
  const state = join(parent, "operation.json");
  const child = spawn(
    process.execPath,
    [
      new URL("../extensions/mcp/workflow.mjs", import.meta.url).pathname,
      "run",
      "--project",
      root,
      "--target",
      "simulation",
      "--state",
      state,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let accepted;
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      const names = await readdir(join(root, ".chipsim/design/requests")).catch(
        () => [],
      );
      const receipt = names.find((name) => name.endsWith(".json"));
      if (receipt) {
        accepted = JSON.parse(
          await readFile(join(root, ".chipsim/design/requests", receipt)),
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(accepted, "accepted durable binding appears");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  // The process is confirmed dead; explicitly release its client-only journal lock.
  await unlink(state + ".lock");
  const resumed = await runWorkflow("resume", { state });
  assert.equal(resumed.results.run.id, accepted.id);
  assert.equal(resumed.results.run.ready, true);
  assert.equal((await readdir(join(root, ".chipsim/design/jobs"))).length, 1);
});

test("structured verification failures retain explicit cases and independent report errors", async () => {
  const { verificationFailure } =
    await import("../src/manufacturing/verify.js");
  const task = { definition: { options: { operation: "rtl" } } };
  const check = {
    cases: [{ name: "interlock", verdict: "fail", message: "pin mismatch" }],
    diagnostic: "Missing required case",
  };
  const d = verificationFailure(
    task,
    { ok: false, code: 1 },
    [check],
    "FATAL: test/tb.sv:36: wrong pin\n",
  );
  assert.equal(d.testCase, "interlock");
  assert.equal(d.category, "assertion");
  assert.equal(d.exitStatus, 1);
  assert.deepEqual(d.source, { path: "test/tb.sv", line: 36 });
  assert.deepEqual(d.reportDiagnostics, ["Missing required case"]);
  const report = verificationFailure(task, { ok: true, code: 0 }, [check], "");
  assert.equal(report.testCase, "interlock");
  assert.equal(report.message, "pin mismatch");
  assert.equal(
    verificationFailure(task, { ok: false, reason: "timeout" }, [], "")
      .category,
    "timeout",
  );
  assert.equal(
    verificationFailure(task, { ok: false, code: 1 }, [], "FATAL: unknown")
      .testCase,
    null,
  );
});

test("workflow guidance exposes active and failed stages without recovering dead jobs", async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "chipsim-guidance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = "12345678-1234-1234-1234-123456789abc",
    path = join(root, ".chipsim/design/jobs", id);
  await mkdir(path, { recursive: true });
  const state = {
    id,
    target: "manufacturing-setup",
    state: "running",
    generation: 1,
    updated: "2000-01-01T00:00:00.000Z",
    owner: { pid: 2147483647, start: "dead" },
  };
  await writeFile(join(path, "state.json"), JSON.stringify(state));
  const wb = await createWorkbench(root);
  const active = await wb.call("workflow_status");
  assert.equal(active.ok, true);
  assert.equal(active.result.stage, "job-active");
  assert.equal(active.result.nextActions[0].tool, "job_status");
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual(JSON.parse(await readFile(join(path, "state.json"))), state);
  await writeFile(
    join(path, "state.json"),
    JSON.stringify({ ...state, state: "failed" }),
  );
  const failed = await wb.call("workflow_status");
  assert.equal(failed.result.stage, "setup-failed");
});

test("suggested workflow actions retain candidate isolation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chipsim-guidance-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wb = await createWorkbench(root);
  await wb.call("file_write", {
    path: "note.txt",
    text: "source",
    expectedHash: null,
  });
  const c = await wb.call("candidate_create", { label: "isolated" });
  assert.equal(c.ok, true);
  const s = await wb.call("workflow_status", { candidate: c.result.id });
  assert.equal(s.ok, true);
  assert.equal(s.result.candidate, c.result.id);
  assert.ok(
    s.result.nextActions.every((a) => a.arguments.candidate === c.result.id),
  );
});
