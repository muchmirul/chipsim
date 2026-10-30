import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  cp,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { startWork, workStatus, appendWorkEvent } from "../src/agent/work.js";
import { verifyEvidence } from "../src/design/evidence.js";
import { Store } from "../src/design/store.js";

const example = resolve("examples/evolutionary-example");
const cli = resolve("scripts/chipsim.mjs");
const python = process.env.PYTHON || "python3";
const native = process.env.CHIPSIM_TEST_EVOLUTION === "1";
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim evolution workflow "));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function py(args, options = {}) {
  const result = spawnSync(python, args, {
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...options.env },
    ...options,
  });
  assert.ifError(result.error);
  return result;
}
function script(code, ...args) {
  return py([
    "-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(example)});\n` + code,
    ...args,
  ]);
}

test("appended evaluations preserve prior adapter configuration and isolate cancellation markers", async (t) => {
  const root = await temporary(t),
    session = await startWork(root, {
      goal: "Existing search",
      mode: "evolution",
    });
  const directory = join(root, "evaluations", session.id);
  await mkdir(directory, { recursive: true });
  const original = '{"example":"counter","timeout":60}\n';
  await writeFile(join(directory, "adapter.json"), original);
  const rejected = py([
    join(example, "run.py"),
    "evaluate",
    "--project",
    root,
    "--session",
    session.id,
    "--example",
    "priority-encoder",
    "--candidate",
    join(root, "missing.sv"),
  ]);
  assert.equal(rejected.status, 2);
  assert.equal(
    await readFile(join(directory, "adapter.json"), "utf8"),
    original,
  );
  assert.deepEqual(await readdir(directory), ["adapter.json"]);
  const isolation = script(
    `import json, uuid
from evaluator import Bridge
from support import write_json
config={"project":sys.argv[1],"session":sys.argv[2],"example":"counter","chipsim":[]}
a=Bridge({**config,"invocation":str(uuid.uuid4())})
b=Bridge({**config,"invocation":str(uuid.uuid4())})
write_json(a.directory/"adapter.json",config,exclusive=True)
try:
    write_json(a.directory/"adapter.json",{},exclusive=True)
    raise AssertionError("overwrote immutable config")
except FileExistsError:
    pass
a.cancel_file.touch()
assert not b.cancel_file.exists()
print(json.dumps({"independent":a.directory!=b.directory}))`,
    root,
    session.id,
  );
  assert.equal(isolation.status, 0, isolation.stderr);
  assert.equal(JSON.parse(isolation.stdout).independent, true);
});

test("custom workflow snapshots validate inputs and reject changed trust bytes and invalid objectives", async (t) => {
  const root = await temporary(t),
    directory = join(root, "definition");
  await cp(join(example, "project-workflow"), directory, { recursive: true });
  const result = script(
    `import copy, json
from pathlib import Path
from workflow import load_workflow, freeze_workflow, copy_inputs, measured_metrics
from support import write_json
file=Path(sys.argv[1])/"workflow.json"
workflow=load_workflow(file)
invocation=Path(sys.argv[1])/"invocation"
invocation.mkdir()
frozen=freeze_workflow(workflow,invocation)
metrics,units=measured_metrics(frozen,{"output_bit_changes":{"value":50,"unit":"bit-transitions"}})
assert metrics=={"output_bit_changes":50,"combined_score":0.75}
assert units["output_bit_changes"]=="bit-transitions"
multi=copy.deepcopy(frozen)
multi["objectives"].append({"name":"rate","unit":"MHz","direction":"maximize","range":[0,100],"weight":3})
metrics,_=measured_metrics(multi,{"output_bit_changes":{"value":50,"unit":"bit-transitions"},"rate":{"value":50,"unit":"MHz"}})
assert metrics["combined_score"]==0.5625
for value in [{},{"output_bit_changes":{"value":1,"unit":"mW"}},{"output_bit_changes":{"value":True,"unit":"bit-transitions"}},{"output_bit_changes":{"value":float("nan"),"unit":"bit-transitions"}}]:
    try:
        measured_metrics(frozen,value)
        raise AssertionError("accepted invalid measurement")
    except ValueError:
        pass
original=json.loads(file.read_text())
for mutation in [{"files":["../secret"]},{"objectives":[{"name":"combined_score","unit":"fraction","direction":"minimize","range":[0,1],"weight":1}]},{"objectives":[{"name":"area","unit":"um2","direction":"minimize","range":[0,0],"weight":1}]}]:
    file.write_text(json.dumps({**original,**mutation}))
    try:
        load_workflow(file)
        raise AssertionError("accepted invalid workflow")
    except ValueError:
        pass
# Edits to the authoring template do not alter the frozen invocation.
(Path(workflow["template"])/"counter.sv").write_text("changed authoring RTL")
copy_inputs(frozen,Path(sys.argv[1])/"unchanged-copy")
(Path(frozen["template"])/"score.py").write_text("changed frozen oracle")
try:
    copy_inputs(frozen,Path(sys.argv[1])/"tampered-copy")
    raise AssertionError("accepted changed trust bytes")
except ValueError:
    pass
print("verified")`,
    directory,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified/);
});

test("optimizer checkpoint lineage maps actual evaluation identities, retaining metrics and identical-code children", async (t) => {
  const root = await temporary(t),
    session = await startWork(root, {
      goal: "Lineage fixture",
      mode: "evolution",
    });
  const invocation = randomUUID(),
    directory = join(
      root,
      "evaluations",
      session.id,
      "invocations",
      invocation,
    );
  const parents = [randomUUID(), randomUUID()],
    attempts = [randomUUID(), randomUUID()];
  const code = "module counter; endmodule\n",
    hash = createHash("sha256").update(code).digest("hex");
  const checkpoint = join(
    directory,
    "openevolve/checkpoints/checkpoint_1/programs",
  );
  await mkdir(checkpoint, { recursive: true });
  for (let i = 0; i < 2; i++) {
    const id = "eval-" + attempts[i];
    await mkdir(join(directory, attempts[i]));
    await writeFile(
      join(directory, attempts[i], "evaluation.json"),
      JSON.stringify({ candidate: id, source_sha256: hash }),
    );
    await appendWorkEvent(root, session.id, {
      kind: "evaluation",
      candidate: id,
      status: "passed",
      message: "Measured fixture",
      metrics: { score: { value: 0.75, unit: "fraction" } },
    });
    await writeFile(
      join(checkpoint, parents[i] + ".json"),
      JSON.stringify({
        id: parents[i],
        parent_id: i ? parents[0] : null,
        generation: i,
        code,
        artifacts_json: JSON.stringify({ candidate_id: id }),
      }),
    );
  }
  await writeFile(
    join(directory, "selected.json"),
    JSON.stringify({ id: parents[1] }),
  );
  await writeFile(
    join(checkpoint, randomUUID() + ".json"),
    JSON.stringify({
      id: randomUUID(),
      parent_id: parents[0],
      generation: 2,
      code,
      artifacts_json: JSON.stringify({ candidate_id: "eval-" + attempts[1] }),
    }),
  );
  await writeFile(
    join(checkpoint, "malformed.json"),
    JSON.stringify({
      id: randomUUID(),
      generation: 2,
      code,
      artifacts_json: "[]",
    }),
  );
  const result = script(
    `import json
from evaluator import Bridge
from lineage import Lineage
bridge=Bridge(json.loads(sys.argv[1]))
lineage=Lineage(bridge)
lineage.update()
lineage.update()
print(lineage.selected())
from pathlib import Path
source=bridge.directory/"selected.sv"
source.write_text("different RTL")
try:
    lineage.selected(source)
    raise AssertionError("associated selection with different evaluated code")
except ValueError:
    pass`,
    JSON.stringify({
      project: root,
      session: session.id,
      invocation,
      chipsim: [process.execPath, cli],
      timeout: 30,
      debug: false,
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "eval-" + attempts[1]);
  const status = await workStatus(root, { session: session.id });
  assert.equal(status.candidates[0].generation, 0);
  assert.equal(status.candidates[1].generation, 1);
  assert.equal(status.candidates[1].parent, status.candidates[0].id);
  assert.equal(status.candidates[1].metrics.score.value, 0.75);
  assert.equal(
    status.events.filter((event) => event.stage === "lineage").length,
    2,
  );
});

test(
  "overall evolution budget interrupts an indefinitely waiting optimizer without accepting its best-so-far result",
  { timeout: 20000 },
  async (t) => {
    const root = await temporary(t),
      packageDir = join(root, "openevolve");
    await mkdir(packageDir);
    await writeFile(
      join(packageDir, "config.py"),
      "from types import SimpleNamespace\ndef load_config(path): return SimpleNamespace(evaluator=SimpleNamespace())\n",
    );
    // API/cancellation protocol fixture. No model turn or evolutionary search.
    await writeFile(
      join(packageDir, "__init__.py"),
      `import signal,time
from types import SimpleNamespace
def run_evolution(**kwargs):
    stopped=False
    def term(signum,frame):
        nonlocal stopped
        stopped=True
    signal.signal(signal.SIGTERM,term)
    while not stopped: time.sleep(.01)
    return SimpleNamespace(best_program=SimpleNamespace(id="discarded"),best_code="must not be accepted")
`,
    );
    const yaml = join(root, "optimizer.yaml");
    await writeFile(yaml, "{}");
    const before = Date.now();
    const result = py(
      [
        join(example, "run.py"),
        "evolve",
        "--project",
        root,
        "--config",
        yaml,
        "--search-timeout",
        "1",
      ],
      {
        env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    assert.equal(result.status, 124, result.stderr);
    assert.ok(Date.now() - before < 12000);
    const status = await workStatus(root);
    assert.equal(status.session.status, "failed");
    assert.match(status.events.at(-1).message, /wall-time budget exhausted/);
    assert.ok(!status.events.some((event) => event.kind === "selection"));
  },
);

test(
  "project-defined managed objectives use sealed reports, real simulation and correctness gating",
  { skip: !native, timeout: 180000 },
  async (t) => {
    const root = await temporary(t),
      definition = join(root, "definition");
    await cp(join(example, "project-workflow"), definition, {
      recursive: true,
    });
    const evaluate = (candidate) => {
      const result = py([
        join(example, "run.py"),
        "evaluate",
        "--project",
        root,
        "--workflow",
        join(definition, "workflow.json"),
        ...(candidate ? ["--candidate", candidate] : []),
      ]);
      assert.ok(result.stdout.startsWith("{"), result.stderr);
      return { execution: result, result: JSON.parse(result.stdout) };
    };
    const baseline = evaluate();
    assert.equal(baseline.execution.status, 1, baseline.execution.stderr);
    assert.equal(baseline.result.status, "failed");
    assert.equal(baseline.result.metrics.combined_score, -1);
    const correct = evaluate(join(example, "counter/correct-counter.sv"));
    assert.equal(
      correct.execution.status,
      0,
      correct.execution.stderr + correct.execution.stdout,
    );
    assert.equal(correct.result.status, "passed");
    assert.equal(correct.result.measured, true);
    assert.equal(
      correct.result.metric_units.output_bit_changes,
      "bit-transitions",
    );
    assert.equal(
      correct.result.metrics.combined_score,
      1 - correct.result.metrics.output_bit_changes / 200,
    );
    await verifyEvidence(
      new Store(correct.result.evidence.project),
      correct.result.evidence.run,
    );
    assert.ok(correct.result.artifacts["activity:out/metrics.json"]);
    assert.ok(correct.result.evaluation_contract.sha256["score.py"]);
    const invocation = join(
      root,
      "evaluations",
      correct.result.session,
      "invocations",
      correct.result.invocation,
    );
    const config = JSON.parse(await readFile(join(invocation, "adapter.json")));
    assert.equal(config.workflow.template, join(invocation, "trusted"));
  },
);

test(
  "optimizer API protocol retains measured ancestry through a fresh finalist job",
  { skip: !native, timeout: 180000 },
  async (t) => {
    const root = await temporary(t),
      packageDir = join(root, "openevolve");
    await mkdir(packageDir);
    await writeFile(
      join(packageDir, "config.py"),
      "from types import SimpleNamespace\ndef load_config(path): return SimpleNamespace(evaluator=SimpleNamespace())\n",
    );
    await writeFile(
      join(packageDir, "evaluation_result.py"),
      "class EvaluationResult:\n    def __init__(self,metrics,artifacts): self.metrics=metrics; self.artifacts=artifacts\n",
    );
    // Exercise the public optimizer callback/checkpoint protocol with fixed RTL.
    // This fixture makes no model requests and performs no candidate search.
    await writeFile(
      join(packageDir, "__init__.py"),
      `import importlib.util,json,uuid
from pathlib import Path
from types import SimpleNamespace
def run_evolution(initial_program,evaluator,output_dir,**kwargs):
    spec=importlib.util.spec_from_file_location("bridge_fixture",evaluator)
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    code=Path(initial_program).read_text()
    directory=Path(output_dir)/"checkpoints"/"checkpoint_1"/"programs"
    directory.mkdir(parents=True)
    parent=None
    for generation in range(2):
        result=module.evaluate(initial_program)
        program=str(uuid.uuid4())
        (directory/(program+".json")).write_text(json.dumps({"id":program,"parent_id":parent,"generation":generation,"code":code,"artifacts_json":json.dumps(result.artifacts)}))
        parent=program
    return SimpleNamespace(best_program=SimpleNamespace(id=program),best_code=code)
`,
    );
    const yaml = join(root, "optimizer.yaml");
    await writeFile(yaml, "{}");
    const result = py(
      [
        join(example, "run.py"),
        "evolve",
        "--project",
        root,
        "--config",
        yaml,
        "--candidate",
        join(example, "counter/correct-counter.sv"),
        "--search-timeout",
        "90",
      ],
      {
        env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const final = JSON.parse(result.stdout),
      status = await workStatus(root);
    assert.equal(status.session.status, "completed");
    assert.equal(
      status.candidates.length,
      2,
      "same RTL bytes remain distinct optimizer individuals",
    );
    assert.equal(status.candidates[0].generation, 0);
    assert.equal(status.candidates[1].generation, 1);
    assert.equal(status.candidates[1].parent, status.candidates[0].id);
    assert.equal(final.candidate, status.candidates[1].id);
    assert.equal(status.candidates[1].metrics.combined_score.value, 1);
    const evaluated = status.events.filter(
      (event) => event.kind === "evaluation",
    );
    assert.equal(evaluated.length, 3);
    assert.equal(new Set(evaluated.map((event) => event.evidence.job)).size, 3);
    assert.equal(evaluated[2].candidate, evaluated[1].candidate);
    await verifyEvidence(new Store(final.evidence.project), final.evidence.run);
  },
);

test(
  "overall budget also cancels a managed finalist simulation",
  { skip: !native, timeout: 30000 },
  async (t) => {
    const root = await temporary(t),
      packageDir = join(root, "openevolve");
    await mkdir(packageDir);
    await writeFile(
      join(packageDir, "config.py"),
      "from types import SimpleNamespace\ndef load_config(path): return SimpleNamespace(evaluator=SimpleNamespace())\n",
    );
    await writeFile(
      join(packageDir, "__init__.py"),
      `from types import SimpleNamespace
def run_evolution(**kwargs):
    return SimpleNamespace(best_program=SimpleNamespace(id="unobserved-fixture"),best_code="module counter(input clk,reset,enable,output reg [3:0] count); initial forever #0 count=0; endmodule")
`,
    );
    const yaml = join(root, "optimizer.yaml");
    await writeFile(yaml, "{}");
    const result = py(
      [
        join(example, "run.py"),
        "evolve",
        "--project",
        root,
        "--config",
        yaml,
        "--search-timeout",
        "3",
      ],
      {
        env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    assert.equal(result.status, 124, result.stderr);
    const status = await workStatus(root);
    assert.equal(status.session.status, "failed");
    assert.ok(!status.events.some((event) => event.kind === "selection"));
    const evaluation = status.events.find(
      (event) => event.kind === "evaluation",
    );
    assert.equal(evaluation.status, "inconclusive");
    assert.ok(evaluation.evidence.job);
    const job = py([
      "-c",
      `import subprocess,sys
p=subprocess.run([${JSON.stringify(process.execPath)},${JSON.stringify(cli)},"job","status",sys.argv[2],"--project",sys.argv[1],"--wait","--timeout-ms","5000"],capture_output=True,text=True)
print(p.stdout); sys.exit(p.returncode)`,
      evaluation.evidence.project,
      evaluation.evidence.job,
    ]);
    assert.equal(job.status, 0, job.stderr);
    assert.equal(JSON.parse(job.stdout).job.state, "cancelled");
  },
);
