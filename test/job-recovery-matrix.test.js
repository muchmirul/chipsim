import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store, json } from "../src/design/store.js";
import {
  startJob,
  waitJob,
  jobStatus,
  cancelJob,
  retryJob,
} from "../src/design/jobs.js";
import { checksForTarget } from "../src/design/service.js";
import { dependencyIdentity } from "../src/design/project.js";
import { processIdentity, alive } from "../src/design/process.js";
import { createWorkbench } from "../src/workbench/service.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const x = await fn();
    if (x) return x;
    await sleep(20);
  }
  throw Error("Synchronization deadline exceeded");
}
async function fixture(t, blocking = true) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-recovery-matrix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "started"),
    release = join(root, "release");
  await writeFile(join(root, "source.txt"), "original");
  await writeFile(
    join(root, "task.mjs"),
    `import {writeFile,access} from 'node:fs/promises';
 await writeFile(${JSON.stringify(marker)},String(process.pid));
 ${blocking ? `while(true){try{await access(${JSON.stringify(release)});break;}catch{}await new Promise(r=>setTimeout(r,20));}` : ""}
 await writeFile('out.json',JSON.stringify({value:'original'}));console.log('finished');`,
  );
  const config = {
    format: "chipsim-design",
    version: 1,
    id: "recovery",
    tasks: {
      sim: {
        adapter: "command",
        inputs: ["source.txt", "task.mjs"],
        options: { command: process.execPath, args: ["task.mjs"] },
        outputs: [{ path: "out.json", kind: "report" }],
        checks: [
          {
            name: "value",
            path: "out.json",
            field: "value",
            operator: "eq",
            value: "original",
            scope: "Original synchronization fixture",
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
  return { root, config, marker, release, store: new Store(root) };
}
test("queued and running cancellation stop owned processes and preserve unrelated work", async (t) => {
  const f = await fixture(t);
  const first = await startJob(f.root, "sim", { reuse: false });
  await until(() => stat(f.marker).catch(() => null));
  const owner = await processIdentity(Number(await readFile(f.marker, "utf8")));
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  const exited = new Promise((r) => unrelated.once("exit", r));
  t.after(async () => {
    unrelated.kill();
    await exited;
  });
  const second = await startJob(f.root, "sim", { reuse: false });
  await until(
    async () => (await jobStatus(f.store, second.id)).state === "queued",
  );
  await cancelJob(f.store, second.id);
  const queued = await waitJob(f.store, second.id, { timeoutMs: 15000 });
  assert.equal(queued.state, "cancelled");
  assert.equal(queued.ready, false);
  assert.equal((await jobStatus(f.store, first.id)).state, "running");
  await cancelJob(f.store, first.id);
  const running = await waitJob(f.store, first.id, { timeoutMs: 15000 });
  assert.equal(running.state, "cancelled");
  assert.equal(running.ready, false);
  assert.equal(await alive(owner), false);
  assert.equal(unrelated.exitCode, null);
});
test("simultaneous retries launch one generation and preserve the captured snapshot", async (t) => {
  const f = await fixture(t);
  const first = await startJob(f.root, "sim");
  await until(() => stat(f.marker).catch(() => null));
  await cancelJob(f.store, first.id);
  await waitJob(f.store, first.id, { timeoutMs: 15000 });
  const outcomes = await Promise.allSettled([
    retryJob(f.store, first.id),
    retryJob(f.store, first.id),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  await writeFile(f.release, "go");
  const s = await waitJob(f.store, first.id, { timeoutMs: 15000 });
  assert.equal(s.generation, 2);
  assert.equal(s.snapshot, first.snapshot);
  assert.equal(s.ready, true);
});
for (const change of ["source", "policy", "dependency"])
  test(`${change} changes during execution cannot produce current passing readiness`, async (t) => {
    const f = await fixture(t);
    let dependency;
    if (change === "dependency") {
      dependency = await mkdtemp(join(tmpdir(), "chipsim-recovery-dep-"));
      t.after(() => rm(dependency, { recursive: true, force: true }));
      await writeFile(join(dependency, "value"), "original");
      await writeFile(
        join(f.root, "chipsim.lock.json"),
        JSON.stringify({
          format: "chipsim-lock",
          version: 1,
          dependencies: [
            { path: dependency, sha256: await dependencyIdentity(dependency) },
          ],
        }),
      );
    }
    const job = await startJob(f.root, "sim", { reuse: false });
    await until(() => stat(f.marker).catch(() => null));
    if (change === "source")
      await writeFile(join(f.root, "source.txt"), "changed");
    if (change === "dependency")
      await writeFile(join(dependency, "value"), "changed");
    if (change === "policy") {
      f.config.targets.sim.requiredChecks.push("sim:missing-proof");
      await writeFile(
        join(f.root, "chipsim.design.json"),
        JSON.stringify(f.config),
      );
    }
    await writeFile(f.release, "go");
    const s = await waitJob(f.store, job.id, { timeoutMs: 15000 });
    assert.equal(s.snapshot, job.snapshot);
    const c = await checksForTarget(f.root, "sim", s.run).catch((e) => ({
      ready: false,
      error: e.message,
    }));
    assert.equal(c.ready, false);
  });
for (const boundary of ["before", "after"])
  test(`worker crash ${boundary} run-record publication cannot falsely finalize a job`, async (t) => {
    const f = await fixture(t, false),
      preload = join(f.root, "crash-loader.mjs");
    await writeFile(
      preload,
      `import {Store} from ${JSON.stringify(new URL("../src/design/store.js", import.meta.url).href)};
 if(process.argv[1]?.endsWith('design-worker.mjs')) {const original=Store.prototype.put;Store.prototype.put=async function(kind,...args){if(kind==='run' && '${boundary}'==='before')process.kill(process.pid,'SIGKILL');const r=await original.call(this,kind,...args);if(kind==='run' && '${boundary}'==='after')process.kill(process.pid,'SIGKILL');return r;};}`,
    );
    const old = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--import=${preload}`;
    let job;
    try {
      job = await startJob(f.root, "sim", { reuse: false });
    } finally {
      if (old === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = old;
    }
    const s = await until(async () => {
      const s = await jobStatus(f.store, job.id);
      return s.state === "interrupted" ? s : null;
    });
    assert.equal(s.ready, false);
    assert.equal(s.run, undefined);
    const runs = await f.store.list("run");
    assert.equal(runs.length, boundary === "after" ? 1 : 0);
    const retried = await retryJob(f.store, job.id);
    assert.equal(retried.snapshot, job.snapshot);
    const done = await waitJob(f.store, job.id, { timeoutMs: 15000 });
    assert.equal(done.ready, true);
  });
test("oversized responses return an actionable error and narrower queries succeed", async (t) => {
  const f = await fixture(t, false);
  await writeFile(
    join(f.root, "large.txt"),
    ("needle" + "\x01".repeat(1000) + "\n").repeat(200),
  );
  const wb = await createWorkbench(f.root);
  const wide = await wb.call("file_search", { query: "needle", limit: 200 });
  assert.equal(wide.ok, false);
  assert.equal(wide.error.code, "RESPONSE_LIMIT");
  assert.equal(
    (await wb.call("file_search", { query: "needle", limit: 1 })).ok,
    true,
  );
});

test(
  "dead mutation locks report ownership and are never silently stolen",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t, false),
      dir = join(f.root, ".chipsim/workbench-lock");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "owner.json"),
      JSON.stringify({ pid: 2147483647, start: "dead" }),
    );
    const wb = await createWorkbench(f.root);
    const result = await wb.call("file_write", {
      path: "new.txt",
      text: "safe",
      expectedHash: null,
    });
    assert.equal(result.error.code, "PROJECT_BUSY");
    assert.equal(result.error.details.ownerAlive, false);
    assert.equal(result.error.details.lock, dir);
    assert.ok(await stat(dir));
    await assert.rejects(stat(join(f.root, "new.txt")), { code: "ENOENT" });
  },
);

test("ordinary execution failures retain the shared structured diagnostic fields", async (t) => {
  const f = await fixture(t, false);
  await writeFile(
    join(f.root, "task.mjs"),
    "console.error('native-like command failure'); process.exit(7);",
  );
  const job = await startJob(f.root, "sim", { reuse: false }),
    state = await waitJob(f.store, job.id, { timeoutMs: 15000 });
  assert.equal(state.state, "failed");
  assert.equal(state.ready, false);
  const d = state.diagnostics[0];
  assert.equal(d.category, "execution");
  assert.equal(d.stage, "sim");
  assert.equal(d.exitStatus, 7);
  assert.equal(d.testCase, null);
  assert.equal(d.source, null);
  assert.match(d.artifact, /^[a-f0-9]{64}$/);
});
