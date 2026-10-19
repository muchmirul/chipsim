# Evolving an unsigned saturating adder

This walkthrough connects a hardware goal to the RTL change and its measured
result. See the [scenario commands](README.md) and [shared evolution guide](../README.md)
for running the example, tool requirements, cancellation and live evidence review.

## The exact goal

The illustrative interface is `saturating_adder(a[3:0], b[3:0], sum[3:0])`:
unsigned inputs and output, with `sum = min(a + b, 15)`. There is no clock,
reset, latency protocol or stored state. These are teaching assumptions, not a
vendor specification. Only the implementation between `EVOLVE-BLOCK-START` and
`EVOLVE-BLOCK-END` may change; preserve the module name, ports and widths and use
synthesizable combinational SystemVerilog. The trusted testbench, scorer and
execution tools are fixed, outside the mutable candidate.

The objective is to maximize the dimensionless `combined_score = checks_passed / 256`.
Acceptance requires `1.0` (256/256), plus successful simulation, output capture and
scorer execution. There is no area, timing or power objective in this run.

## Before and after: what changed in the circuit description?

The exact [baseline](saturating-adder.sv) is:

```systemverilog
// Deliberately incomplete baseline: wraps instead of saturating. Not a PPA benchmark.
module saturating_adder(input wire [3:0] a, b, output wire [3:0] sum);
  // EVOLVE-BLOCK-START
  assign sum = a + b;
  // EVOLVE-BLOCK-END
endmodule
```

Four output bits cannot retain the carry. For `a=9` (`1001`) and `b=8` (`1000`),
the mathematical sum is 17 (`10001`); the baseline outputs `0001`, or 1, instead
of the required `1111`, or 15. It works only where `a+b <= 15`.

The exact selected [agent-authored RTL](evolved.sv) is:

```systemverilog
// Deliberately incomplete baseline: wraps instead of saturating. Not a PPA benchmark.
module saturating_adder(input wire [3:0] a, b, output wire [3:0] sum);
  // EVOLVE-BLOCK-START
  wire [4:0] full_sum;
  assign full_sum = {1'b0, a} + {1'b0, b};
  assign sum = full_sum[4] ? 4'd15 : full_sum[3:0];
  // EVOLVE-BLOCK-END
endmodule
```

The opening comment is retained verbatim from the baseline; the implementation
below it is repaired. The separate [manual acceptance fixture](correct-saturating-adder.sv)
uses `total`, not `full_sum`, and a different comment. It is not renamed search output.

Conceptually, the baseline is an unsigned adder feeding only its low four bits
to the output. The repaired description zero-extends both operands, preserves
five sum bits, and uses bit 4 to select either the low four bits or constant 15.
This is an adder, overflow/carry decision and four-bit selection, with no storage.
It is a conceptual hardware structure, **not a synthesized gate netlist**.
A synthesis tool could simplify or map this logic differently.

The maximum full sum is 30, so five bits suffice. For sums 0–15, bit 4 is zero
and the low four bits are exact; for sums 16–30, bit 4 is one and the output is 15. At exactly 15, the unmodified low bits already equal 15. Thus both branches
implement the stated unsigned clamp, including the overflow example above.

## How the goal becomes a fitness measurement

The fixed [testbench](trusted/saturating_adder_tb.sv) enumerates every binary input
pair: at `cycle * 10 ns`, cycles 0–255 drive `a = cycle // 16`, `b = cycle % 16`.
It writes `trace.vcd` and ends at 2560 ns. The independent [scorer](trusted/score.py)
reads ChipSim's normalized VCD-derived waveform, not candidate stdout or claims.
At `cycle * 10 + 6 ns`, it compares the observed output to Python's `min(a+b,15)`.
It validates 4-bit interface widths, exact fixed inputs, ordered event times and
complete duration. Unknown/missing output bits fail an observation; missing
signals, changed stimulus or incomplete traces are rejected. Failure detail is
limited to the first 12 observations; the score still counts all 256.

This is exhaustive coverage of the 256 binary pairs at fixed sample times, not
formal equivalence, glitch testing or arbitrary input timing. The 6 ns sample
offset is a harness choice, not a measured propagation delay. No physical PPA is measured.

## What actually evolved, step by step

Here “genome” means the candidate RTL source, and “mutation” means a proposed
source edit. These are search metaphors: tests measure fitness; the simulator
does not magically change a circuit. The coding agent proposes logic, OpenEvolve
manages variants and selection, and ChipSim runs and retains evaluations.

1. **Goal and fitness:** [`manual-mode.yaml`](manual-mode.yaml) states the clamp
   contract and edit boundary. [`evaluator.py`](../evaluator.py) fixes the harness,
   oracle and required checks; `combined_score` measures functional correctness.
2. **Baseline:** [`run.py`](../run.py) starts the work session. Its separate
   [`search.py`](../search.py) worker calls the real installed OpenEvolve 0.4.0
   `run_evolution` API with the baseline `.sv`, evaluator and YAML. The baseline
   evaluation scores 136/256 = 0.53125 and enters the generation-0 population.
3. **Actual queue prompt:** upstream `llm.manual_mode` writes a task JSON under
   `openevolve/manual_tasks_queue/`, containing the goal, baseline RTL and score.
   An existing coding agent reads that prompt and writes the adjacent
   `TASK_UUID.answer.json`; `existing-agent-session` is a queue label, not a
   separately called provider/model endpoint. No separate provider API was used.
4. **One mutation:** the answer uses the requested `<<<<<<< SEARCH`, `=======`,
   `>>>>>>> REPLACE` format to replace `assign sum = a + b;` with the three
   `full_sum` lines shown above. OpenEvolve applies the diff within the evolve
   block. The agent already knew the goal and manual fixture: this is guided
   integration, not blind discovery or unattended provider-backed search.
5. **Child simulation and scoring:** the evaluator copies that RTL and unchanged
   trusted files into a fresh worker project, then runs managed Icarus simulation
   and a separate Python scoring task bound to its waveform. It accepts metrics
   only from that exact run/job's scoring artifact, verifies the run closure,
   and returns an OpenEvolve `EvaluationResult` with metrics and evidence links.
   The child scores 256/256. A compile error or incomplete evaluation instead
   gets a zero optimizer penalty, not a measured zero-check result.
6. **Population and selection:** the one-island checkpoint retains the baseline
   and its single generation-1 child, parent linkage, metrics and best-program
   identity. `checkpoint_1` and `best/best_program.sv` record the passing child;
   the worker writes it to `evaluations/SESSION/selected.sv`. Although configured
   population/archive capacities are 8/4, only two programs were recorded.
   This is one iteration and one child, not many generations or crossover.
7. **Fresh finalist:** after the worker returns, `run.py` independently evaluates
   `selected.sv` in another new project/job with the same fixed tests. Only then
   does it publish selection and the final summary. The fresh result is 256/256;
   it is not merely a reuse of OpenEvolve's reported fitness.

## Recorded results and where to inspect them

The 2026-10-19 [demonstration record](demonstration.json) retains hashes, validation
results and exact finalist project/job/run/artifact IDs. The results are:

| Evaluation                      | Observations passed | `combined_score` |
| ------------------------------- | ------------------- | ---------------- |
| Wrapping baseline, generation 0 | 136/256             | 0.53125          |
| Agent variation, generation 1   | 256/256             | 1.0              |
| Selected RTL, fresh finalist    | 256/256             | 1.0              |

The baseline passes `16+15+...+1 = 136` non-overflow pairs and fails the other 120.
The record reports all three managed run closures verified, unchanged copied
trusted bytes and matching independent waveform rescoring. Work events are
agent-reported; integrity hashes do not turn sampled checks into a formal proof.
The selected-source SHA-256 is
`1864244e5f14470db24cf721a74fd15c3c4d4a7e11c33c76fad99e1f04170191`.

Original machine-local evidence is retained under this session root:

```text
/home/dev/chipsim-evolution-proof/collection-20261019/saturating-adder/evaluations/74f36255-9875-4352-83ce-da3226547139/
```

| Relative evaluation directory           | Purpose            |
| --------------------------------------- | ------------------ |
| `0838a5f8-95d5-45b3-8cf8-fe92b25c7a39/` | Baseline           |
| `0c26dadf-d181-4b7c-867c-0201167f16bb/` | Generation-1 child |
| `19818378-bd73-4b64-9103-56870eea6ea0/` | Fresh finalist     |

Each contains `evaluation.json` with project/job/run and waveform/scoring artifact
links. The session also retains `selected.sv`, queue task/answer JSON, optimizer
logs and `openevolve/checkpoints/checkpoint_1/{metadata.json,programs/}`.
Those absolute paths identify original recordings; the evidence directories are
not bundled in this repository. Use the exact IDs with the shared guide's
`artifact inspect` / `artifact verify` commands. Reproduction uses the scenario
README's one-iteration command and needs an explicit human/agent queue responder.

## Extending this pattern to given-goal hardware design

A larger task can keep this separation: state the hardware goal, freeze independent
correctness tests and constraints, let the agent edit allowed RTL, and measure
candidates with trusted tools. For example, minimize mapped cell area while
requiring correctness and a specified timing limit; do not reward a smaller but
wrong circuit. Add a real synthesis task and retain its netlist and area report.
Declare technology libraries, timing constraints, input/output delays, loads,
units and operating corner before comparing timing. Power needs an actual power
analysis with declared activity and conditions, not a functional score proxy.

Add formal properties/equivalence as hard checks where appropriate. Physical
design additionally needs the relevant PDK, floorplan and routing constraints,
real implementation tools and independently checked reports (including physical
signoff checks appropriate to the goal). Map these measured results into fitness
and reject correctness/constraint failures; freshly verify the selected finalist.
None of synthesis, timing closure, power analysis, formal proof or PDK-backed
physical implementation was demonstrated by this RTL repair.
