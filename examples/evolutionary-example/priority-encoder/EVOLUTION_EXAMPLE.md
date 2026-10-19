# Evolution example: highest-bit priority encoder

## 1. Turn the hardware goal into a measurable contract

**Goal:** encode the highest asserted bit in an eight-bit request, with a valid flag.

| Port           | Direction / width | Required behavior                                      |
| -------------- | ----------------- | ------------------------------------------------------ |
| `request[7:0]` | Input, 8 bits     | Binary request mask; bit 7 has highest priority        |
| `valid`        | Output, 1 bit     | One exactly when `request != 0`                        |
| `index[2:0]`   | Output, 3 bits    | Highest asserted bit number, or zero for an empty mask |

These are illustrative design assumptions, not vendor requirements. The module is
`priority_encoder`; preserve its ports and synthesizable combinational behavior.
No clock, reset, latch or stored state is needed. Only implementation inside the
EVOLVE-BLOCK markers may change, never the trusted harness, scorer or tools.
The objective here is functional correctness, not area, power or timing.

The goal becomes a fixed executable fitness test: maximize the dimensionless
`combined_score = checks_passed / 256`. Each observation passes only if **both**
`valid` and `index` match. Readiness also requires all managed simulation/output
and scoring checks to pass; a completed simulator process alone is insufficient.

## 2. Before: the loop gives priority to the wrong end

This is the exact relevant RTL from [`priority-encoder.sv`](priority-encoder.sv):

```systemverilog
  integer bit_index;
  always @* begin
    valid = |request;
    index = 3'd0;
    for (bit_index = 7; bit_index >= 0; bit_index = bit_index - 1)
      if (request[bit_index]) index = bit_index;
  end
```

Blocking assignments overwrite `index` on every asserted bit. For decimal 129,
`request = 8'b10000001`, bit 7 first assigns 7, then bit 0 overwrites it with 0.
`valid = 1` is correct, but `index = 0` violates the required answer of 7.
Scanning downward without stopping therefore selects the **lowest** asserted bit.
Only the empty mask and eight one-hot masks pass: **9/256 = 0.03515625**.

## 3. After: reverse assignment order, preserve the interface

The exact repaired block in the recorded selected [`evolved.sv`](evolved.sv) is:

```systemverilog
  integer bit_index;
  always @* begin
    valid = |request;
    index = 3'd0;
    for (bit_index = 0; bit_index < 8; bit_index = bit_index + 1)
      if (request[bit_index]) index = bit_index;
  end
```

Now higher bit numbers overwrite lower ones. For 129, bit 0 assigns 0 before
bit 7 assigns the final 7. More generally, the last asserted bit visited is the
maximum asserted index. For zero, no conditional assignment occurs: defaults
produce `valid = 0, index = 0`. For bit 0 alone, `valid = 1, index = 0`.
Both outputs have defaults on every invocation, so no previous value must be held.

Conceptually, the hardware has two combinational paths:

```text
request[7:0] ──> reduction OR ──────────────────────> valid
             └─> highest-bit-priority selection ───> index[2:0]
                 (default 0; bit 7 overrides bits 6 ... 0)
```

The fixed-bound loop describes conditional selection logic, not eight clocked
steps or an eight-cycle machine. `integer bit_index` is the procedural loop
variable, not a requested state register. This is a conceptual RTL structure,
not a synthesized netlist: synthesis may simplify or restructure the selection.
No cell count, mapped logic depth or propagation delay was measured.

## 4. How goal, mutation, evaluation and selection connect

The candidate SystemVerilog program is the editable **genome** metaphor; a source
edit is a **mutation**. Tests supply fitness. The simulator executes each proposed
circuit description; it does not change the circuit to make the test pass.

1. **Goal to fitness.** The fixed [`testbench`](trusted/priority_encoder_tb.sv)
   drives masks 0 through 255 at `mask * 10 ns` and finishes at 2560 ns. The
   separate [`Python scorer`](trusted/score.py) samples at `mask * 10 + 6 ns`.
   Its independent oracle uses `max(0, request.bit_length() - 1)` and
   `int(request != 0)`, not either RTL loop.
2. **Baseline.** [`run.py`](../run.py) starts a session and supervises
   [`search.py`](../search.py), which calls the real installed OpenEvolve 0.4.0
   `run_evolution` API. Its initial program is the faulty RTL. The callback in
   [`evaluator.py`](../evaluator.py) measures that baseline at 9/256.
3. **Queue a variation.** OpenEvolve chooses the baseline parent and writes its
   actual improvement prompt, RTL, score and feedback to `manual_tasks_queue`.
   [`manual-mode.yaml`](manual-mode.yaml) enables upstream `llm.manual_mode`
   and requests one iteration, one island, population capacity 8 and archive 4.
   Those capacities do not mean eight candidates were evaluated.
4. **Agent proposes the edit.** An existing coding agent reads that real queue
   prompt and writes the adjacent `TASK_UUID.answer.json`. Its SEARCH/REPLACE
   response changes only the downward `for` line to the upward line shown above.
   OpenEvolve applies the diff inside EVOLVE-BLOCK and creates one child.
5. **Measure the child.** The bridge copies candidate RTL plus unchanged trusted
   files into a new isolated project. Managed Icarus simulation publishes VCD
   and normalized waveform; a separate managed Python task scores that waveform.
   The adapter accepts only the current score task's sealed report, not RTL
   stdout or a colliding simulator-written metrics file. The child scores 1.0.
6. **Retain and select.** OpenEvolve records program metrics, parent links,
   population/archive and `checkpoint_1`. The checkpoint contains the generation-0
   baseline and its generation-1 child; the best-program record selects the child.
   This was **one iteration and one generation-1 variation**, not many generations,
   crossover, or a broad autonomous search.
7. **Fresh finalist.** `search.py` saves the chosen bytes as
   `evaluations/SESSION/selected.sv`. After the worker exits, `run.py` evaluates
   that file in a fresh project/job before publishing selection and completion.

The agent knew the goal and manual fixture. No separate provider API was used;
`existing-agent-session` is a queue label, not an endpoint. This demonstrates
real agent-assisted OpenEvolve integration, not blind discovery or unattended
provider-backed search. The [shared guide](../README.md#agent-assisted-mode-verified-example)
explains queue answers and cancellation; no responder starts automatically.

## 5. Recorded results, coverage and retained evidence

The recorded run on **2026-10-19** produced:

| Evaluation                            | Passed / total | `combined_score` |
| ------------------------------------- | -------------- | ---------------- |
| Lowest-bit baseline                   | 9/256          | 0.03515625       |
| Generation-1 loop-order child         | 256/256        | 1.0              |
| Selected child, fresh independent job | **256/256**    | **1.0**          |

[`demonstration.json`](demonstration.json) records baseline/finalist metrics,
selected-source and trusted-file hashes, queue hashes, and exact finalist project,
job, run and viewer artifact IDs. It records that all three managed run closures
verified, copied trusted bytes matched, and independent waveform rescoring agreed.
The initial harness was corrected **before** this run to allow an X-to-zero
transition at time zero; the trusted files then stayed fixed during the run.

The scorer checks interface widths, ordered times, full duration and actual input
values. Unknown/missing outputs cannot pass; changed stimulus or an incomplete
trace rejects evaluation. All **256 binary input combinations** are covered at
fixed samples. That is not formal verification, glitch analysis, delay testing,
PPA measurement or a silicon result; input-transition hazards are not checked.

[`correct-priority-encoder.sv`](correct-priority-encoder.sv) is a separately authored
manual acceptance fixture, not renamed search output. Its implementation matches
the repair, but its file bytes differ. `evolved.sv` retains the exact selected
bytes, including the now-stale original “faulty baseline” comment.

Original machine-local evidence is under
`/home/dev/chipsim-evolution-proof/collection-20261019/priority-encoder-verified/`,
then `evaluations/1ed5f5b2-363a-4519-aba3-f5b3d7bc797c/`. That session retains
`selected.sv`, `openevolve/manual_tasks_queue/` prompt/answer pairs,
`openevolve/checkpoints/checkpoint_1/` program/metadata records, and per-project
`evaluation.json`, `independent-rescore.json`, managed logs and sealed artifacts.
Those full recordings are not shipped; the manifest identifies their original
locations. See the [scenario README](README.md) for evaluation commands and the
[collection README](../README.md) for artifact inspection, limits and `--debug`.

## 6. Extend the same method to a given chip-design goal

Start by fixing the interface, behavior and constraints, then make each objective
independently measurable. For this encoder, a next goal could add an explicit
input-to-output delay limit and cell-area budget while keeping highest-bit behavior
as a hard correctness constraint. Rank only candidates that satisfy required gates.
Use synthesis against a specified library and timing constraints to measure area
and static timing; use a justified activity/corner-based flow for power. Add formal
properties or equivalence where required, then recheck the selected result afresh.
Physical design also needs the relevant PDK/libraries, place-and-route, extraction,
and DRC/LVS checks. Link their real reports, units and corners into trusted scoring;
source length or functional score is not a substitute for those measurements.
None of those physical flows ran here: the demonstrated output is repaired
SystemVerilog RTL, not a mapped netlist, GDSII layout or fabrication-ready chip.
