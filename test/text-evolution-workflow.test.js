import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  cp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runChipSim } from "../src/integrations/process.js";
import { workStatus } from "../src/agent/work.js";

const cli = resolve("scripts/chipsim.mjs");
const example = resolve("examples/evolution");
function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, "evolution", ...args], {
    encoding: "utf8",
    timeout: 360000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.ifError(result.error);
  return { ...result, value: JSON.parse(result.stdout) };
}
test("evolution common contracts and discovery require no EDA or provider", () => {
  const tests = spawnSync(
    process.env.PYTHON || "python3",
    ["test/evolution-workflow-test.py"],
    { encoding: "utf8" },
  );
  assert.equal(tests.status, 0, tests.stderr);
  const listed = run(["list"]);
  assert.equal(listed.value.format, "chipsim-evolution-result");
  assert.equal(listed.value.ok, true);
  assert.deepEqual(
    listed.value.result.benchmarks.map((b) => b.id),
    ["counter", "alu8"],
  );
  assert.equal(
    run(["describe", "--benchmark", "alu8"]).value.result.definition.formal
      .required,
    false,
  );
  assert.equal(
    run([
      "validate",
      "--benchmark",
      join(example, "custom-counter/benchmark.json"),
    ]).value.ok,
    true,
  );
  assert.equal(run(["evaluate"]).value.ok, false);
});

test(
  "compile failures provide actual diagnostics in optimizer feedback",
  {
    skip:
      process.env.CHIPSIM_TEST_EVOLUTION_WORKFLOW !== "1" &&
      "set CHIPSIM_TEST_EVOLUTION_WORKFLOW=1; requires Icarus",
    timeout: 90000,
  },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chipsim-workflow-compile-"),
    );
    try {
      const source = join(directory, "invalid.sv");
      await writeFile(source, "module alu( BROKEN\n");
      const result = run([
        "evaluate",
        "--benchmark",
        "alu8",
        "--candidate",
        source,
        "--project",
        directory,
      ]);
      assert.equal(result.value.result.accepted, false, result.stdout);
      assert.equal(result.value.result.metrics.combined_score, 0);
      assert.ok(
        result.value.result.diagnostics.some(
          (d) =>
            d.stage === "directed" &&
            d.category === "invalid_rtl" &&
            /syntax error/i.test(d.message),
        ),
        result.stdout,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native evolution agent cancellation closes the session and managed job",
  {
    skip:
      process.env.CHIPSIM_TEST_EVOLUTION_WORKFLOW !== "1" &&
      "set CHIPSIM_TEST_EVOLUTION_WORKFLOW=1; requires Icarus",
    timeout: 90000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chipsim-workflow-cancel-"));
    const controller = new AbortController();
    let job, pending;
    try {
      const candidate = join(directory, "hang.sv");
      await writeFile(
        candidate,
        (await readFile(join(example, "counter.sv"), "utf8")).replace(
          "endmodule",
          "initial forever #0 count = 0;\nendmodule",
        ),
      );
      pending = runChipSim(
        [
          "evolution",
          "evaluate",
          "--project",
          directory,
          "--candidate",
          candidate,
        ],
        {
          cwd: directory,
          signal: controller.signal,
          timeout: 80000,
          cleanupMs: 20000,
        },
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      for (let n = 0; n < 400 && !job; n++) {
        for (const file of await readdir(directory, { recursive: true })) {
          if (!file.includes("/jobs/") || !file.endsWith("/state.json"))
            continue;
          const state = JSON.parse(
            await readFile(join(directory, file), "utf8"),
          );
          if (state.tasks?.simulate?.state === "running") job = state;
        }
        if (!job) await delay(100);
      }
      assert.ok(job, "managed simulation started");
      controller.abort();
      const result = await pending;
      assert.equal(result.error?.details.cancelled, true);
      assert.equal((await workStatus(directory)).session.status, "cancelled");
      const state = JSON.parse(
        await readFile(
          join(job.project, ".chipsim/design/jobs", job.id, "state.json"),
          "utf8",
        ),
      );
      assert.equal(state.state, "cancelled");
    } finally {
      controller.abort();
      if (pending) await pending;
      if (job)
        spawnSync(process.execPath, [
          cli,
          "job",
          "cancel",
          job.id,
          "--project",
          job.project,
        ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "evolution custom reports, frozen reproduction, comparison and formal gates",
  {
    skip:
      process.env.CHIPSIM_TEST_EVOLUTION_WORKFLOW !== "1" &&
      "set CHIPSIM_TEST_EVOLUTION_WORKFLOW=1; requires Icarus and EQY",
    timeout: 900000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chipsim-workflow-"));
    try {
      const project = join(directory, "work"),
        source = join(directory, "source");
      await mkdir(project);
      await cp(join(example, "custom-counter"), source, { recursive: true });
      const definition = join(source, "benchmark.json");
      const evaluate = (extra = []) =>
        run([
          "evaluate",
          "--benchmark",
          definition,
          "--project",
          project,
          ...extra,
        ]);
      const bad = evaluate();
      assert.equal(bad.value.result.status, "failed", bad.stdout);
      assert.ok(bad.value.result.cases.length);
      assert.equal(bad.value.result.metrics.combined_score, 0);
      const before = join(directory, "before.json");
      await writeFile(before, bad.stdout);
      const fixed = evaluate([
        "--candidate",
        join(example, "correct-counter.sv"),
      ]);
      assert.equal(fixed.value.result.status, "passed", fixed.stdout);
      const after = join(directory, "after.json");
      await writeFile(after, fixed.stdout);
      const comparison = run(["compare", before, after]);
      assert.equal(comparison.value.result.comparable, true, comparison.stdout);
      assert.equal(comparison.value.result.winner, "after");
      // Neither source edits nor deletion of the source project can affect replay.
      await writeFile(join(source, "counter_tb.sv"), "changed tests");
      await rm(source, { recursive: true });
      const replay = run([
        "reproduce",
        before,
        "--case",
        "0",
        "--project",
        project,
      ]);
      assert.equal(replay.value.result.reproduced, true, replay.stdout);
      assert.equal(replay.value.result.accepted, false);
      const repeated = run(["reproduce", before, "--project", project]);
      assert.equal(repeated.value.result.status, "failed", repeated.stdout);
      assert.deepEqual(repeated.value.result.cases, bad.value.result.cases);
      const tampered = JSON.parse(fixed.stdout);
      tampered.result.metrics.combined_score = 900;
      const forged = join(directory, "forged.json");
      await writeFile(forged, JSON.stringify(tampered));
      assert.equal(
        run(["compare", before, forged]).value.result.comparable,
        false,
      );
      assert.equal(
        run(["reproduce", forged, "--project", project]).value.ok,
        false,
      );

      const formal = run([
        "evaluate",
        "--candidate",
        join(example, "correct-counter.sv"),
        "--project",
        project,
        "--formal",
      ]);
      assert.equal(formal.value.result.status, "passed", formal.stdout);
      assert.equal(formal.value.result.formal.status, "proven");
      const altered = join(directory, "rare-reset.sv");
      await writeFile(
        altered,
        (await readFile(join(example, "correct-counter.sv"), "utf8")).replace(
          "count <= 4'd0;",
          "count <= enable ? 4'd0 : 4'd1;",
        ),
      );
      const rejected = run([
        "evaluate",
        "--candidate",
        altered,
        "--project",
        project,
        "--formal",
      ]);
      assert.equal(
        rejected.value.result.metrics.checks_passed,
        80,
        rejected.stdout,
      );
      assert.equal(
        rejected.value.result.formal.status,
        "not-proven",
        rejected.stdout,
      );
      assert.equal(rejected.value.result.accepted, false);
      assert.equal(rejected.value.result.metrics.combined_score, 0);

      const missingProject = join(directory, "missing-tool");
      await cp(join(example, "custom-counter"), missingProject, {
        recursive: true,
      });
      const designPath = join(missingProject, "chipsim.design.json");
      const design = JSON.parse(await readFile(designPath, "utf8"));
      design.tasks.formal.options.command = "chipsim-test-missing-eqy";
      await writeFile(designPath, JSON.stringify(design));
      const missing = run([
        "evaluate",
        "--benchmark",
        join(missingProject, "benchmark.json"),
        "--candidate",
        join(example, "correct-counter.sv"),
        "--project",
        project,
        "--formal",
      ]);
      assert.equal(missing.value.result.accepted, false, missing.stdout);
      assert.equal(missing.value.result.metrics.combined_score, 0);
      assert.ok(
        missing.value.result.diagnostics.some(
          (d) => d.category === "missing_tool",
        ),
        missing.stdout,
      );
      delete design.tasks.formal.options.command;
      await writeFile(designPath, JSON.stringify(design));
      const eqy = join(missingProject, "equivalence.eqy");
      await writeFile(
        eqy,
        (await readFile(eqy, "utf8")).replace("use sat\ndepth 10", "use dummy"),
      );
      const unproven = run([
        "evaluate",
        "--benchmark",
        join(missingProject, "benchmark.json"),
        "--candidate",
        join(example, "correct-counter.sv"),
        "--project",
        project,
        "--formal",
      ]);
      assert.equal(
        unproven.value.result.formal.status,
        "not-proven",
        unproven.stdout,
      );
      assert.equal(unproven.value.result.metrics.combined_score, 0);
      const timeout = run([
        "evaluate",
        "--candidate",
        join(example, "correct-counter.sv"),
        "--project",
        project,
        "--timeout",
        "1",
        "--formal",
      ]);
      assert.equal(timeout.value.result.accepted, false, timeout.stdout);
      assert.equal(timeout.value.result.metrics.combined_score, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "evolution ALU formal comparison and synthesized failure replay",
  {
    skip:
      !(
        process.env.CHIPSIM_TEST_EVOLUTION_WORKFLOW === "1" &&
        process.env.CHIPSIM_TEST_ALU === "1"
      ) &&
      "set CHIPSIM_TEST_EVOLUTION_WORKFLOW=1 CHIPSIM_TEST_ALU=1; requires Icarus/Yosys/EQY",
    timeout: 1000000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chipsim-workflow-alu-"));
    try {
      const evaluate = (candidate, formal = true) =>
        run([
          "evaluate",
          "--benchmark",
          "alu8",
          "--candidate",
          candidate,
          "--project",
          directory,
          ...(formal ? ["--formal"] : []),
        ]);
      const baseline = evaluate(join(example, "alu8/alu.sv"));
      assert.equal(
        baseline.value.result.formal.status,
        "proven",
        baseline.stdout,
      );
      assert.equal(baseline.value.result.accepted, true, baseline.stdout);
      const improved = evaluate(join(example, "alu8/shared-adder.sv"));
      assert.equal(improved.value.result.accepted, true, improved.stdout);
      assert.equal(improved.value.result.formal.status, "proven");
      const left = join(directory, "left.json"),
        right = join(directory, "right.json");
      await writeFile(left, baseline.stdout);
      await writeFile(right, improved.stdout);
      assert.equal(run(["compare", left, right]).value.result.comparable, true);
      const incorrect = join(directory, "netlist-only.sv");
      await writeFile(
        incorrect,
        (await readFile(join(example, "alu8/alu.sv"), "utf8")).replace(
          "zero = result == 0;",
          "`ifdef SYNTHESIS\nresult = 0;\n`endif\nzero = result == 0;",
        ),
      );
      const bad = evaluate(incorrect, false);
      assert.equal(bad.value.result.status, "failed", bad.stdout);
      assert.equal(bad.value.result.replay_source, "netlist.v");
      const report = join(directory, "bad.json");
      await writeFile(report, bad.stdout);
      const replay = run([
        "reproduce",
        report,
        "--case",
        "0",
        "--project",
        directory,
      ]);
      assert.equal(replay.value.result.reproduced, true, replay.stdout);
      assert.equal(replay.value.result.accepted, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
