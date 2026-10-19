# Unsigned 4-bit saturating adder

Read [Evolution mechanism, before/after RTL and measured results](EVOLUTION_EXAMPLE.md)
for the goal-to-hardware walkthrough.

## Goal and allowed changes

Implement the combinational interface:

```systemverilog
module saturating_adder(input [3:0] a, b, output [3:0] sum);
```

For unsigned inputs, `sum = min(a + b, 15)`. There is no clock, reset or stored
state. Only the implementation between `EVOLVE-BLOCK-START` and
`EVOLVE-BLOCK-END` in the candidate RTL may change. Keep the module name,
ports and widths. Do not edit the fixed testbench, scorer, or evaluation tools.

`saturating-adder.sv` is a deliberately incomplete baseline: assigning a 4-bit
sum discards carry and wraps modulo 16. For example, `9 + 8` wraps to `1`, but
must saturate to `15`. Conceptually, preserve the full 5-bit addition; if its
carry bit is set, output `15`, otherwise output its low four bits.
`correct-saturating-adder.sv` implements this logic as a **manual acceptance
fixture**, not an evolved candidate or evidence that a search was performed.
This is an illustrative correctness task, not a PPA benchmark.

## Evaluate without an LLM

Requires Node.js 22.13+, Python 3.10+, and stock `iverilog`/`vvp` on PATH.
No Python packages or provider configuration are needed for evaluation.
From the checkout, using an existing work directory:

```sh
mkdir -p /tmp/saturating-adder-work
python3 examples/evolutionary-example/run.py evaluate --example saturating-adder \
  --project /tmp/saturating-adder-work
# Expected exit 1: wrapping passes 136/256 observations, not all 256.
python3 examples/evolutionary-example/run.py evaluate --example saturating-adder \
  --project /tmp/saturating-adder-work \
  --candidate examples/evolutionary-example/saturating-adder/correct-saturating-adder.sv
# Expected exit 0: the manual acceptance fixture passes 256/256 observations.
```

Each evaluation retains a separate project/job and linked waveform and scoring
artifacts. Candidate stdout is not a scoring input. For optional combined
source/RTL/waveform review, use `--debug` only with already installed observer
tools; see the [shared example guide](../README.md).

## Fixed acceptance observations

`trusted/saturating_adder_tb.sv` drives all 256 unsigned input pairs. At
`cycle * 10 ns`, for cycles 0–255, it drives `a = cycle // 16` and
`b = cycle % 16`. It dumps `trace.vcd` and finishes at 2560 ns.
`trusted/score.py` reads only the normalized VCD-derived ChipSim waveform.
It checks the format, 4-bit interface widths, ordered times, complete duration,
and exact sampled inputs. At `cycle * 10 + 6 ns`, it compares the output with
an independent `min(a + b, 15)` calculation. Missing or unknown output values
fail that observation; missing signals, altered inputs and incomplete traces
are rejected. Only the first 12 observation failures are listed.

`combined_score = checks_passed / 256`; readiness requires all 256 checks.
The stimulus covers every binary pair, but the result still describes sampled
simulation observations, not formal equivalence, delay, area, power or silicon
behavior. It does not test glitches or arbitrary timing. The fixed trusted
files must remain unchanged, and the evaluator is not an OS security sandbox.

## Recorded agent-assisted OpenEvolve demonstration

The exact selected source is retained as [`evolved.sv`](evolved.sv), with
[`demonstration.json`](demonstration.json) recording metrics, hashes and original
machine-local evidence identifiers. This is distinct from the manual fixture.
The generated file preserves its original baseline comment even though its
implementation was repaired. Evidence directories are not included in the package.

A real installed OpenEvolve 0.4.0 manual-mode run on 2026-10-19 managed one
agent-authored variation, evaluation and selection. ChipSim measured:

| Stage                                        | Passed observations |
| -------------------------------------------- | ------------------- |
| Wrapping baseline                            | 136/256             |
| Carry-preserving, saturating agent variation | 256/256             |
| Selected RTL, fresh independent evaluation   | **256/256**         |

The variation was a generation-1 child of the baseline. The agent answered the
actual upstream queue prompt by adding a 5-bit sum and carry-based clamp. The
agent already knew the goal and manual fixture, so this is an integration
demonstration, not blind discovery or unattended provider-backed search. The
checked-in correct fixture remains manually authored; it is not renamed search
output. All three managed runs verified, the copied trusted bytes matched, and
independent waveform rescoring matched the reported results. Full machine-local
queue/checkpoint/run evidence is not bundled in this source example.

The checked-in `manual-mode.yaml` supplies this goal without a separate provider.
It still needs a human or agent to answer the generated queue prompt, as described
in the [shared manual-mode guide](../README.md#agent-assisted-mode-verified-example):

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --example saturating-adder --project /tmp/saturating-adder-work \
  --config examples/evolutionary-example/saturating-adder/manual-mode.yaml \
  --iterations 1 --timeout 60
```

No responder is started automatically. Use an already installed compatible
OpenEvolve environment; the manual queue can wait indefinitely for a response.

## Optional external evolution

If OpenEvolve is already available in your chosen environment, you may use an
external YAML with your own approved provider/model settings:

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --example saturating-adder --project /tmp/saturating-adder-work \
  --config /path/to/your-openevolve.yaml --iterations 5 --timeout 60
```

Set its prompt to preserve the interface, implement unsigned `min(a+b,15)`, and
edit only the candidate's evolve block. The configuration is external; this
example installs nothing and configures no provider. Provider-backed search
may share RTL and feedback and incur charges. See the [shared guide](../README.md)
for the external API, required overrides, limits, retained evidence and
cancellation. Provider-backed autonomous search is not demonstrated here.
