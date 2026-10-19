# Enabled 4-bit counter

Read [Evolution mechanism, before/after RTL and measured results](EVOLUTION_EXAMPLE.md)
for the goal-to-hardware walkthrough.

Goal: synchronous rising-edge reset sets count to zero (priority over enable);
otherwise increment modulo 16 when enabled, and hold when disabled. This is an
illustrative interface, not a vendor chip specification or PPA objective.

- `counter.sv`: deliberately faulty baseline, ignores enable.
- `correct-counter.sv`: manually authored acceptance fixture, not search output.
- `trusted/counter_tb.sv`: 80 fixed cycles, including resets, hold and wrapping.
- `trusted/score.py`: independent expected recurrence, waveform stimulus checks.

```sh
mkdir -p /tmp/counter-work
python3 examples/evolutionary-example/run.py evaluate --example counter --project /tmp/counter-work
# Expected exit 1 for baseline.
python3 examples/evolutionary-example/run.py evaluate --example counter --project /tmp/counter-work \
  --candidate examples/evolutionary-example/counter/correct-counter.sv
# Expected exit 0 for manual fixture.
```

See the [collection guide](../README.md) for requirements, external OpenEvolve
search, manual queue operation, evidence inspection and cancellation. A separate
verified real agent-assisted OpenEvolve run improved **11/80 to 80/80**. The agent
knew the goal and fixture; this was not blind or unattended provider-backed search.
Only edit implementation inside the EVOLVE-BLOCK markers, not interface or trusted
files. Fixed tests do not prove formal equivalence or area/power/timing quality.
