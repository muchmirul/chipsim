import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile, open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, json, identity, Store } from "./store.js";
import {
  planDesign,
  loadDesign,
  runtimeIdentity,
  toolIdentity,
  verifyDependencies,
} from "./project.js";
import { executeAdapter } from "./adapters.js";
import { publishAttempt, verifyEvidence } from "./evidence.js";
import { processIdentity, alive, stopOwned, reapToken } from "./process.js";

const workerFile = fileURLToPath(
  new URL("../../scripts/design-worker.mjs", import.meta.url),
);
export const terminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export function jobPath(store, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid job ID");
  return join(store.root, "jobs", id);
}
async function launch(root, store, state) {
  await atomic(join(jobPath(store, state.id), "state.json"), state);
  const child = spawn(process.execPath, [workerFile, root, state.id], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CHIPSIM_JOB_TOKEN: undefined },
    windowsHide: true,
  });
  await new Promise((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  child.unref();
  return state;
}
export async function startJob(path, target, { reuse = true } = {}) {
  const { root, store, plan, snapshot } = await planDesign(path, target);
  const state = {
    format: "chipsim-job",
    version: 1,
    id: randomUUID(),
    project: root,
    target,
    plan: plan.id,
    snapshot: snapshot.id,
    state: "accepted",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    generation: 1,
    attempts: [],
    tasks: {},
    owner: null,
    reuse,
  };
  return launch(root, store, state);
}
async function reapChildren(path) {
  let names;
  try {
    names = await readdir(join(path, "owners"));
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const owner = await json(join(path, "owners", name));
    await stopOwned(owner, "SIGKILL");
  }
}
export async function jobStatus(store, id) {
  const path = jobPath(store, id),
    state = await json(join(path, "state.json"));
  if (!terminal.has(state.state)) {
    const dead = state.owner
      ? !(await alive(state.owner))
      : Date.now() - Date.parse(state.updated) > 30000;
    if (dead) {
      await reapChildren(path);
      await reapToken(state.token);
      state.state = "interrupted";
      state.error =
        "Worker stopped before final publication; retry uses the original snapshot.";
      state.updated = new Date().toISOString();
      await atomic(join(path, "state.json"), state);
    }
  }
  return state;
}
export async function listJobs(store) {
  let names;
  try {
    names = await readdir(join(store.root, "jobs"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const result = [];
  for (const id of names.filter((n) => /^[0-9a-f-]{36}$/.test(n)))
    result.push(await jobStatus(store, id));
  return result.sort((a, b) => b.created.localeCompare(a.created));
}
export async function cancelJob(store, id) {
  const state = await jobStatus(store, id);
  if (!terminal.has(state.state))
    await atomic(join(jobPath(store, id), "cancel.json"), {
      generation: state.generation,
      requested: new Date().toISOString(),
    });
  return { ...state, cancellationRequested: !terminal.has(state.state) };
}
export async function retryJob(store, id) {
  const path = jobPath(store, id);
  // Serialize concurrent retries independently of the project's task lock.
  await mkdir(join(path, "retry-lock"));
  try {
    const state = await jobStatus(store, id);
    if (!terminal.has(state.state))
      throw new Error("Only a finished/interrupted job can be retried");
    await verifyEvidence(store, state.plan);
    state.state = "accepted";
    state.owner = null;
    state.generation++;
    state.updated = new Date().toISOString();
    state.tasks = {};
    delete state.error;
    delete state.run;
    return await launch(state.project, store, state);
  } finally {
    await rm(join(path, "retry-lock"), { recursive: true, force: true });
  }
}
export async function waitJob(
  store,
  id,
  { signal, timeoutMs = 86400000 } = {},
) {
  const start = Date.now();
  while (true) {
    const state = await jobStatus(store, id);
    if (terminal.has(state.state)) return state;
    if (signal?.aborted || Date.now() - start >= timeoutMs)
      return {
        ...state,
        waitingStopped: true,
        waitReason: signal?.aborted ? "aborted" : "timeout",
      };
    await pause(200);
  }
}
export async function jobLogs(store, id, { offset = 0, limit = 16384 } = {}) {
  const file = join(jobPath(store, id), "log.txt");
  let handle;
  try {
    handle = await open(file, "r");
  } catch (e) {
    if (e.code === "ENOENT")
      return { text: "", offset, cursor: offset, nextOffset: null };
    throw e;
  }
  try {
    const buffer = Buffer.alloc(limit),
      size = (await handle.stat()).size;
    const { bytesRead } = await handle.read(buffer, 0, limit, offset);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      offset,
      cursor: offset + bytesRead,
      nextOffset: offset + bytesRead < size ? offset + bytesRead : null,
    };
  } finally {
    await handle.close();
  }
}

export async function evaluateChecks(store, plan, attempts) {
  const checks = [];
  for (const a of attempts)
    for (const id of a.checks) checks.push(await store.get(id, "check"));
  const required = plan.policy.requiredChecks || [];
  const results = [];
  for (const key of required) {
    const found = checks.filter((c) => c.subject.task + ":" + c.name === key);
    const c = found.at(-1);
    let verdict = c?.verdict || "missing",
      error;
    if (c)
      try {
        await verifyEvidence(store, c.id);
      } catch (e) {
        verdict = "invalid";
        error = e.message;
      }
    results.push({
      name: key,
      verdict,
      check: c?.id,
      ...(error ? { error } : {}),
    });
  }
  return {
    ready: required.length > 0 && results.every((r) => r.verdict === "pass"),
    policy: plan.policy,
    required: results,
    checks,
  };
}

export async function runWorker(root, id) {
  const store = new Store(root),
    path = jobPath(store, id);
  let state = await json(join(path, "state.json"));
  const generation = state.generation;
  const controller = new AbortController(),
    lock = join(store.root, "execution-lock");
  let ownsLock = false;
  state.owner = await processIdentity(process.pid);
  state.state = "queued";
  state.token = randomUUID();
  process.env.CHIPSIM_JOB_TOKEN = state.token;
  const save = async () => {
    state.updated = new Date().toISOString();
    await atomic(join(path, "state.json"), state);
  };
  await save();
  const heartbeat = setInterval(
    () =>
      atomic(join(path, "heartbeat.json"), {
        owner: state.owner,
        time: new Date().toISOString(),
      }).catch(() => controller.abort()),
    1000,
  );
  const cancellation = setInterval(async () => {
    try {
      const request = await json(join(path, "cancel.json"));
      if (request.generation === generation) controller.abort();
    } catch (e) {
      if (e.code !== "ENOENT") controller.abort();
    }
  }, 100);
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const attempts = [],
    results = new Map();
  try {
    while (!ownsLock) {
      if (controller.signal.aborted) throw new Error("cancelled");
      try {
        await mkdir(lock);
        ownsLock = true;
        await atomic(join(lock, "owner.json"), state.owner);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (!(await alive(await json(join(lock, "owner.json"))))) {
            await rm(lock, { recursive: true, force: true });
            continue;
          }
        } catch (e) {
          if (
            e.code === "ENOENT" &&
            Date.now() - (await stat(lock)).mtimeMs > 30000
          )
            await rm(lock, { recursive: true, force: true });
        }
        await pause(250);
      }
    }
    const plan = await store.get(state.plan, "execution-plan");
    await verifyEvidence(store, state.plan);
    const snapshot = await store.get(plan.snapshot, "input-snapshot");
    if (identity(snapshot.runtime) !== identity(await runtimeIdentity()))
      throw new Error(
        "ChipSim runtime changed since snapshot; start a new run",
      );
    state.state = "running";
    await save();
    const cache = [];
    if (state.reuse)
      for (const run of await store.list("run"))
        if (run.provenance !== "unknown")
          for (const aid of run.attempts)
            cache.push(await store.get(aid, "attempt"));
    for (const task of plan.tasks) {
      if (controller.signal.aborted) break;
      if (
        task.needs.some(
          (dep) =>
            !results.get(dep)?.complete || !results.get(dep)?.execution.ok,
        )
      ) {
        state.tasks[task.task] = { state: "blocked" };
        await save();
        continue;
      }
      const upstream = [];
      for (const dep of task.needs)
        for (const aid of results.get(dep).artifacts) {
          const a = await store.get(aid, "artifact");
          upstream.push({
            artifact: aid,
            task: dep,
            path: a.path,
            ...a.payload,
          });
        }
      const fingerprint = identity({
        base: task.fingerprint,
        upstream: upstream.map(({ task, path, sha256 }) => ({
          task,
          path,
          sha256,
        })),
      });
      const reused = cache.find(
        (a) => a.fingerprint === fingerprint && a.reusable,
      );
      if (reused) {
        try {
          await verifyEvidence(store, reused.id);
          const reuse = await store.put("attempt", {
            ...reused,
            id: undefined,
            job: id,
            attempt: randomUUID(),
            reusedFrom: reused.id,
          });
          results.set(task.task, reuse);
          attempts.push(reuse);
          state.attempts.push(reuse.id);
          state.tasks[task.task] = { state: "reused", attempt: reuse.id };
          await save();
          continue;
        } catch {
          /* damaged cache is never reused */
        }
      }
      const attempt = randomUUID(),
        workspace = join(path, "work", attempt);
      await mkdir(workspace, { recursive: true });
      await store.materialize(task.inputs, workspace);
      for (const binding of task.definition.bindings || []) {
        const artifact = upstream.find(
          (a) => a.task === binding.task && a.path === binding.output,
        );
        if (!artifact)
          throw new Error(
            "Missing upstream artifact " + binding.task + ":" + binding.output,
          );
        await store.materialize(
          [{ ...artifact, path: binding.path }],
          workspace,
        );
      }
      state.tasks[task.task] = { state: "running", attempt, workspace };
      await save();
      let execution;
      try {
        await verifyDependencies(task.dependencies, root);
        for (const expected of task.tools) {
          if (!expected.available)
            throw new Error("Missing tool: " + expected.command);
          const actual = await toolIdentity(
            expected.command,
            expected.versionArgs,
          );
          if (identity(actual) !== identity(expected))
            throw new Error("Tool changed since snapshot: " + expected.command);
        }
        execution = await executeAdapter(task, {
          workspace,
          signal: controller.signal,
          log: join(path, "log.txt"),
          owners: join(path, "owners"),
        });
      } catch (error) {
        execution = { ok: false, reason: error.message };
      }
      if (controller.signal.aborted)
        execution = { ...execution, ok: false, reason: "cancelled" };
      await reapChildren(path);
      await reapToken(state.token);
      // Snapshot a bounded copy of the cumulative process log into this attempt.
      const { copyFile } = await import("node:fs/promises");
      try {
        await copyFile(join(path, "log.txt"), join(workspace, "tool.log"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const recorded = await publishAttempt(store, {
        task,
        workspace,
        execution,
        job: id,
        attempt,
        snapshot: state.snapshot,
        fingerprint,
        inputs: [...task.inputs, ...upstream],
      });
      attempts.push(recorded);
      results.set(task.task, recorded);
      state.attempts.push(recorded.id);
      state.tasks[task.task] = { state: recorded.state, attempt: recorded.id };
      await save();
    }
    const readiness = await evaluateChecks(store, plan, attempts);
    state.state = controller.signal.aborted
      ? "cancelled"
      : attempts.length !== plan.tasks.length ||
          attempts.some((a) => !a.complete || !a.execution.ok)
        ? "failed"
        : "completed";
    const record = await store.put("run", {
      job: id,
      generation,
      target: state.target,
      plan: state.plan,
      snapshot: state.snapshot,
      state: state.state,
      provenance: "captured",
      attempts: attempts.map((a) => a.id),
      artifacts: [...new Set(attempts.flatMap((a) => a.artifacts))],
      checks: [...new Set(attempts.flatMap((a) => a.checks))],
      readiness,
      created: new Date().toISOString(),
    });
    await verifyEvidence(store, record.id);
    state.run = record.id;
    state.ready = readiness.ready;
    if (state.state === "completed" && readiness.ready)
      await atomic(join(store.root, "latest", state.target + ".json"), {
        run: record.id,
      });
  } catch (error) {
    state.state = controller.signal.aborted ? "cancelled" : "interrupted";
    state.error = error.message;
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancellation);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await reapChildren(path);
    await reapToken(state.token);
    await save();
    if (ownsLock) await rm(lock, { recursive: true, force: true });
  }
  return state;
}
