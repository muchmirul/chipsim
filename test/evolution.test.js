import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { workStatus } from "../src/agent/work.js";

const example = resolve("examples/evolutionary-example");
const python = process.env.PYTHON || "python3";
function run(args, timeout = 30000) {
  const result = spawnSync(python, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.ifError(result.error);
  return result;
}
function waveform() {
  let count = 0;
  const events = [];
  for (let cycle = 0; cycle < 80; cycle++) {
    const reset = [0, 27, 55].includes(cycle);
    const enable = ![3, 4].includes(cycle % 7);
    events.push({
      time: String(cycle * 10000),
      changes: {
        "counter_tb.clk": "0",
        "counter_tb.reset": String(Number(reset)),
        "counter_tb.enable": String(Number(enable)),
      },
    });
    count = reset ? 0 : (count + Number(enable)) % 16;
    events.push({
      time: String(cycle * 10000 + 5000),
      changes: {
        "counter_tb.clk": "1",
        "counter_tb.count": count.toString(2).padStart(4, "0"),
      },
    });
  }
  events.push({ time: "800000", changes: { "counter_tb.clk": "0" } });
  return {
    format: "chipsim-waveform",
    version: 1,
    timescale: { magnitude: "1", unit: "ps" },
    signals: ["clk", "reset", "enable", "count"].map((id) => ({
      id: "counter_tb." + id,
      width: id === "count" ? 4 : 1,
    })),
    events,
  };
}

test("evolution trusted waveform scorer checks observations, completeness, stimulus and unknowns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chipsim-evolution-oracle-"));
  try {
    const source = join(directory, "waveform.json");
    const target = join(directory, "metrics.json");
    const evaluate = async (wave) => {
      await writeFile(source, JSON.stringify(wave));
      return run([
        join(example, "counter", "trusted/score.py"),
        source,
        target,
      ]);
    };
    assert.equal((await evaluate(waveform())).status, 0);
    let metrics = JSON.parse(await readFile(target, "utf8"));
    assert.equal(metrics.combined_score, 1);
    assert.equal(metrics.checks_passed, 80);
    const unknown = waveform();
    unknown.events[7].changes["counter_tb.count"] = "XXXX";
    assert.equal((await evaluate(unknown)).status, 0);
    metrics = JSON.parse(await readFile(target, "utf8"));
    assert.equal(metrics.checks_passed, 79);
    assert.equal(metrics.failures[0].cycle, 3);
    const early = waveform();
    early.events.pop();
    assert.notEqual((await evaluate(early)).status, 0);
    const stimulus = waveform();
    stimulus.events[6].changes["counter_tb.enable"] = "1";
    assert.notEqual((await evaluate(stimulus)).status, 0);
    const missing = waveform();
    missing.signals.pop();
    assert.notEqual((await evaluate(missing)).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evolution offline help/import has no OpenEvolve dependency", () => {
  assert.equal(run([join(example, "run.py"), "--help"]).status, 0);
  const result = run([
    "-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(example)}); import evaluator; assert 'openevolve' not in sys.modules`,
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test(
  "evolution supervisor cancels when optimizer replaces both signal handlers",
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chipsim-evolution-signals-"),
    );
    try {
      const packageDir = join(directory, "openevolve");
      await mkdir(packageDir);
      await writeFile(
        join(packageDir, "config.py"),
        `from types import SimpleNamespace

def load_config(path):
    return SimpleNamespace(evaluator=SimpleNamespace())
`,
      );
      // Protocol fixture only: no fake candidate search and no reported HDL result.
      await writeFile(
        join(packageDir, "__init__.py"),
        `import os, signal, time
from pathlib import Path
from types import SimpleNamespace

def run_evolution(**kwargs):
    cancelled = False
    def graceful(signum, frame):
        nonlocal cancelled
        cancelled = True
    signal.signal(signal.SIGTERM, graceful)
    signal.signal(signal.SIGINT, graceful)
    Path(os.environ["CHIPSIM_TEST_READY"]).write_text("ready")
    while not cancelled:
        time.sleep(0.01)
    return SimpleNamespace(best_program=True, best_code="must not be evaluated")
`,
      );
      for (const signal of ["SIGTERM", "SIGINT"]) {
        const project = join(directory, signal);
        const ready = join(directory, signal + "-ready");
        await mkdir(project);
        const config = join(directory, "empty.yaml");
        await writeFile(config, "{}");
        const child = spawn(
          python,
          [
            join(example, "run.py"),
            "evolve",
            "--project",
            project,
            "--config",
            config,
            "--candidate",
            join(example, "counter", "counter.sv"),
          ],
          {
            env: {
              ...process.env,
              PYTHONPATH: directory,
              PYTHONDONTWRITEBYTECODE: "1",
              CHIPSIM_TEST_READY: ready,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let diagnostics = "";
        child.stderr.on("data", (data) => {
          diagnostics += data;
        });
        const closed = new Promise((resolve) =>
          child.once("exit", (code, signal) => resolve({ code, signal })),
        );
        let started = false;
        try {
          for (let count = 0; count < 100; count++) {
            started = await readFile(ready, "utf8").then(
              () => true,
              () => false,
            );
            if (started || child.exitCode !== null) break;
            await delay(30);
          }
          assert.ok(started, diagnostics);
          child.kill(signal);
          const result = await closed;
          assert.equal(result.code, 130, diagnostics);
          const status = await workStatus(project);
          assert.equal(status.session.status, "cancelled");
          assert.ok(
            status.events.some(
              (event) =>
                event.kind === "summary" && event.status === "cancelled",
            ),
          );
          assert.ok(
            !status.events.some((event) =>
              ["evaluation", "selection"].includes(event.kind),
            ),
          );
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "evolution real isolated Icarus candidates publish scores, evidence, failures and cancellation",
  {
    skip:
      process.env.CHIPSIM_TEST_EVOLUTION !== "1"
        ? "set CHIPSIM_TEST_EVOLUTION=1; requires stock Icarus"
        : false,
    timeout: 180000,
  },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chipsim-evolution-native-"),
    );
    const evaluate = (candidate, extra = []) => {
      const execution = run(
        [
          join(example, "run.py"),
          "evaluate",
          "--project",
          directory,
          "--candidate",
          candidate,
          ...extra,
        ],
        90000,
      );
      assert.ok(
        execution.stdout.trim().startsWith("{"),
        execution.stderr + execution.stdout,
      );
      return { execution, result: JSON.parse(execution.stdout) };
    };
    try {
      const baseline = evaluate(join(example, "counter", "counter.sv"));
      assert.equal(baseline.execution.status, 1, baseline.execution.stderr);
      assert.equal(baseline.result.status, "failed");
      assert.ok(baseline.result.metrics.combined_score > 0);
      assert.ok(baseline.result.metrics.combined_score < 1);
      const correct = evaluate(join(example, "counter", "correct-counter.sv"));
      assert.equal(
        correct.execution.status,
        0,
        correct.execution.stderr + correct.execution.stdout,
      );
      assert.equal(correct.result.status, "passed");
      assert.equal(correct.result.metrics.checks_passed, 80);
      assert.equal(correct.result.metrics.combined_score, 1);
      assert.match(correct.result.evidence.run, /^[a-f0-9]{64}$/);
      assert.match(correct.result.evidence.artifact, /^[a-f0-9]{64}$/);
      assert.notEqual(
        correct.result.evidence.project,
        baseline.result.evidence.project,
      );
      const status = await workStatus(directory, {
        session: correct.result.session,
      });
      assert.equal(status.session.status, "completed");
      assert.equal(status.candidates[0].metrics.combined_score.value, 1);
      assert.equal(status.candidates[0].reporting, "agent-reported");
      assert.ok(
        status.events.some(
          (event) => event.evidence?.job === correct.result.evidence.job,
        ),
      );
      for (const name of ["counter_tb.sv", "score.py"]) {
        assert.equal(
          await readFile(join(correct.result.evidence.project, name), "utf8"),
          await readFile(join(example, "counter", "trusted", name), "utf8"),
        );
      }
      const aliasFile = join(directory, "alias.sv");
      const baselineCode = await readFile(
        join(example, "counter", "counter.sv"),
        "utf8",
      );
      await writeFile(
        aliasFile,
        baselineCode.replace(
          "endmodule",
          String.raw`
        integer f;
        initial begin
          f = $fopen("../metrics.json", "w");
          $fdisplay(f, "{\"combined_score\":999,\"checks_passed\":80,\"checks_total\":80}");
          $fclose(f);
        end
        endmodule`,
        ),
      );
      const alias = evaluate(aliasFile);
      assert.equal(
        alias.result.metrics.combined_score,
        baseline.result.metrics.combined_score,
      );
      assert.equal(
        alias.result.metrics.checks_passed,
        baseline.result.metrics.checks_passed,
      );
      assert.ok(alias.result.artifacts["simulate:out/metrics.json"]);
      assert.ok(alias.result.artifacts["score:out/metrics.json"]);
      assert.notEqual(
        alias.result.artifacts["simulate:out/metrics.json"],
        alias.result.artifacts["score:out/metrics.json"],
      );
      const brokenFile = join(directory, "broken.sv");
      await writeFile(brokenFile, "not verilog at all\n");
      const broken = evaluate(brokenFile);
      assert.equal(broken.execution.status, 1);
      assert.equal(broken.result.status, "failed");
      assert.equal(broken.result.metrics.combined_score, 0);
      assert.equal(broken.result.metrics.checks_passed, undefined);
      assert.ok(broken.result.evidence.job);
      const hangingFile = join(directory, "hanging.sv");
      await writeFile(
        hangingFile,
        `module counter(input clk, reset, enable, output reg [3:0] count);
      initial forever #0 count = 0;
      endmodule
`,
      );
      const timed = evaluate(hangingFile, ["--timeout", "1"]);
      assert.equal(timed.execution.status, 1);
      assert.ok(["inconclusive", "failed"].includes(timed.result.status));
      assert.equal(timed.result.metrics.combined_score, 0);
      assert.ok(timed.result.evidence.job);
      const cancelled = JSON.parse(
        await readFile(
          join(
            timed.result.evidence.project,
            ".chipsim/design/jobs",
            timed.result.evidence.job,
            "state.json",
          ),
          "utf8",
        ),
      );
      assert.ok(["cancelled", "failed"].includes(cancelled.state));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function combinationalWaveform(name) {
  const adder = name === "saturating-adder";
  const top = adder ? "saturating_adder_tb" : "priority_encoder_tb";
  const widths = adder
    ? { a: 4, b: 4, sum: 4 }
    : { request: 8, valid: 1, index: 3 };
  const events = [];
  for (let cycle = 0; cycle < 256; cycle++) {
    const a = Math.floor(cycle / 16),
      b = cycle % 16;
    // Independent enumeration: highest asserted bit, rather than RTL loop ordering.
    const index = cycle === 0 ? 0 : Math.floor(Math.log2(cycle));
    const values = adder
      ? { a, b, sum: a + b > 15 ? 15 : a + b }
      : { request: cycle, valid: Number(cycle !== 0), index };
    events.push({
      time: String(cycle * 10000),
      changes: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          `${top}.${key}`,
          value.toString(2).padStart(widths[key], "0"),
        ]),
      ),
    });
  }
  events.push({ time: "2560000", changes: {} });
  return {
    format: "chipsim-waveform",
    version: 1,
    timescale: { magnitude: "1", unit: "ps" },
    signals: Object.entries(widths).map(([id, width]) => ({
      id: `${top}.${id}`,
      width,
    })),
    events,
  };
}

for (const name of ["saturating-adder", "priority-encoder"]) {
  test(`${name} trusted oracle checks all inputs, unknown outputs and fixed stimulus`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chipsim-evolution-oracle-"),
    );
    try {
      const source = join(directory, "waveform.json"),
        target = join(directory, "metrics.json");
      const evaluate = async (wave) => {
        await writeFile(source, JSON.stringify(wave));
        return run([join(example, name, "trusted/score.py"), source, target]);
      };
      assert.equal((await evaluate(combinationalWaveform(name))).status, 0);
      assert.equal(
        JSON.parse(await readFile(target, "utf8")).checks_passed,
        256,
      );
      const unknown = combinationalWaveform(name);
      const output =
        name === "saturating-adder"
          ? "saturating_adder_tb.sum"
          : "priority_encoder_tb.index";
      unknown.events[23].changes[output] =
        name === "saturating-adder" ? "XXXX" : "XXX";
      assert.equal((await evaluate(unknown)).status, 0);
      assert.equal(
        JSON.parse(await readFile(target, "utf8")).checks_passed,
        255,
      );
      const wrong = combinationalWaveform(name);
      wrong.events[0].changes[output] =
        name === "saturating-adder" ? "1111" : "111";
      assert.equal((await evaluate(wrong)).status, 0);
      assert.equal(
        JSON.parse(await readFile(target, "utf8")).checks_passed,
        255,
      );
      const early = combinationalWaveform(name);
      early.events.pop();
      assert.notEqual((await evaluate(early)).status, 0);
      const stimulus = combinationalWaveform(name);
      const input =
        name === "saturating-adder"
          ? "saturating_adder_tb.a"
          : "priority_encoder_tb.request";
      stimulus.events[0].changes[input] =
        name === "saturating-adder" ? "1111" : "11111111";
      assert.notEqual((await evaluate(stimulus)).status, 0);
      const missing = combinationalWaveform(name);
      missing.signals.pop();
      assert.notEqual((await evaluate(missing)).status, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const [name, baselinePassed] of [
  ["saturating-adder", 136],
  ["priority-encoder", 9],
]) {
  test(
    `${name} real managed baseline and manual fixture retain verified evidence`,
    {
      skip:
        process.env.CHIPSIM_TEST_EVOLUTION !== "1"
          ? "set CHIPSIM_TEST_EVOLUTION=1; requires stock Icarus"
          : false,
      timeout: 180000,
    },
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), `chipsim-${name}-native-`),
      );
      try {
        const evaluate = (candidate) => {
          const execution = run(
            [
              join(example, "run.py"),
              "evaluate",
              "--example",
              name,
              "--project",
              directory,
              ...(candidate ? ["--candidate", candidate] : []),
            ],
            90000,
          );
          assert.ok(
            execution.stdout.trim().startsWith("{"),
            execution.stderr + execution.stdout,
          );
          return { execution, result: JSON.parse(execution.stdout) };
        };
        const baseline = evaluate();
        assert.equal(baseline.execution.status, 1, baseline.execution.stderr);
        assert.equal(baseline.result.metrics.checks_passed, baselinePassed);
        const correct = evaluate(join(example, name, `correct-${name}.sv`));
        assert.equal(
          correct.execution.status,
          0,
          correct.execution.stderr + correct.execution.stdout,
        );
        assert.equal(correct.result.status, "passed");
        assert.equal(correct.result.metrics.checks_total, 256);
        assert.equal(correct.result.metrics.checks_passed, 256);
        assert.equal(correct.result.metrics.combined_score, 1);
        assert.notEqual(
          correct.result.evidence.project,
          baseline.result.evidence.project,
        );
        assert.match(correct.result.evidence.run, /^[a-f0-9]{64}$/);
        const verify = spawnSync(
          process.execPath,
          [
            "scripts/chipsim.mjs",
            "artifact",
            "verify",
            correct.result.evidence.run,
            "--project",
            correct.result.evidence.project,
          ],
          { encoding: "utf8" },
        );
        assert.equal(verify.status, 0, verify.stdout + verify.stderr);
        assert.equal(
          await readFile(
            join(correct.result.evidence.project, "score.py"),
            "utf8",
          ),
          await readFile(join(example, name, "trusted/score.py"), "utf8"),
        );
        const status = await workStatus(directory, {
          session: correct.result.session,
        });
        assert.equal(status.session.status, "completed");
        assert.match(
          status.session.goal,
          name === "saturating-adder" ? /saturating/ : /highest/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
