# Highest-bit priority encoder

## Goal and files

Combinational `priority_encoder(request[7:0], valid, index[2:0])` reports the
highest asserted bit. `valid = 1` for a nonzero request; empty gives `valid = 0`
and `index = 0`. There is no clock or state. This is a teaching contract, not a vendor spec.

- `priority-encoder.sv`: faulty downward scan; lowest asserted bit wins.
- `correct-priority-encoder.sv`: manually authored acceptance fixture, not search output.
- `evolved.sv`: exact selected RTL, including its stale baseline comment.
- `demonstration.json`: metrics, hashes and original machine-local evidence IDs.
- `trusted/`: fixed testbench and independent Python scorer for all 256 masks.

Only edit implementation inside EVOLVE-BLOCK; preserve module, ports and widths.
Keep trusted files and tools fixed. See the [walkthrough](EVOLUTION_EXAMPLE.md)
for exact before/after RTL and conceptual hardware and measured lineage graphs.

## Evaluate without an LLM

Requires Node.js 22.13+, Python 3.10+ and stock `iverilog`/`vvp` on PATH.
No OpenEvolve package or provider is needed. From the checkout:

```sh
mkdir -p /tmp/priority-encoder-work
python3 examples/evolutionary-example/run.py evaluate --example priority-encoder \
  --project /tmp/priority-encoder-work
# Expected exit 1: baseline passes 9/256 (empty and one-hot masks).
python3 examples/evolutionary-example/run.py evaluate --example priority-encoder \
  --project /tmp/priority-encoder-work \
  --candidate examples/evolutionary-example/priority-encoder/correct-priority-encoder.sv
# Expected exit 0: manual fixture passes 256/256; no search.
```

Inputs change at `mask * 10 ns`; the scorer samples at +6 ns, using integer bit
length for the expected index. Both outputs must match. It validates inputs,
widths, times and full duration. Fitness is `checks_passed / 256`; readiness needs
all observations and managed checks. Candidate stdout does not supply fitness.

## Recorded search and reproduction

Real OpenEvolve 0.4.0 manual mode recorded one generation-1 child reversing the
loop. Baseline **9/256** became **256/256**, also **256/256 in a fresh finalist job**.
All three run closures verified, trusted bytes matched and waveform rescoring agreed.
Before this run, the harness was corrected to drive an X-to-zero transition at
time zero so empty input triggers combinational logic; it then stayed fixed.
The agent knew the goal and manual fixture; no separate provider API was used.
This was guided integration, not blind search. Full local recordings are not bundled.

With an approved installed OpenEvolve environment, start a new one-iteration run:

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --example priority-encoder --project /tmp/priority-encoder-work \
  --config examples/evolutionary-example/priority-encoder/manual-mode.yaml \
  --iterations 1 --timeout 60 --search-timeout 900
```

A human or existing agent must answer the queue; no responder starts automatically.
All binary masks are sampled, but this is not formal proof, glitch/delay coverage
or PPA measurement. The sample offset is not a propagation-delay result.
Use the [shared guide](../README.md) for queue answers, approved external provider
configs, evidence inspection, optional combined debugger review, limits and cancellation.
