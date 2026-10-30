# Managed counter activity workflow

This original MIT example demonstrates a project-defined evaluation contract.
`workflow.json` lists every fixed input in `template/`. Only `counter.sv` changes.
Stock Icarus simulation produces a waveform; `score.py` independently checks 80
counter observations; `activity.py` counts observed output-bit transitions.
Correctness and managed task checks gate fitness before the activity objective
can be accepted.

```sh
mkdir -p /tmp/custom-counter-work
python3 examples/evolutionary-example/run.py evaluate \
  --project /tmp/custom-counter-work \
  --workflow examples/evolutionary-example/project-workflow/workflow.json
# Faulty baseline: exit 1, fitness -1 because required correctness checks fail.
python3 examples/evolutionary-example/run.py evaluate \
  --project /tmp/custom-counter-work \
  --workflow examples/evolutionary-example/project-workflow/workflow.json \
  --candidate examples/evolutionary-example/counter/correct-counter.sv
# Passing fixture: exit 0; actual output-bit-transition count and normalized fitness.
```

Run from the checkout, or discover the installed runner and workflow through
`chipsim agent help`. Requires Node.js 22.13+, Python 3.10+ and `iverilog`/`vvp`.
No OpenEvolve or provider is used by these commands.

`output_bit_changes` has unit `bit-transitions`, is minimized, and is normalized
over `[0,200]`. The scorer ignores unknown output before initialization and
rejects it afterward. This measures observed simulation activity, not physical
power. Every correct counter produces the fixed output sequence, so this is a
contract demonstration rather than a useful optimization benchmark.

For a hardware project, copy and adapt the definition/template to your tools,
independent checks, fixed libraries and constraints. Declare report producer,
units, bounds, directions and weights explicitly. See [EVOLUTION.md](../../../docs/EVOLUTION.md)
for the complete contract, real PPA report integration, search budgets, ancestry
and trust limits.
