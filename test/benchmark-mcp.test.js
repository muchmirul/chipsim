import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  cp,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkbench } from "../src/workbench/service.js";
import { Store, hash } from "../src/design/store.js";
import { listJobs } from "../src/design/jobs.js";

test(
  "weighted benchmark snapshot survives edits, retries, and verifies captured evidence",
  { skip: !process.env.CHIPSIM_TEST_BENCHMARK, timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-weighted-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(resolve("examples/evolutionary-example/project-workflow"), root, {
      recursive: true,
    });
    const bench = await createWorkbench(root);
    const call = async (tool, args) => {
      const reply = await bench.call(tool, args);
      assert.ok(reply.ok, JSON.stringify(reply.error));
      return reply.result;
    };
    const prep = await call("benchmark_prepare", {
      benchmark: "workflow.json",
    });
    assert.equal(prep.candidatePath, "template/counter.sv");
    const content = await readFile(
      resolve("examples/evolution/correct-counter.sv"),
      "utf8",
    );
    const args = {
      requestId: "weighted",
      context: prep.context,
      candidateHash: hash(content),
      content,
    };
    assert.equal(
      (
        await bench.call("benchmark_start", {
          ...args,
          candidateHash: hash("wrong"),
        })
      ).ok,
      false,
    );
    await writeFile(
      join(root, "template/score.py"),
      "raise Exception('live source changed')",
    );
    const [job, replay] = await Promise.all([
      call("benchmark_start", args),
      call("benchmark_start", args),
    ]);
    assert.equal(job.id, replay.id);
    assert.equal(
      (await call("job_status", { requestId: "weighted" })).id,
      job.id,
    );
    assert.equal(
      (
        await bench.call("benchmark_start", {
          ...args,
          content: "x",
          candidateHash: hash("x"),
        })
      ).error.code,
      "REQUEST_CONFLICT",
    );
    for (;;) {
      const status = await call("job_status", { job: job.id, waitMs: 10000 });
      if (!["accepted", "queued", "running"].includes(status.state)) {
        assert.equal(status.state, "completed", JSON.stringify(status));
        break;
      }
    }
    const measurement = await call("benchmark_result", { job: job.id });
    assert.ok(measurement.accepted);
    const native = await call("artifact_read", {
      benchmarkJob: job.id,
      artifact: measurement.evidence.artifact,
    });
    assert.equal(native.sha256, hash(Buffer.from(native.data, "base64")));
    assert.equal(measurement.units.output_bit_changes, "bit-transitions");
    assert.equal(measurement.context, prep.context);
    assert.equal(measurement.score, 0.485);
    const store = new Store(root),
      artifact = await store.get(measurement.artifact, "artifact");
    await rm(store.blobPath(artifact.payload.sha256));
    assert.equal(
      (await bench.call("benchmark_result", { job: job.id })).ok,
      false,
    );
  },
);

test(
  "cancelling a measured candidate stops the native stage",
  { skip: !process.env.CHIPSIM_TEST_BENCHMARK, timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-cancel-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bench = await createWorkbench(root);
    const call = async (n, a) => {
      const r = await bench.call(n, a);
      assert.ok(r.ok, JSON.stringify(r.error));
      return r.result;
    };
    const ctx = await call("benchmark_prepare", { benchmark: "counter" });
    const src = (
      await readFile("examples/evolution/counter.sv", "utf8")
    ).replace("endmodule", "initial forever #0 count = 0;\nendmodule");
    const job = await call("benchmark_start", {
      context: ctx.context,
      requestId: "cancel",
      content: src,
      candidateHash: hash(src),
    });
    let stage;
    for (let i = 0; i < 300 && !stage; i++) {
      const s = await call("job_status", { job: job.id });
      assert.ok(["accepted", "queued", "running"].includes(s.state));
      if (s.tasks.evaluate?.workspace) {
        const attempts = join(
          s.tasks.evaluate.workspace,
          ".chipsim/benchmark/attempts",
        );
        for (const d of await readdir(attempts).catch(() => [])) {
          const store = new Store(join(attempts, d));
          const jobs = await listJobs(store).catch((error) => {
            if (error.code === "ENOENT") return []; // The job directory can precede state publication.
            throw error;
          });
          if (jobs.some((j) => j.state === "running")) stage = store;
        }
      }
      if (!stage) await delay(100);
    }
    assert.ok(stage, "native worker started");
    await call("job_cancel", { job: job.id });
    for (;;) {
      const s = await call("job_status", { job: job.id, waitMs: 10000 });
      if (!["accepted", "running", "queued"].includes(s.state)) {
        assert.equal(s.state, "cancelled");
        break;
      }
    }
    assert.ok(
      (await listJobs(stage)).every((j) =>
        ["cancelled", "completed", "failed", "interrupted"].includes(j.state),
      ),
    );
    assert.equal(
      (await bench.call("benchmark_result", { job: job.id })).ok,
      false,
    );
  },
);
