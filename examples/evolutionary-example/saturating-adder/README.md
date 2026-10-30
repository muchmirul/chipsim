# Unsigned 4-bit saturating adder

## Goal and files

Combinational `saturating_adder(a[3:0], b[3:0], sum[3:0])` computes unsigned
`sum = min(a + b, 15)`, with no clock, reset or stored state.
This is a teaching contract, not a vendor specification.

- `saturating-adder.sv`: faulty wrapping baseline; `9 + 8` gives 1, not 15.
- `correct-saturating-adder.sv`: manually authored acceptance fixture, not search output.
- `evolved.sv`: exact selected RTL from the recorded agent-assisted search.
- `demonstration.json`: metrics, hashes and original machine-local evidence IDs.
- `trusted/`: fixed testbench and independent Python scorer for all 256 input pairs.

Only edit implementation inside EVOLVE-BLOCK; preserve module, ports and widths.
Keep trusted files and tools fixed. See the [walkthrough](EVOLUTION_EXAMPLE.md)
for exact before/after RTL and conceptual hardware and measured lineage graphs.

## Evaluate without an LLM

Requires Node.js 22.13+, Python 3.10+ and stock `iverilog`/`vvp` on PATH.
No OpenEvolve package or provider is needed. From the checkout:

```sh
mkdir -p /tmp/saturating-adder-work
python3 examples/evolutionary-example/run.py evaluate --example saturating-adder \
  --project /tmp/saturating-adder-work
# Expected exit 1: wrapping baseline passes 136/256.
python3 examples/evolutionary-example/run.py evaluate --example saturating-adder \
  --project /tmp/saturating-adder-work \
  --candidate examples/evolutionary-example/saturating-adder/correct-saturating-adder.sv
# Expected exit 0: manual fixture passes 256/256; no search.
```

Inputs change at `cycle * 10 ns`; the scorer checks `min(a+b,15)` at +6 ns.
It validates inputs, widths, event times and full duration. Fitness is
`checks_passed / 256`; readiness needs all observations and managed checks.
Results link project/job/run/artifact IDs; candidate stdout does not supply fitness.

## Recorded search and reproduction

Real OpenEvolve 0.4.0 manual mode recorded one generation-1 child: preserve a
five-bit sum and clamp on carry. Baseline **136/256** became **256/256**, also
**256/256 in a fresh finalist job**. All three run closures verified, trusted bytes
matched and independent waveform rescoring agreed. The agent knew the goal and
manual fixture; no separate provider API was used. This was guided integration,
not blind or unattended search. Full machine-local recordings are not bundled.

With an approved installed OpenEvolve environment, start a new one-iteration run:

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --example saturating-adder --project /tmp/saturating-adder-work \
  --config examples/evolutionary-example/saturating-adder/manual-mode.yaml \
  --iterations 1 --timeout 60 --search-timeout 900
```

A human or existing agent must answer the queue; no responder starts automatically.
All binary pairs are sampled, but this is not formal proof, glitch/delay coverage
or PPA measurement. The sample offset is not a propagation-delay result.
Use the [shared guide](../README.md) for queue answers, approved external provider
configs, evidence inspection, optional combined debugger review, limits and cancellation.
