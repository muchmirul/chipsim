# Highest-bit priority encoder

Read [Evolution mechanism, before/after RTL and measured results](EVOLUTION_EXAMPLE.md)
for the goal-to-hardware walkthrough.

## Goal and allowed changes

Implement combinational `priority_encoder(request[7:0], valid, index[2:0])`.
`valid` is one when any request is asserted. `index` is the highest asserted bit
number, or zero when empty. No clock, reset, latch or stored state is needed.
This is an illustrative contract, not a vendor specification or a PPA objective.
Only change implementation inside the EVOLVE-BLOCK markers; preserve ports and
module name. Never change the trusted testbench, scorer or evaluation tools.

`priority-encoder.sv` deliberately scans from bit 7 down to bit 0 and overwrites
its answer, so the lowest request wins. For `8'b10000001`, it wrongly returns 0
instead of 7. `correct-priority-encoder.sv` is a **manually authored acceptance
fixture** that reverses the scan, so the highest bit wins. It is not search output.
Both versions assign defaults to every output, including the empty request.

## Evaluate without an LLM

Requires Node.js 22.13+, Python 3.10+, stock `iverilog`/`vvp` on PATH. No Python
package, provider or dependency install is needed for individual evaluations.

```sh
mkdir -p /tmp/priority-encoder-work
python3 examples/evolutionary-example/run.py evaluate --example priority-encoder \
  --project /tmp/priority-encoder-work
# Expected exit 1: baseline passes only 9/256 masks (empty or one-hot).
python3 examples/evolutionary-example/run.py evaluate --example priority-encoder \
  --project /tmp/priority-encoder-work \
  --candidate examples/evolutionary-example/priority-encoder/correct-priority-encoder.sv
# Expected exit 0: manual fixture passes 256/256.
```

The fixed harness enumerates all 256 request masks, driving at `cycle * 10 ns`
and finishing at 2560 ns. The independent Python scorer samples at `cycle * 10 +
6 ns`. It checks the actual input, widths, ordered times and complete duration,
and derives the expected index from integer bit length, not the RTL loop.
One observation passes only when **both** valid and index match. Unknown/missing
outputs fail; incomplete traces or changed stimulus reject evaluation. The first
12 failures are listed. The score is `checks_passed / 256`, not candidate stdout.

The result covers all binary masks at fixed sample times, not glitches, delay,
formal equivalence, area, power or silicon behavior. Copied projects isolate
execution/evidence but are not an OS security sandbox.

## Recorded agent-assisted OpenEvolve demonstration

The exact selected source is retained as [`evolved.sv`](evolved.sv), with
[`demonstration.json`](demonstration.json) recording metrics, hashes and original
machine-local evidence identifiers. This is distinct from the manual fixture.
The generated file preserves its original baseline comment even though its
implementation was repaired. Evidence directories are not included in the package.

A real installed OpenEvolve 0.4.0 manual-mode run on 2026-10-19 managed one
agent-authored loop-order variation, selection and fresh finalist evaluation:

| Stage                                      | Passed observations |
| ------------------------------------------ | ------------------- |
| Lowest-bit baseline                        | 9/256               |
| Highest-bit agent variation                | 256/256             |
| Selected RTL, fresh independent evaluation | **256/256**         |

The candidate is a generation-1 child of the baseline. The agent answered a real
queue prompt; OpenEvolve applied the diff and managed the search. The agent knew
the goal and manual fixture, so this demonstrates integration, not blind discovery
or unattended provider-backed search. The correct fixture remains manually
authored, not renamed search output. The initial testbench was corrected before
this run to drive an X-to-zero transition at time zero, ensuring the empty input
actually triggers combinational logic. The trusted files stayed fixed during the
completed run. All three run closures verified and independent waveform rescoring
matched. Full machine-local prompts, answers and artifacts are not bundled here.

Use the checked-in goal-specific queue configuration with an already installed
compatible OpenEvolve environment:

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --example priority-encoder --project /tmp/priority-encoder-work \
  --config examples/evolutionary-example/priority-encoder/manual-mode.yaml \
  --iterations 1 --timeout 60
```

Answer the actual queue prompt as described in the
[shared manual-mode guide](../README.md#agent-assisted-mode-verified-example).
No responder starts automatically; the queue may wait indefinitely for an answer.

## Optional external evolution

Use an already installed compatible OpenEvolve environment and an explicitly
approved configuration. Give it this interface and highest-bit/empty behavior,
not the counter prompt in the shared walkthrough:

```sh
/path/to/your/venv/bin/python examples/evolutionary-example/run.py evolve \
  --example priority-encoder --project /tmp/priority-encoder-work \
  --config /path/to/your-openevolve.yaml --iterations 1 --timeout 60
```

See the [collection guide](../README.md) for manual-mode queue responses, retained
artifacts, final independent evaluation, optional `--debug`, limits and cancellation.
No provider or responder is installed automatically; external API calls may share
RTL and incur costs. Passing the checked-in fixture alone is not evolution.
