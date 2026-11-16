import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function nativeCancellation(call, root, image) {
  const candidate = await call("candidate_create", {
    label: "native-cancellation",
  });
  const text = await call("file_read", {
    candidate: candidate.id,
    path: "test/tb.sv",
  });
  await call("file_write", {
    candidate: candidate.id,
    path: "test/tb.sv",
    expectedHash: text.sha256,
    text: '`timescale 1ns/1ps\nmodule tb; reg clk=0; always #1 clk=~clk; initial begin #1000000000000; $fatal(1,"unreachable watchdog"); end endmodule\n',
  });
  const unrelated = (
    await exec("docker", ["run", "-d", "--entrypoint", "sleep", image, "300"])
  ).stdout.trim();
  let job;
  try {
    job = await call("job_start", {
      candidate: candidate.id,
      target: "simulation",
      requestId: "cancel-native-container",
      reuse: false,
    });
    let state,
      ids = [];
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      state = await call("job_status", {
        candidate: candidate.id,
        job: job.id,
      });
      if (state.token)
        ids = (
          await exec("docker", [
            "ps",
            "-q",
            "--filter",
            "label=chipsim.job=" + state.token,
          ])
        ).stdout
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      if (ids.length) break;
      await pause(50);
    }
    assert.ok(
      ids.length,
      "Native simulator must actually have an owned running container before cancellation",
    );
    await call("job_cancel", { candidate: candidate.id, job: job.id });
    do {
      state = await call("job_status", {
        candidate: candidate.id,
        job: job.id,
        waitMs: 10000,
      });
    } while (
      !["completed", "failed", "cancelled", "interrupted"].includes(state.state)
    );
    assert.equal(state.state, "cancelled");
    assert.equal(state.ready, false);
    const remaining = (
      await exec("docker", [
        "ps",
        "-aq",
        "--filter",
        "label=chipsim.job=" + state.token,
      ])
    ).stdout.trim();
    assert.equal(remaining, "");
    assert.equal(
      (
        await exec("docker", ["inspect", "-f", "{{.State.Running}}", unrelated])
      ).stdout.trim(),
      "true",
    );
    return {
      scenario: "native-owned-container-cancellation",
      job: job.id,
      run: state.run,
      candidate: candidate.id,
      state: state.state,
      ready: false,
      ownedContainersRemoved: true,
      unrelatedContainerPreserved: true,
    };
  } finally {
    if (job) await call("job_cancel", { candidate: candidate.id, job: job.id });
    await exec("docker", ["rm", "-f", unrelated]);
  }
}
