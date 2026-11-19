# Text-based evolution workflows

ChipSim scores RTL against fixed hardware tests and retains verifiable evidence. Use `chipsim benchmark` from a shell or the `chipsim_benchmark_*` tools over MCP for one measurement at a time. Use the separate Pi Durable goal service for explicitly requested persistent search. For setup and workflow selection see [AGENT_CONNECTIONS.md](AGENT_CONNECTIONS.md) and [AGENT_QUICKSTART.md](AGENT_QUICKSTART.md).

ChipSim evaluates one editable Verilog/SystemVerilog file against fixed tests,
reports useful failures, and retains evidence. OpenEvolve supplies the optional
external search. No PDF, browser, model provider, or interactive viewer is needed
to evaluate, compare, or reproduce candidates.

For multiple weighted measured objectives or VHDL, use the separate
[project-defined workflow runner](EVOLUTION_OBJECTIVES.md). Its
`chipsim-evolution-workflow` definition and `--workflow` flags are distinct from
this command family's `chipsim-evolution-benchmark` and `--benchmark`.

## Standalone benchmarking and durable search

Use `chipsim benchmark list|describe|validate|evaluate|report|compare|reproduce` for native benchmarks. For weighted Verilog and VHDL goals, use `chipsim benchmark evaluate --workflow workflow.json --project WORK`. Standalone evaluations store the hardware evidence independently of an activity journal. The two older search launchers and manual journal writers are deprecated for one release. They still execute in this release. Their planned retirement depends on the released Pi/ChipSim integration passing the hardware and recovery tests. Historical reports and activity sessions remain readable.

### Score a candidate over MCP

1. Use `chipsim_project({})` to confirm the bound root. Call `chipsim_benchmark_prepare({benchmark: "counter", formal: true})` for the bundled counter with equivalence. Use `"alu8"` or a project-relative definition for other benchmarks. For a weighted workflow, declare required proofs in its design target and omit `formal`.
2. Save `context`, `candidatePath` and `fixedHashes`. When the response includes `candidateResource` and `candidateHash`, read that URI with `resources/read` or `chipsim_resource_read` for the exact baseline. Otherwise read the original RTL from your project or use the packaged built-in baseline beside `examples.nativeEvolution.runner` in `chipsim agent help` (`counter.sv` or `alu8/alu.sv)). Keep the context for every comparable proposal.
3. Call `chipsim_benchmark_start` with `context`, candidate text in `content` (UTF-8 up to 64 KiB), its exact SHA-256 in `candidateHash` and a stable `requestId`. Resubmit identical arguments to reconcile a lost reply. A changed candidate or context needs a new request ID. Every new benchmark job runs fresh stages.
4. Poll `chipsim_job_status` with the returned `job` ID or the original `requestId`. Use `chipsim_job_logs` for progress and `chipsim_job_cancel` to stop owned execution. Keep the outer project candidate ID in these calls if you prepared and started the job in that candidate.
5. Call `chipsim_benchmark_result({job})` after completion. Read `accepted`, `score`, `metrics`, `units`, `feedback`, `formal` when present and the evidence links. A usable measurement may reject the candidate. An interrupted evaluation, missing tool or invalid evidence leaves no accepted measurement.

Read the full outer report using its top-level `artifact` ID and `chipsim_artifact_read`. To inspect a native stage, use the stage run ID from `stages` or `evidence.run` with `chipsim_artifacts({run, benchmarkJob})`. Pass the returned `evidence.benchmarkJob` with the selected native artifact in `chipsim_artifact_read`, `chipsim_hardware`, `chipsim_source`, `chipsim_trace` or `chipsim_snapshot`. Keep the same outer candidate scope. This gives a second client access to the reports and waveforms through the same project-bound MCP connection.

### Run a persistent Pi Durable search

On the Pi Durable connection, call `helper_info({includeGuide: true})` and select the ChipSim example under `evolution.examples`. The job uses `brief.mode: "evolution"` and `brief.evolution.evaluator.type: "chipsim"`, a registered connection bound to `brief.cwd`, one project-relative candidate file and the `hardware` criterion. Pi Durable freezes the inputs, measures a baseline with ChipSim, asks a Pi model for proposals, and lets OpenEvolve rank and sample measured candidates. The job's final verification comes from a fresh ChipSim run. Read `job_status` on Pi Durable for lineage and the selected change, then inspect linked ChipSim results on this connection.

## Standalone CLI commands

```sh
chipsim benchmark list
chipsim benchmark describe --benchmark alu8 --format text
chipsim benchmark validate --benchmark ./benchmark.json
mkdir -p ./work
chipsim benchmark evaluate --benchmark counter --project ./work > before.json
chipsim benchmark evaluate --benchmark counter --candidate ./fixed-counter.sv \
  --project ./work > after.json
chipsim benchmark report before.json --format text
chipsim benchmark compare before.json after.json --format text
chipsim benchmark reproduce before.json --project ./work
chipsim benchmark reproduce before.json --case 0 --project ./work
```

The default counter is deliberately incorrect, so its evaluation exits 1 while
retaining a useful report. Bundled `correct-counter.sv` is a handwritten passing
fixture. `alu8` provides exhaustive RTL and synthesized-netlist checks and a
generic-cell objective; its `shared-adder.sv` is another handwritten fixture.
These demonstrations are not evidence that an AI search was run.

The installed command uses `PYTHON` or `python3`. Python 3.10+ and Node.js 22.13+
are required; EDA tools are installed separately. `list`, `describe`, `validate`,
`report`, and `compare` do not run EDA tools or model providers. Custom validation
checks declared task inputs and locked dependencies for evaluation, formal, and
replay targets without probing executables. Only `replay-case.json` is supplied
later for the replay target; its other dependencies must already exist and be
included in the frozen file inventory.

## Output and feedback

Default stdout is one `chipsim-evolution-result`, version 1, containing `command`,
`ok`, and `result`. Progress and external optimizer diagnostics go to stderr.
`--format text` selects readable output. Evaluation exits 0 only on acceptance;
failures/inconclusive evaluations exit 1 and interruption exits 130. Read-only
comparison succeeds even when the reports are not comparable; inspect its
`comparable`, `reasons`, and `winner` fields.

Saved evaluations use `chipsim-evolution-evaluation`, version 2. Existing version
1 reports remain readable; missing failure details, contexts, and snapshots are
not inferred. The existing Python `examples/evolution/run.py` commands share the
implementation and retain their unwrapped JSON output.

Reports include candidate identity, acceptance, stage outcomes and checks,
measurements, diagnostics, exact project/job/run/artifact links, and up to 16
normalized failure cases. A counter case includes its cycle and control inputs;
an ALU case includes operands, opcode, expected outputs, and observed outputs.
X/Z values remain failures rather than being coerced to zero. Missing tools,
timeouts, invalid evidence, and incomplete runs cannot establish correctness.
Stage reports retain their detailed native context. OpenEvolve receives the same
readable feedback, bounded to 8 KiB, plus evidence links.

The counter keeps `checks_passed / 80` as repair progress even when it is not
accepted. The ALU earns `1 / (1 + cell_count)` only after all required checks pass.
Unavailable measurements are omitted. Zero used as an optimizer penalty does not
mean that a tool measured zero checks, cells, or timing.

Reports remain **agent-reported**. Artifact verification establishes byte and
producer identity, not the correctness of an author-supplied specification.

## Custom benchmark definitions

Copy the installed `examples/evolution/custom-counter` directory to a new project.
Use `agent help` → `examples.nativeEvolution.customBenchmark` to find its exact
installed definition path; copy that definition's containing directory.
It contains a runnable counter, independent oracle, ordinary design targets,
formal reference, and a prefix replay recipe. Change the trusted files deliberately
before starting a new search; only the declared candidate is mutable during it.

`benchmark.json` uses this contract:

```json
{
  "format": "chipsim-evolution-benchmark",
  "version": 1,
  "id": "my-counter",
  "description": "Repair the counter against fixed observations",
  "interface": "Four-bit count; rising clock, synchronous reset and enable",
  "candidate": "counter.sv",
  "files": [
    "chipsim.design.json",
    "chipsim.lock.json",
    "counter.sv",
    "counter_tb.sv",
    "sim.project.json",
    "stage.py",
    "oracle.py"
  ],
  "timeout": 120,
  "objective": {
    "metric": "combined_score",
    "direction": "maximize",
    "unit": "fraction"
  },
  "stages": [
    {
      "target": "evaluate",
      "expected_checks": 80,
      "report": { "task": "score", "path": "out/stage.json" }
    }
  ]
}
```

Paths are relative to the definition. Declare every fixed source, test, script,
configuration, and manifest used by the selected tasks. The candidate must be
one listed `.v` or `.sv` file. Files are regular files without symlinks or path
traversal. There are at most 512 files, 32 MiB total, and 32 ordered stages.
The candidate retains the 64 KiB bound. `publish` and evolution report paths are
reserved. Built-in engine definitions are fixed; custom definitions use ordinary
design targets rather than importing Python plugins.

Each stage names an existing design target with explicit required checks. The
existing design manifest describes commands, task dependencies, bindings, and
outputs; see [DESIGN.md](DESIGN.md). A separate trusted scoring task publishes:

```json
{
  "format": "chipsim-evolution-stage",
  "version": 1,
  "metrics": { "checks_passed": 80, "checks_total": 80, "combined_score": 1 },
  "cases": []
}
```

Metrics must be finite numbers, with at most 32 names. The scorer supplies a
nonnegative `combined_score` to maximize and the declared objective measurement.
The objective's direction and unit describe comparison of that measurement;
they do not automatically transform it into a fitness formula. Authors implement
that formula in their fixed scoring task. Custom optimization scores are zero
unless every required stage passes. When counts are supplied, passed/total must
be consistent and match `expected_checks` when declared. Cases contain `check`,
`inputs`, `expected`, and `observed`; additional history fields may support replay.
There may be at most 16 cases per report. Reports are bounded to 64 KiB.
The sealed aggregate evaluation is bounded to 256 KiB; keep stage reports concise
and retain larger logs or observations as linked native artifacts.

The definition names the exact producing task and output path. A same-named file
from the candidate simulation cannot replace the trusted report. A successful
process alone does not satisfy the required behavioral checks.

## Formal acceptance

Add `--formal` to `evaluate` or `evolve` to require the bundled equivalence recipe.
Counter and ALU runs normally work without EQY. Once enabled, proof must pass
before acceptance; missing tools, timeout, or an unproven result yield zero fitness.
The selected search winner independently repeats the required checks and proof.

For a custom benchmark add:

```json
"formal": {
  "target": "formal", "required": false, "reference": "reference.sv",
  "scope": "Counter from the first synchronous reset onward",
  "assumptions": ["Reset asserted at the first sampled clock"]
}
```

The reference must be a fixed input distinct from the candidate. The target must
require an EQY equivalence check consuming both. Set `required: true` to make
proof mandatory for every run; CLI flags cannot weaken that policy. Native EQY
configuration remains author-supplied and is captured with the evidence.

Bundled recipes use the Yosys SAT strategy. The counter wrapper forces reset at
the first sampled clock; subsequent reset/enable inputs remain unconstrained.
The ALU proof covers its binary combinational behavior. Initialization assumptions
and scope are explicit, not inferred from simulation. An EQY `FAIL` means
equivalence was not established; it is not automatically a demonstrated mismatch.
Native logs and any available counterexample artifacts remain inspectable.

## Comparing and reproducing results

Comparison verifies the sealed report and stage evidence, then checks the
definition, fixed input hashes, settings, relevant tool identities, evaluator,
and ChipSim runtime. Candidate source hashes may differ. Different contexts or
incomplete evidence are listed and prevent ranking. Accepted candidates outrank
rejected ones only under comparable conditions. Generic cells are a size proxy,
not physical area, timing, or power. A zero baseline has no percentage change.

Every evaluation stores the frozen definition and input bytes as a managed
artifact alongside its sealed summary. Full reproduction restores those bytes
into a fresh isolated project, requires the recorded executable identities and
runtime, and validates locked dependencies. It never rereads the original source
project or overwrites the original evaluation. A missing snapshot or changed
tool/runtime gives an actionable error; use a new evaluation to intentionally
change the setup. Reproduction does not install missing dependencies.

Focused replay preserves an ALU's exact vector, and uses the captured synthesized
netlist when that is where the failure occurred. Counter replay keeps every cycle
from initialization through the failing cycle. It checks actual captured stimulus
and observed results against the saved failure. A reproduced failure is not a
passing hardware design, and a replay never establishes full benchmark acceptance.

Custom benchmarks can declare `replay.target` and `replay.report` with a task/path
like evaluation stages. Validation walks that target's dependency graph, including
bound producer tasks and HDL project inputs. Declare its fixed inputs in `files`;
missing or unlisted dependencies reject validation and evaluation before freezing
inputs. Validation is read-only and permits the generated `replay-case.json` only
for this target. The target consumes `replay-case.json` and publishes
`chipsim-evolution-replay`, version 1, with boolean `reproduced`. Require that field
as a native design check. The custom-counter example shows how to retain history.
Without a replay recipe, full reproduction remains available and `--case` fails
explicitly. Compile errors and incomplete runs may have no behavioral case.

## Legacy search and journal compatibility

This section documents the deprecated ChipSim search launcher and its local Activity journal. For new persistent searches use the Pi Durable procedure above.

```sh
chipsim evolution evolve --benchmark alu8 --project ./work \
  --config /path/to/your-openevolve.yaml --iterations 5 --formal
```

OpenEvolve is separately installed/configured in the selected Python environment.
This explicit search can send RTL/feedback to its configured provider and incur
charges. Evaluation and discovery do not import OpenEvolve or configure a provider.
The input snapshot is frozen once per search and checked before each evaluation.
Repeated manual submissions with `--session` reuse and verify that session's
snapshot. Use a new session to change the benchmark definition.
Each command stores its adapter configuration, cancellation marker and isolated
candidate projects under `evaluations/SESSION/invocations/INVOCATION`. Search
workers share their command's invocation. Failure or interruption cancels only
that invocation's jobs and prevents its workers from starting later stages;
subsequent `evaluate --session ID` submissions remain usable. The shared
`evaluations/SESSION/benchmark-inputs` snapshot and prior evidence are retained.
Caller-owned sessions remain running until the caller publishes their summary.
Only one candidate file is offered to search, with the existing EVOLVE-BLOCK policy.

The existing budgets remain 60 seconds for counter and 300 for ALU, including
enabled formal work; `--timeout 1..300` overrides evaluation budgets. Native task
limits still apply. Ctrl-C requests cancellation of managed jobs and stops the
external optimizer process group. Partial evidence is retained, and work sessions
continue to use the existing Activity view without replacing its cursor/recording.

The native agent tool `chipsim_command` accepts benchmark and legacy evolution arguments and optional `timeoutMs`
(1,000–86,400,000; default 180,000). Increase it for ALU/formal/search commands.
Evolution cancellation allows time for supervisor cleanup. No automatic provider
or agent configuration is installed.

Implementation is shared by the example bridge and `src/evolution/cli.js`.
Regression commands:

```sh
node --test test/text-evolution-workflow.test.js test/evolution.test.js test/alu-evolution.test.js
CHIPSIM_TEST_EVOLUTION_WORKFLOW=1 node --test test/text-evolution-workflow.test.js
CHIPSIM_TEST_ALU=1 CHIPSIM_TEST_EVOLUTION=1 node --test test/alu-evolution.test.js test/evolution.test.js
npm run test:install
npm run verify
```

The workflow integration suite requires real Icarus, Yosys and EQY. It covers
custom reports, context-aware comparison, replay after source deletion, tampered
evidence, and a reset bug that simulation misses but required formal rejects.
Fixtures never claim a provider-backed search. HDL tools execute with local
permissions; input snapshots and hashes are not an operating-system sandbox.
