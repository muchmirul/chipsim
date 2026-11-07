import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workStatus } from "../src/agent/work.js";

const python = process.env.PYTHON || "python3";
const example = resolve("examples/evolution");
function run(args, timeout = 30000, env = {}) {
  const result = spawnSync(python, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
  });
  assert.ifError(result.error);
  return result;
}

test("ALU oracle, fixed binary coverage and bounded reports need no EDA tools", () => {
  const result = run(["test/alu-oracle-test.py"]);
  assert.equal(result.status, 0, result.stderr);
  const help = run([join(example, "run.py"), "--help"]);
  assert.match(help.stdout, /counter,alu8/);
});

test(
  "ALU native evaluation gates synthesis on exhaustive checks and validates the synthesized netlist",
  {
    skip:
      process.env.CHIPSIM_TEST_ALU !== "1"
        ? "set CHIPSIM_TEST_ALU=1; requires Icarus and Yosys"
        : false,
    timeout: 900000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chipsim-alu-native-"));
    const evaluate = (candidate, extra = [], env = {}) => {
      const result = run(
        [
          join(example, "run.py"),
          "evaluate",
          "--benchmark",
          "alu8",
          "--project",
          directory,
          ...(candidate ? ["--candidate", candidate] : []),
          ...extra,
        ],
        330000,
        env,
      );
      assert.ok(
        result.stdout.trim().startsWith("{"),
        result.stderr + result.stdout,
      );
      return { process: result, value: JSON.parse(result.stdout) };
    };
    try {
      const baseline = evaluate();
      assert.equal(
        baseline.process.status,
        0,
        baseline.process.stderr + baseline.process.stdout,
      );
      const value = baseline.value;
      assert.equal(value.status, "passed");
      assert.equal(value.stages.exhaustive.report.checks_passed, 524288);
      assert.equal(value.stages.netlist.report.checks_passed, 524288);
      assert.equal(
        value.metrics.combined_score,
        1 / (1 + value.metrics.cell_count),
      );
      assert.match(value.report_artifact, /^[a-f0-9]{64}$/);
      assert.equal(
        (await workStatus(directory, { session: value.session })).session
          .status,
        "completed",
      );
      const shared = evaluate(join(example, "alu8/shared-adder.sv"));
      assert.equal(
        shared.process.status,
        0,
        shared.process.stderr + shared.process.stdout,
      );
      assert.equal(
        shared.value.metrics.combined_score,
        1 / (1 + shared.value.metrics.cell_count),
      );
      assert.notEqual(shared.value.evidence.project, value.evidence.project);
      console.log(
        `ALU measured generic cells: baseline=${value.metrics.cell_count}, shared-adder=${shared.value.metrics.cell_count}`,
      );
      const code = await readFile(join(example, "alu8/alu.sv"), "utf8");
      for (const [name, altered] of [
        [
          "carry",
          code.replace(
            "{carry, result} = {1'b0, A} + {1'b0, B};",
            "result = A + B;",
          ),
        ],
        [
          "overflow",
          code.replace(
            "overflow = (A[7] == B[7]) && (result[7] != A[7]);",
            "overflow = 0;",
          ),
        ],
        ["opcode", code.replace("2: result = A & B;", "2: result = A | B;")],
        ["unknown", code.replace("2: result = A & B;", "2: result = 8'bx;")],
      ]) {
        const file = join(directory, name + ".sv");
        await writeFile(file, altered);
        const bad = evaluate(file).value;
        assert.equal(bad.status, "failed", JSON.stringify(bad));
        assert.equal(bad.metrics.combined_score, 0);
        assert.equal(bad.stages.synthesis, undefined);
        assert.ok(bad.failures.length > 0 && bad.failures.length <= 16);
        assert.ok(bad.stages.replay.ready);
      }
      const mismatch = join(directory, "mismatch.sv");
      await writeFile(
        mismatch,
        code.replace(
          "zero = result == 0;",
          "`ifdef SYNTHESIS\n result = 0;\n`endif\n zero = result == 0;",
        ),
      );
      const rejected = evaluate(mismatch).value;
      assert.equal(rejected.stages.exhaustive.ready, true);
      assert.equal(rejected.stages.netlist.ready, false);
      assert.equal(rejected.metrics.combined_score, 0);
      assert.equal(rejected.replay_source, "netlist.v");
      const broken = join(directory, "broken.sv");
      await writeFile(broken, "not verilog\n");
      const compile = evaluate(broken).value;
      assert.equal(compile.status, "failed");
      assert.equal(compile.metrics.checks_passed, undefined);
      assert.ok(compile.stages.directed.job);
      const timeout = evaluate(undefined, ["--timeout", "1"]).value;
      assert.equal(timeout.metrics.combined_score, 0);
      assert.notEqual(timeout.status, "passed");
      const toolDirectory = join(directory, "without-yosys");
      await mkdir(toolDirectory);
      const tools = JSON.parse(
        run([
          "-c",
          "import json,shutil; print(json.dumps({n:shutil.which(n) for n in ['python3','node','iverilog','vvp']}))",
        ]).stdout,
      );
      for (const [name, path] of Object.entries(tools))
        await symlink(path, join(toolDirectory, name));
      const missing = evaluate(undefined, [], { PATH: toolDirectory }).value;
      assert.equal(missing.status, "failed");
      assert.equal(missing.metrics.cell_count, undefined);
      assert.equal(missing.metrics.combined_score, 0);
      assert.match(missing.message, /Missing tool: yosys/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "ALU search protocol independently rejects a corrupted optimizer-selected winner",
  {
    skip:
      process.env.CHIPSIM_TEST_ALU !== "1"
        ? "set CHIPSIM_TEST_ALU=1; provider-free API fixture"
        : false,
    timeout: 450000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chipsim-alu-protocol-"));
    try {
      const fixture = join(directory, "protocol-fixture");
      await mkdir(join(fixture, "openevolve"), { recursive: true });
      await writeFile(
        join(fixture, "openevolve/__init__.py"),
        `
from pathlib import Path
from types import SimpleNamespace
import importlib.util
def run_evolution(**kwargs):
    assert kwargs['config'].language == 'verilog'
    spec = importlib.util.spec_from_file_location('bridge_evaluator', kwargs['evaluator'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    evaluated = module.evaluate(kwargs['initial_program'])
    assert evaluated.metrics['combined_score'] > 0
    code = Path(kwargs['initial_program']).read_text()
    # Deliberately corrupt the selected return value after a real passing evaluation.
    code = code.replace("{carry, result} = {1'b0, A} + {1'b0, B};", "result = A + B;")
    return SimpleNamespace(best_program=True, best_code=code)
`,
      );
      await writeFile(
        join(fixture, "openevolve/config.py"),
        `
from types import SimpleNamespace
def load_config(path):
    return SimpleNamespace(evaluator=SimpleNamespace())
`,
      );
      await writeFile(
        join(fixture, "openevolve/evaluation_result.py"),
        `
class EvaluationResult:
    def __init__(self, metrics, artifacts):
        self.metrics, self.artifacts = metrics, artifacts
`,
      );
      const config = join(directory, "fixture.yaml");
      await writeFile(
        config,
        "# Provider-free protocol fixture; no search or model calls\n",
      );
      const process = run(
        [
          join(example, "run.py"),
          "evolve",
          "--benchmark",
          "alu8",
          "--project",
          directory,
          "--config",
          config,
          "--iterations",
          "1",
        ],
        420000,
        { PYTHONPATH: fixture },
      );
      assert.equal(process.status, 1, process.stderr + process.stdout);
      const result = JSON.parse(process.stdout);
      assert.equal(result.status, "failed");
      assert.equal(result.metrics.combined_score, 0);
      assert.equal(result.stages.synthesis, undefined);
      const status = await workStatus(directory, { session: result.session });
      const evaluations = status.events.filter(
        (event) => event.kind === "evaluation",
      );
      assert.equal(evaluations.length, 2);
      assert.equal(evaluations[0].status, "passed");
      assert.equal(evaluations[1].status, "failed");
      assert.notEqual(
        evaluations[0].evidence.project,
        evaluations[1].evidence.project,
      );
      assert.equal(status.session.status, "failed");
      assert.ok(
        status.events.some(
          (event) => event.kind === "selection" && event.status === "failed",
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "ALU interruption cancels an active managed simulation and closes its session",
  {
    skip:
      process.env.CHIPSIM_TEST_ALU !== "1"
        ? "set CHIPSIM_TEST_ALU=1; requires Icarus"
        : false,
    timeout: 90000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chipsim-alu-cancel-"));
    try {
      const code = await readFile(join(example, "alu8/alu.sv"), "utf8");
      const candidate = join(directory, "hang.sv");
      await writeFile(
        candidate,
        code.replace("endmodule", "initial forever #0 result = 0;\nendmodule"),
      );
      const execution = run(
        [
          "-c",
          `
import json, signal, subprocess, sys, time
from pathlib import Path
runner, project, candidate, cli = sys.argv[1:]
child = subprocess.Popen([sys.executable, runner, 'evaluate', '--benchmark', 'alu8', '--project', project, '--candidate', candidate], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
job = None
try:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        for path in Path(project).glob('evaluations/*/*/.chipsim/design/jobs/*/state.json'):
            state = json.loads(path.read_text())
            if state.get('tasks', {}).get('simulate-directed', {}).get('state') == 'running':
                job = state
                break
        if job:
            break
        assert child.poll() is None, 'adapter exited before simulation'
        time.sleep(.1)
    assert job, 'simulation did not start'
    child.send_signal(signal.SIGINT)
    stdout, stderr = child.communicate(timeout=15)
    assert child.returncode == 130, (child.returncode, stdout, stderr)
    print(json.dumps(job))
finally:
    if job:
        subprocess.run(['node', cli, 'job', 'cancel', job['id'], '--project', job['project']], stdout=subprocess.DEVNULL, check=True)
    if child.poll() is None:
        child.kill()
        child.communicate()
`,
          join(example, "run.py"),
          directory,
          candidate,
          resolve("scripts/chipsim.mjs"),
        ],
        85000,
      );
      assert.equal(execution.status, 0, execution.stderr + execution.stdout);
      const job = JSON.parse(execution.stdout);
      const status = await workStatus(directory);
      assert.equal(status.session.status, "cancelled");
      assert.equal(status.candidates[0].status, "cancelled");
      const recorded = JSON.parse(
        await readFile(
          join(job.project, ".chipsim/design/jobs", job.id, "state.json"),
          "utf8",
        ),
      );
      assert.equal(recorded.state, "cancelled");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "ALU debug replay fits the real observer's capture bounds",
  {
    skip:
      process.env.CHIPSIM_TEST_ALU_DEBUG !== "1"
        ? "set CHIPSIM_TEST_ALU_DEBUG=1; requires Icarus observers"
        : false,
    timeout: 180000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chipsim-alu-debug-"));
    try {
      const code = await readFile(join(example, "alu8/alu.sv"), "utf8");
      const file = join(directory, "bad-carry.sv");
      await writeFile(
        file,
        code.replace(
          "{carry, result} = {1'b0, A} + {1'b0, B};",
          "result = A + B;",
        ),
      );
      const execution = run(
        [
          join(example, "run.py"),
          "evaluate",
          "--benchmark",
          "alu8",
          "--project",
          directory,
          "--candidate",
          file,
          "--debug",
        ],
        170000,
      );
      assert.equal(execution.status, 1, execution.stderr + execution.stdout);
      const result = JSON.parse(execution.stdout);
      assert.equal(result.status, "failed");
      assert.equal(
        result.stages.replay.ready,
        true,
        JSON.stringify(result.stages.replay),
      );
      assert.equal(
        result.evidence.artifact,
        result.stages.replay.artifacts["replay:out/debug.json"],
      );
      const inspected = spawnSync(
        process.execPath,
        [
          "scripts/chipsim.mjs",
          "artifact",
          "inspect",
          result.evidence.artifact,
          "--project",
          result.evidence.project,
        ],
        { encoding: "utf8" },
      );
      assert.equal(inspected.status, 0, inspected.stderr);
      assert.ok(
        JSON.parse(inspected.stdout).artifact.capabilities.includes(
          "hdl-events",
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
