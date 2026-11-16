import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manufacturingTool } from "../../src/manufacturing/service.js";
import { Store } from "../../src/design/store.js";
import { waitJob, cancelJob } from "../../src/design/jobs.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function packagingRaces(root, run, dependency) {
  const store = new Store(root),
    results = [];
  // Alter project-owned source and policy, and a disposable copy of one locked
  // dependency. Never tamper with the shared manufacturing cache.
  const lockPath = join(root, "chipsim.lock.json");
  const lockOriginal = await readFile(lockPath, "utf8");
  for (const scenario of [
    "source",
    "policy",
    "dependency",
    "late-source",
    "cancel",
  ]) {
    const barrier = await mkdtemp(join(tmpdir(), "chipsim-package-barrier-"));
    const saved = {
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      CHIPSIM_TEST_BARRIER_DIR: process.env.CHIPSIM_TEST_BARRIER_DIR,
      CHIPSIM_TEST_BARRIER_LATE: process.env.CHIPSIM_TEST_BARRIER_LATE,
    };
    let job, changedPath, original;
    try {
      process.env.NODE_OPTIONS =
        "--import=" + new URL("./worker-barrier.mjs", import.meta.url).pathname;
      process.env.CHIPSIM_TEST_BARRIER_DIR = barrier;
      process.env.CHIPSIM_TEST_BARRIER_LATE =
        scenario === "late-source" ? "1" : "0";
      job = await manufacturingTool(root, "release_package", {
        run,
        requestId: "race-" + scenario,
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    try {
      const deadline = Date.now() + 240000;
      while (!(await stat(join(barrier, "ready")).catch(() => null))) {
        if (Date.now() > deadline)
          throw Error("Packaging barrier timeout: " + scenario);
        await pause(50);
      }
      if (scenario === "cancel") await cancelJob(store, job.id);
      else {
        changedPath =
          scenario === "dependency"
            ? join(dependency, "data")
            : join(
                root,
                scenario === "policy"
                  ? "chipsim.design.json"
                  : scenario === "dependency"
                    ? "tt/fixture-race.txt"
                    : "src/project.v",
              );
        original = await readFile(changedPath).catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        });
        if (scenario === "policy") {
          const config = JSON.parse(original);
          config.targets.release.requiredChecks.push("gate:missing-race-proof");
          await writeFile(changedPath, JSON.stringify(config));
        } else
          await writeFile(
            changedPath,
            original
              ? Buffer.concat([
                  original,
                  Buffer.from("\n// changed while packaging\n"),
                ])
              : "new consumed dependency input",
          );
      }
      await writeFile(join(barrier, "release"), "go");
      const state = await waitJob(store, job.id, { timeoutMs: 240000 });
      assert.equal(state.ready, false, scenario);
      assert.equal(
        state.state,
        scenario === "cancel" ? "cancelled" : "failed",
        JSON.stringify(state),
      );
      const published = state.run ? await store.get(state.run, "run") : null;
      assert.ok(!published?.readiness.ready);
      results.push({
        scenario,
        job: job.id,
        state: state.state,
        run: state.run || null,
        ready: false,
        diagnostics: state.diagnostics,
      });
    } finally {
      if (changedPath) {
        if (original === null) await rm(changedPath, { force: true });
        else if (original !== undefined) await writeFile(changedPath, original);
      }
      await writeFile(join(barrier, "release"), "go");
      await cancelJob(store, job.id);
      await waitJob(store, job.id, { timeoutMs: 15000 });
      await rm(barrier, { recursive: true, force: true });
    }
  }

  assert.equal(await readFile(lockPath, "utf8"), lockOriginal);
  return results;
}
