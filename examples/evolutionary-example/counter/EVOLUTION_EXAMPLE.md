# Evolution example: enabled 4-bit counter

## 1. Start with a hardware goal

**Goal:** build a 4-bit register that resets to zero on a rising clock edge,
increments modulo 16 when enabled, and otherwise holds its value.

| Port     | Direction / width       | Contract                                            |
| -------- | ----------------------- | --------------------------------------------------- |
| `clk`    | Input, 1 bit            | Rising-edge clock                                   |
| `reset`  | Input, 1 bit            | Synchronous active-high reset; priority over enable |
| `enable` | Input, 1 bit            | Allow one increment on a rising edge                |
| `count`  | Output register, 4 bits | Current count, wrapping from 15 to 0                |

These are chosen teaching requirements, not an inferred vendor specification.
Only the implementation inside the EVOLVE-BLOCK markers may change. Preserve
the module interface and synthesizable SystemVerilog; do not change the trusted
stimulus, expected behavior or scoring tools to make a candidate pass.

The natural-language goal becomes an executable acceptance contract: a fixed
80-cycle harness and an independent recurrence in the Python scorer. The search
maximizes `combined_score = checks_passed / 80`. All 80 checks and the required
managed task checks must pass before ChipSim reports the evaluation ready.

## 2. Before: a runnable but incorrect circuit

The baseline in [`counter.sv`](counter.sv) ignores enable:

```systemverilog
always @(posedge clk) begin
  if (reset) count <= 4'd0;
  else count <= count + 4'd1;
end
```

For example, if count is 5, reset is low and enable is low, the next rising edge
should retain 5. This baseline changes it to 6. It can compile and simulate
successfully while still violating the hardware goal. Its measured score was
**11/80 (0.1375)**; process completion did not mean functional readiness.

## 3. After: the selected implementation

The recorded OpenEvolve-selected RTL uses:

```systemverilog
always @(posedge clk) begin
  if (reset) count <= 4'd0;
  else if (enable) count <= count + 4'd1;
end
```

The missing assignment when disabled means the register keeps its state. This is
not an incomplete combinational assignment or an inferred latch: the block is
edge-triggered. Reset still wins when reset and enable are both high, and the
4-bit addition still wraps modulo 16.

Conceptually, the hardware is a four-bit state register plus increment and
next-state selection logic:

```text
count Q --> +1 modulo 16 --+
                          +--> enable selection --> reset selection --> register D
count Q --> hold ---------+                                ^                |
zero ----------------------------------------------------+          rising clk
```

This is an explanatory RTL structure, not a synthesized cell diagram. A tool
might map it to a register with an enable or to feedback selection logic. We did
not measure that mapping. The repair does not introduce clock gating.

## 4. How the evolutionary process produced the result

An RTL program is the candidate representation: the editable design, sometimes
called a genome in evolutionary search. A proposed code edit is a variation or
mutation. Neither ChipSim nor the simulator automatically changes the circuit.
OpenEvolve manages the search; an agent proposes edits; ChipSim measures them.

1. **Measure the baseline.** The shared bridge copies the baseline and fixed
   trusted files into a fresh project. ChipSim runs managed Icarus simulation,
   publishes the waveform, then runs a separate Python scoring task.
2. **Build feedback.** The scorer derives expected count from reset and enable,
   checks the actual fixed stimulus, and compares count after each rising edge.
   OpenEvolve receives the score, failure feedback and evidence identifiers.
3. **Request a variation.** Real installed OpenEvolve 0.4.0 chooses a parent and
   writes an improvement prompt into its supported `llm.manual_mode` file queue.
4. **Propose RTL.** An existing coding agent reads the actual prompt and supplies
   a SEARCH/REPLACE answer. Proposal A adds `else if (enable)`. Proposal B changes
   the increment to `else count <= count + {3'b000, enable};`.
5. **Apply and evaluate.** OpenEvolve applies each diff. The bridge evaluates each
   child in its own project using the same unchanged harness and scorer. Invalid
   or incomplete evaluations cannot gain a passing score from candidate stdout.
6. **Retain and select.** OpenEvolve records the population, metrics, parent links
   and checkpoints. Both alternatives score 1.0; it selects proposal A. This does
   not show A has better power, area or timing than B: those were not objectives.
7. **Verify afresh.** The search worker saves the chosen code as
   `evaluations/SESSION/selected.sv`. After that worker exits, the supervisor
   evaluates it again in a new project/job.
   Only that fresh result determines the final reported functional outcome.

```text
baseline: 11/80
  +--> A: enable-gated increment 80/80 --> selected A --> fresh 80/80
  +--> B: add zero-extended enable 80/80
```

This run used **two iterations and two generation-1 children of the baseline**,
not a two-generation chain, crossover, or a large autonomous discovery search.
The agent knew the goal and manual acceptance fixture. No separate provider API
was used. The result demonstrates real agent-assisted optimizer integration,
not blind discovery or unattended provider-backed operation.

## 5. Measured results and evidence

| Evaluation                           | Passed / total | Score   |
| ------------------------------------ | -------------- | ------- |
| Baseline                             | 11/80          | 0.1375  |
| Proposal A: enable-gated increment   | 80/80          | 1.0     |
| Proposal B: add zero-extended enable | 80/80          | 1.0     |
| Selected A, fresh independent job    | **80/80**      | **1.0** |

All four run closures verified. Independent waveform rescoring matched the
scores; trusted input hashes stayed unchanged. A separate observer-enabled review
also passed 80/80. Checks include reset, disabled hold, enabled increment and
wrapping, with samples one nanosecond after rising edges. This is an 80-cycle
functional test, **not exhaustive sequential equivalence over all histories**.

[`correct-counter.sv`](correct-counter.sv) is a separately authored manual fixture,
not renamed optimizer output. The original recorded selected file and full queue,
checkpoint and run evidence are machine-local under
`/home/dev/chipsim-evolution-proof/verified-agent-assisted-20261019T025156Z/`.
The final selected source is under
`evaluations/83177b35-2e84-487c-8faa-7b461793fdae/selected.sv` there. Those local
recordings are not bundled in the source package. The recorded workflow predates
the folder move; current commands use `examples/evolutionary-example`.

See the [scenario README](README.md) for candidate evaluation and the
[shared guide](../README.md#agent-assisted-mode-verified-example) for real search,
queue response format, evidence inspection and cancellation. A new search has
its own prompts, IDs and selection; it need not reproduce the exact lineage.

## 6. Applying this to chip design given a goal

A useful hardware goal combines behavior, interface, constraints and measurable
acceptance. For example: “a four-bit enabled counter, reset priority preserved,
under an explicit clock period and cell-area budget.” First fix behavior with
independent tests/assertions. Then add tools that can actually measure the new
objectives; do not use source length as a substitute for silicon area or power.

For area/timing/power search, synthesize against a specified cell library and
constraints; collect area and static timing, and use an appropriate activity-based
power flow when needed. Keep correctness and required timing/area limits as hard
acceptance gates; rank only eligible candidates on the agreed objective. Add
formal properties/equivalence where required and verify the chosen result afresh.
Physical implementation needs the relevant PDK/library and place-and-route,
extraction and DRC/LVS checks. Those flows were **not** run in this demonstration.

The current output is synthesizable-intent **SystemVerilog RTL**, not a mapped
netlist, GDSII layout or fabrication-ready chip. The example shows how a goal can
steer measured RTL repair; the strength of any broader claim depends on the
independent checks and physical tools actually executed.
