# Enabled 4-bit counter

## Goal and files

On a rising clock edge, synchronous active-high reset sets `count[3:0]` to zero.
Otherwise, increment modulo 16 when enabled and hold when disabled. Reset wins.
This is a teaching contract, not a vendor specification.

- `counter.sv`: faulty baseline; ignores enable.
- `correct-counter.sv`: manually authored acceptance fixture, not search output.
- `trusted/counter_tb.sv`: 80 fixed cycles covering reset, hold and wrap.
- `trusted/score.py`: independent recurrence and actual waveform-input checks.

Only edit implementation inside EVOLVE-BLOCK; keep ports and trusted files fixed.
See the [walkthrough](EVOLUTION_EXAMPLE.md) for exact RTL and hardware/lineage graphs.

## Evaluate without an LLM

Requires Node.js 22.13+, Python 3.10+ and stock `iverilog`/`vvp` on PATH.
No OpenEvolve package or provider is needed. From the checkout:

```sh
mkdir -p /tmp/counter-work
python3 examples/evolutionary-example/run.py evaluate --example counter --project /tmp/counter-work
# Expected exit 1: baseline passes 11/80.
python3 examples/evolutionary-example/run.py evaluate --example counter --project /tmp/counter-work \
  --candidate examples/evolutionary-example/counter/correct-counter.sv
# Expected exit 0: manual fixture passes 80/80; no search.
```

The scorer samples at +1 ns after each rising edge. Fitness is `checks_passed / 80`;
readiness requires all 80 observations and managed checks. Results include linked
project/job/run/artifact IDs. Candidate stdout does not supply fitness.

## Recorded search and reproduction

Real OpenEvolve 0.4.0 manual mode evaluated two generation-1 siblings:
enable-gated increment and addition of zero-extended enable. Both passed 80/80;
OpenEvolve selected the first, which passed **80/80 in a fresh independent job**.
All four run closures verified and independent waveform rescoring matched.
The agent knew the goal and manual fixture; no separate provider API was used.

To run a new search, save the counter YAML from the
[shared manual-mode guide](../README.md#agent-assisted-mode-verified-example) as
`/path/to/agent-assisted.yaml`, then use an approved installed OpenEvolve environment:

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --example counter --project /tmp/counter-work \
  --config /path/to/agent-assisted.yaml --iterations 2 --timeout 60
```

A human or existing agent must answer the actual queue prompts; no responder starts
automatically. This demonstrates guided integration, not blind or unattended search.
Full original recordings are machine-local, not bundled; the walkthrough lists paths.

These are fixed functional tests, not formal proof or PPA measurements.
Use the [shared guide](../README.md) for queue answers, evidence inspection,
optional combined source/RTL/waveform review (`--debug`), limits and cancellation.
