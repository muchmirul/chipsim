# Evolutionary examples: agent + OpenEvolve + ChipSim

Three original RTL teaching examples share one evaluator/search bridge. Choose
`--example NAME` to fix the goal, interface, trusted harness and scorer; only the
candidate RTL is mutable. This folder was previously `examples/evolution`.
Commands and installed agent-help paths now use `examples/evolutionary-example`.

| Example                                        | Measurable goal                               | Fixed checks          | Starting defect    |
| ---------------------------------------------- | --------------------------------------------- | --------------------- | ------------------ |
| [Counter](counter/README.md) (default)         | Reset, increment when enabled, otherwise hold | 80 sampled cycles     | Ignores enable     |
| [Saturating adder](saturating-adder/README.md) | Unsigned `min(a+b,15)`                        | All 256 input pairs   | Wraps on overflow  |
| [Priority encoder](priority-encoder/README.md) | Highest asserted request bit, plus valid      | All 256 request masks | Chooses lowest bit |

Each subfolder contains a deliberately faulty baseline, a **manually authored
acceptance fixture**, and trusted stimulus/scoring. Passing a supplied fixture
is not evidence of evolutionary search. Separate real OpenEvolve 0.4.0
agent-assisted manual-mode runs were also completed for all three goals:

| Example          | Baseline | Agent variation          | Selected RTL, fresh check |
| ---------------- | -------- | ------------------------ | ------------------------- |
| Counter          | 11/80    | 80/80 (two alternatives) | 80/80                     |
| Saturating adder | 136/256  | 256/256                  | 256/256                   |
| Priority encoder | 9/256    | 256/256                  | 256/256                   |

For the two newer examples, OpenEvolve managed one generation-1 variation each;
an existing coding agent answered the real queue prompts. Run/artifact integrity,
trusted copied bytes and independent waveform rescoring were checked. The agent
already knew the goals and manual fixtures: these are integration demonstrations,
not blind discovery or unattended provider-backed search. The fixtures are not
renamed search output. See each scenario guide for details and goal-specific
`manual-mode.yaml` (adder/encoder). Full local recordings are not bundled.
All goals and interfaces are illustrative assumptions, not vendor specifications.

Use the shared runner for any example:

```sh
mkdir -p /tmp/adder-work
python3 examples/evolutionary-example/run.py evaluate \
  --example saturating-adder --project /tmp/adder-work
# Expected exit 1: intentionally faulty baseline.
python3 examples/evolutionary-example/run.py evaluate \
  --example saturating-adder --project /tmp/adder-work \
  --candidate examples/evolutionary-example/saturating-adder/correct-saturating-adder.sv
# Expected exit 0: manual fixture passes, not a search.
```

For an actual search use `evolve --example NAME --config YOUR_CONFIG` instead.
Use that example's goal and interface in the OpenEvolve system prompt; the counter
prompt below must not be reused unchanged for an adder or encoder. The runner
records the selected goal and independently re-evaluates the selected RTL. No
provider, responder or dependency is installed automatically.

## How evolution works for hardware goals

Each scenario has an explanation beside its RTL, including its goal, before/after
implementation, conceptual hardware, actual variation/evaluation/selection steps,
measured results and the boundary between RTL repair and physical chip design:

- [Counter evolution explanation](counter/EVOLUTION_EXAMPLE.md)
- [Saturating-adder evolution explanation](saturating-adder/EVOLUTION_EXAMPLE.md)
- [Priority-encoder evolution explanation](priority-encoder/EVOLUTION_EXAMPLE.md)

## Counter walkthrough

This example repairs a deliberately incomplete 4-bit counter. `counter/counter.sv`
ignores `enable`. The objective is **functional correctness**, not circuit area,
power, delay, synthesis quality, or whole-design equivalence. OpenEvolve remains
an optional external optimizer; ChipSim neither runs a built-in search engine
nor configures an LLM provider/account.

## Run a real evaluation without an LLM

Requires Node.js 22.13+, Python 3.10+, and stock `iverilog`/`vvp` on PATH.
No Python packages are needed for evaluation. From the checkout:

```sh
mkdir -p /tmp/counter-work
python3 examples/evolutionary-example/run.py evaluate --project /tmp/counter-work
# Expected exit 1: the deliberately incomplete baseline fails some checks.
python3 examples/evolutionary-example/run.py evaluate --project /tmp/counter-work \
  --candidate examples/evolutionary-example/counter/correct-counter.sv
# Expected exit 0: a manually supplied known-correct regression candidate.
node scripts/chipsim.mjs --agent /tmp/counter-work
```

In an installed package, use the actual `examples/evolutionary-example/run.py` path. The
script resolves the packaged Node CLI relative to itself; `--chipsim /path/to/chipsim`
selects a different installed executable. The work directory must already exist;
no PDF or initial design manifest is needed. Each invocation starts a work session
before evaluation and ends with a summary. `--session UUID` appends manual
submissions to an existing nonterminal session instead and leaves its lifecycle
to the caller. Optional `--parent ID --generation N` records known lineage;
the adapter never invents OpenEvolve parent/generation data absent from its
`evaluate(program_path)` callback.

Open Activity (`8`) in another terminal **while evaluation runs** to see the goal,
candidates, job progress, and agent-reported metrics. Select evidence explicitly
to inspect it. Background updates do not replace your current recording.
Each result prints the exact isolated project, job, run and viewer artifact IDs:

```sh
chipsim job logs JOB_UUID --project ISOLATED_PROJECT --limit 16000
chipsim artifact inspect ARTIFACT_HASH --project ISOLATED_PROJECT
chipsim artifact verify RUN_HASH --project ISOLATED_PROJECT
chipsim --design ISOLATED_PROJECT
```

For source + RTL + waveform review, install the observer tools separately as
explained in [HDL_DEBUG.md](../../docs/HDL_DEBUG.md), then evaluate with `--debug`.
The evidence link selects `out/debug.json` instead of waveform-only JSON. Missing
observers fail explicitly; there is no silent downgrade. Open the linked debug
artifact from Activity, or open its `artifact inspect` `payloadPath` with
`chipsim --hdl-debug PATH` and press `I` for the combined debugger.

## Let OpenEvolve generate candidates

Install OpenEvolve separately in **your chosen Python environment** and supply
its YAML with your existing provider/model settings. This example does not
install dependencies, choose a provider, write account configuration, or embed
credentials. Unlike offline evaluation, this command may send RTL and feedback
to the provider configured in your YAML and may incur charges.

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --project /tmp/counter-work --config /path/to/your-openevolve.yaml \
  --iterations 5 --timeout 60
```

Your YAML should set `prompt.system_message` to explain the interface:
synchronous rising-edge reset (priority over enable), increment modulo 16 when
enabled, otherwise hold; edit only the counter implementation; produce
synthesizable SystemVerilog, not testbench or evaluator code. It must configure
`llm.models` using your separately installed OpenEvolve's documented schema.
The checked-in `counter/correct-counter.sv` is a manual acceptance fixture, **not** an
LLM-generated candidate or evidence that a search was performed.

`run.py` supervises `search.py` in a separate process. That worker calls the public
`openevolve.run_evolution(initial_program=..., evaluator=..., config=...,
iterations=..., output_dir=..., cleanup=False)` library API with a real `.sv` file.
The supervisor retains signal ownership even when OpenEvolve installs its own
SIGINT/SIGTERM handlers. `evaluator.py:evaluate(program_path)` returns
`openevolve.evaluation_result.EvaluationResult(metrics, artifacts)` lazily.
The compatibility target is OpenEvolve's public API inspected on 2026-10-18:
[API](https://github.com/codelion/openevolve/blob/main/openevolve/api.py),
[result](https://github.com/codelion/openevolve/blob/main/openevolve/evaluation_result.py),
[configuration](https://github.com/codelion/openevolve/blob/main/openevolve/config.py).
No OpenEvolve source is copied here. An installed release lacking these APIs
will fail explicitly; use a compatible separately installed release.

Adapter-required overrides (printed here rather than silently changing YAML):
`language=verilog`, `file_suffix=.sv`, `enforce_evolve_blocks=true`,
`max_code_length=65536`, no cascade or LLM feedback, one parallel evaluation,
zero retries, and evaluator timeout = candidate timeout + 60 seconds. Provider
settings are not modified. Iterations are bounded to 1–100. Search checkpoints
and the selected `.sv` remain under `evaluations/SESSION/openevolve` and
`evaluations/SESSION/selected.sv`. The selected candidate is independently
re-evaluated before a selection event and final summary are published. No live
provider-backed search is claimed by the offline regression tests.

## Agent-assisted mode: verified example

OpenEvolve 0.4.0 also supports `llm.manual_mode`: it writes improvement prompts
to a file queue and accepts responses from a human or existing coding agent.
This uses the real OpenEvolve library and the same ChipSim evaluator, without
requiring a separately configured provider endpoint. It is not unattended
provider-backed search. Confirm this mode exists in your separately installed
OpenEvolve version; it is an upstream capability, not a ChipSim provider.

A verified run on 2026-10-19 used two agent-authored SEARCH/REPLACE responses:

| Program / evaluation                                   | Observations passed |
| ------------------------------------------------------ | ------------------- |
| Original counter: always increment unless reset        | 11/80               |
| Variation A: `else if (enable) count <= count + 4'd1;` | 80/80               |
| Variation B: `else count <= count + {3'b000, enable};` | 80/80               |
| OpenEvolve-selected A, fresh automatic evaluation      | **80/80**           |

OpenEvolve checkpoints recorded both variations as generation-1 children of the
baseline. The adapter independently evaluated selected A in a new project/job.
All four run closures verified, independent rescoring matched, and the trusted
harness/scorer bytes were unchanged. An extra observer-enabled evaluation of the
selected source also passed 80/80. Candidate edits came from a coding agent, which
already knew the objective and the manual regression fixture: this is an
integration demonstration, not blind discovery, formal proof or a PPA benchmark.
The output is `evaluations/SESSION/selected.sv`, original SystemVerilog RTL.

To reproduce the agent-assisted workflow, save this as `agent-assisted.yaml`
and use a fresh existing work directory:

```yaml
max_iterations: 2
checkpoint_interval: 1
random_seed: 42
diff_based_evolution: true
llm:
  manual_mode: true
  models:
    - name: existing-agent-session
      weight: 1.0
  retries: 0
  timeout: 120
  max_tokens: 1800
prompt:
  system_message: >-
    Repair the counter RTL. Preserve the interface and synthesizable SystemVerilog.
    Synchronous rising-edge reset takes priority. Increment modulo 16 when enabled;
    otherwise hold. Edit only EVOLVE-BLOCK using the requested SEARCH/REPLACE format.
    Do not edit the testbench, scorer or tools.
database:
  num_islands: 1
  population_size: 8
  archive_size: 4
evaluator:
  parallel_evaluations: 1
  max_retries: 0
  cascade_evaluation: false
  use_llm_feedback: false
```

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --project /path/to/fresh-work --config /path/to/agent-assisted.yaml \
  --iterations 2 --timeout 60
```

Read the actual generated prompts under
`evaluations/SESSION/openevolve/manual_tasks_queue/TASK_UUID.json`. For each,
write an adjacent `TASK_UUID.answer.json` containing `{"answer":"YOUR RESPONSE"}`.
The response string contains a targeted diff in the requested format, for example:

```json
{
  "answer": "<<<<<<< SEARCH\n    else count <= count + 4'd1;\n=======\n    else if (enable) count <= count + 4'd1;\n>>>>>>> REPLACE\n"
}
```

An agent can read each prompt and write the answer using its normal file tools;
ChipSim does not supply that agent. Keep real prompt/answer pairs, checkpoints,
`evaluation.json` records and final IDs as provenance. Inspect the actual selected
source and fresh result rather than assuming the example response will be chosen.
The model name above is a queue label, not a provider endpoint or model identity.

The 60-second option bounds each candidate evaluation, not the overall run.
OpenEvolve's manual queue may wait indefinitely for an answer; `llm.timeout`
does not bound that wait in the inspected version. Supply responses or explicitly
cancel the supervisor. No queue responder, credentials or provider is installed
or launched automatically. Provider-backed mode still requires separately approved
model configuration, data sharing and any applicable spending limits.

## What is measured and retained

Only the candidate RTL is offered to the optimizer. Every evaluation creates a
fresh directory and copies that RTL plus the trusted harness and scorer into it.
The generated design has two real tasks:

1. `simulate`: managed Icarus simulation of the selected fixed harness (80 cycles
   for the counter, 256 input combinations for the adder/encoder); captures
   VCD, normalized waveform, sources, diagnostics, and optional debug events.
2. `score`: separate managed Python command, bound to the published waveform,
   computes expectations independently from the selected contract. For the
   counter, it checks clock/reset/enable and samples `count` one nanosecond after
   each rising edge, exercising reset, hold, increment and wrapping. For the
   combinational examples it checks every input combination and samples outputs
   six nanoseconds after stimulus changes.
   Unknown bits fail; missing signals, changed stimulus or incomplete duration
   cannot earn a partial passing report. It publishes `out/metrics.json`.

`combined_score = checks_passed / checks_total`, dimensionless, maximized by
OpenEvolve. The counter has 80 checks; the adder and encoder each have 256.
Readiness requires simulation, outputs, scorer execution, and `combined_score == 1`.
A failed baseline can therefore have a completed process job but fail readiness.
A compile error or incomplete evaluation receives score zero **as an optimizer
penalty**, not a measured zero-check result; no `checks_passed` is then reported.
Work events remain labeled **agent-reported**. Hash verification establishes byte
integrity, not that reported claims are proof or that a candidate is safe.

`counter/trusted/counter_tb.sv` and `counter/trusted/score.py` are outside the evolving program.
Their copied bytes, tool identities and all inputs are captured in managed
snapshots. The scoring report is itself an artifact linked to the input waveform. The adapter
accepts metrics only from the `score` task's attempt in the exact current run/job;
a simulator-produced file with the same name cannot replace the trusted report.
Viewer artifacts likewise must come from that run's `simulate` attempt.
Candidate IDs are stable SHA-256 IDs of source bytes; repeated evaluations retain
separate projects/jobs. The example's trusted files are assumed unchanged by the
operator during a session. This is isolation of evaluation inputs, **not an OS
security sandbox**: HDL tools run with your local permissions. Review generated
RTL and use an external OS/container sandbox for adversarial inputs. Fixed tests
can be overfit and do not replace formal verification or broader regressions.

To measure area, timing or other custom objectives, author a separate trusted
managed task that invokes the real installed tool, declares its inputs/constraints,
produces a numeric report and required checks, then adapt the report-to-metrics
mapping in `evaluator.py`. Keep units/corners/scope and linked report evidence.
Do not rename source length or functional score as PPA. This example has no
synthesis tool, technology library or PDK requirement.

## Bounds and cancellation

Candidate files: 64 KiB. Waveform scoring input: 8 MiB. CLI JSON replies: 2 MiB.
Evaluation wall-clock limit: 1–300 seconds (default 60); HDL stages also use their
native capped 120-second timeout; scoring has a 10-second process timeout.
Deadline or Ctrl-C/SIGTERM requests cancellation of accepted managed jobs and
retains partial diagnostics. For a search, Ctrl-C/SIGTERM stops the external
optimizer process group (TERM, then KILL after at most five seconds), cancels
managed jobs, publishes `cancelled`, and exits 130. A best-so-far return from
OpenEvolve's graceful signal handler is not re-evaluated or reported as completion. An evaluation deadline waits at most five additional
seconds for job shutdown, then records cancellation requested, not completed.
Ctrl-C exits 130. Killing the adapter with SIGKILL cannot run cleanup; use
`chipsim job cancel JOB --project ISOLATED_PROJECT` or allow native task deadlines.
A provider call's latency/timeouts remain OpenEvolve's responsibility.

The adapter creates `evaluations/SESSION/CANCEL` when cancelling a search so later
worker evaluations cannot start. It does not erase any candidate or evidence.
Work storage allows 128 sessions/project and 2048 events/session (16 KiB/event);
queries show at most 200 recent events while retaining candidate summaries.
Start a new project/session when a hard bound is reached; no destructive retention
or background cleanup occurs.

## Regression checks

```sh
node --test test/evolution.test.js
CHIPSIM_TEST_EVOLUTION=1 node --test test/evolution.test.js
```

The first command tests the trusted oracle, imports/help without OpenEvolve, and
signal ownership using a provider-free library protocol fixture (not a search).
The second additionally requires stock Icarus and exercises real isolated managed
runs of baseline, correct RTL, colliding candidate-written metric files, compile
failure and cancellation; no paid LLM or mock search. Run those tests while other source edits are stopped: managed jobs
fingerprint the ChipSim runtime, so concurrent edits correctly invalidate runs.
All example sources are original MIT-licensed ChipSim code under the root license.
OpenEvolve, by Asankhaya Sharma and contributors, is separately installed under
Apache-2.0; see the [integration notice](../../THIRD_PARTY_NOTICES.md#optional-external-evolutionary-optimizer).
