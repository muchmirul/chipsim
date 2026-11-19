import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorkbench } from "../src/workbench/service.js";
import { hash, Store } from "../src/design/store.js";

test(
  "formal benchmark: pending, sampled rejection, proof-only rejection, success and replay",
  {
    skip: !process.env.CHIPSIM_TEST_BENCHMARK,
    timeout: 180000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "benchmark-proof-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bench = await createWorkbench(root);
    const call = async (tool, args) => {
      const reply = await bench.call(tool, args);
      assert.ok(reply.ok, JSON.stringify(reply.error));
      return reply.result;
    };
    const { context } = await call("benchmark_prepare", {
      benchmark: "counter",
      formal: true,
    });
    const correct = await readFile(
      "examples/evolution/correct-counter.sv",
      "utf8",
    );
    async function submit(requestId, content, ctx = context) {
      const args = {
        requestId,
        context: ctx,
        content,
        candidateHash: hash(content),
      };
      const job = await call("benchmark_start", args);
      const pending = await bench.call("benchmark_result", { job: job.id });
      assert.equal(pending.error.code, "BENCHMARK_PENDING");
      assert.equal(pending.error.details.retryable, true);
      for (;;) {
        const state = await call("job_status", { job: job.id, waitMs: 10000 });
        if (!["accepted", "queued", "running"].includes(state.state)) break;
      }
      assert.equal((await call("benchmark_start", args)).id, job.id);
      const r = await call("benchmark_result", { job: job.id });
      assert.equal(r.candidateHash, args.candidateHash);
      assert.equal(r.context, ctx);
      return r;
    }
    const invalid = await bench.call("benchmark_start", {
      context,
      content: correct,
      requestId: "formal-only",
      candidateHash: hash("different"),
    });
    assert.equal(invalid.error.code, "CANDIDATE_HASH_MISMATCH");
    assert.equal(invalid.error.details.retryable, false);
    assert.equal(
      (await call("job_status", { requestId: "formal-only" })).state,
      "unknown",
    );

    const failed = await submit(
      "formal-only",
      correct.replace("if (enable)", "if (enable || count == 4'd0)"),
    );
    assert.equal(failed.jobState, "failed");
    assert.equal(failed.measured, false);
    assert.equal(failed.accepted, false);
    assert.equal(failed.score, null);
    assert.deepEqual(failed.metrics, { checks_total: 80, checks_passed: 80 });
    assert.equal(failed.stages.formal.ready, false);
    assert.equal(failed.formal.run, failed.stages.formal.run);
    assert.deepEqual(failed.formal.assumptions, [
      "Reset is asserted at the first sampled clock.",
    ]);
    assert.equal(failed.formal.status, "not-proven");
    const refs = failed.formal.diagnostics;
    const marker = refs.find((r) => r.path === "out/FAIL");
    const trace = refs.find((r) => r.path.endsWith("/trace.vcd"));
    assert.ok(marker && trace);
    const status = refs.find(
      (r) => r.path === join(dirname(trace.path), "status"),
    );
    assert.ok(status);
    const scope = { benchmarkJob: failed.job };
    for (const { artifact } of [marker, trace, status]) {
      const chunk = await call("artifact_read", { ...scope, artifact });
      const bytes = Buffer.from(chunk.data, "base64");
      assert.equal(hash(bytes), chunk.chunkSha256);
      if (artifact === status.artifact) {
        assert.equal(bytes.toString().trim(), status.status);
        assert.equal(
          failed.formal.verdict,
          status.status === "FAIL" ? "counterexample" : "not-proven",
        );
      }
    }
    const listed = await call("artifacts", {
      ...scope,
      run: failed.stages.formal.run,
      limit: 200,
    });
    assert.ok(listed.items.some((i) => i.id === marker.artifact));
    assert.ok(
      (await call("artifact_read", { artifact: failed.artifact, limit: 512 }))
        .length > 0,
    );
    assert.ok(
      (
        await call("artifact_read", {
          ...scope,
          artifact: failed.reportEvidence.artifact,
          limit: 512,
        })
      ).length > 0,
    );
    assert.equal(
      (
        await bench.call("artifact_read", {
          ...scope,
          artifact: failed.artifact,
        })
      ).error.code,
      "BENCHMARK_SCOPE",
    );

    const boundary = await submit(
      "hold-max",
      correct.replace("if (enable)", "if (enable || count == 4'hf)"),
    );
    assert.equal(boundary.jobState, "completed");
    assert.equal(boundary.measured, true);
    assert.equal(boundary.accepted, false);
    assert.equal(boundary.score, 0);
    assert.equal(boundary.formal.verdict, "not-run");
    assert.equal(boundary.metrics.checks_passed, 75);
    assert.match(boundary.feedback, /22/);

    const pass = await submit("proven", correct);
    assert.equal(pass.accepted, true);
    assert.equal(pass.formal.verdict, "proven");
    assert.equal(pass.score, 1);
    assert.equal(
      (
        await bench.call("artifact_read", {
          benchmarkJob: pass.job,
          artifact: trace.artifact,
        })
      ).error.code,
      "BENCHMARK_SCOPE",
    );

    // A missing executable is not a counterexample, even with all sampled checks passing.
    const custom = join(root, "missing-tool");
    await cp("examples/evolution/custom-counter", custom, { recursive: true });
    const manifest = join(custom, "chipsim.design.json");
    const config = JSON.parse(await readFile(manifest));
    config.tasks.formal.options.command = "chipsim-test-missing-eqy";
    await writeFile(manifest, JSON.stringify(config));
    const customContext = await call("benchmark_prepare", {
      benchmark: "missing-tool/benchmark.json",
      formal: true,
    });
    const missing = await submit(
      "missing-tool",
      correct,
      customContext.context,
    );
    assert.equal(missing.formal.verdict, "not-proven");
    assert.equal(missing.accepted, false);
    assert.equal(missing.measured, false);
    assert.equal(missing.score, null);
    const execution = missing.formal.diagnostics.find(
      (d) => d.path === "execution.json",
    );
    assert.ok(execution);
    assert.ok(
      (
        await call("artifact_read", {
          benchmarkJob: missing.job,
          artifact: execution.artifact,
        })
      ).sha256,
    );

    // Lost native bytes invalidate both the summary and scoped inspection; outer report is not enough.
    const native = new Store(failed.evidence.project);
    const record = await native.get(trace.artifact, "artifact");
    await rm(native.blobPath(record.payload.sha256));
    assert.equal(
      (await bench.call("benchmark_result", { job: failed.job })).ok,
      false,
    );
    assert.equal(
      (
        await bench.call("artifact_read", {
          ...scope,
          artifact: marker.artifact,
        })
      ).ok,
      false,
    );
  },
);
