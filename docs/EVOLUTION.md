# Project-defined RTL evolution

ChipSim evaluates a fixed managed design; an external OpenEvolve installation
owns candidate generation and selection. Use `chipsim agent help` to discover
`examples.evolution.runner`, `examples.evolution.workflows` and this guide's
installed path. No PDF is needed. The [teaching examples](../examples/evolutionary-example/README.md)
remain available with `--example counter|saturating-adder|priority-encoder`.

## Evaluate an existing hardware workflow

Create a version-1 `chipsim-evolution-workflow` JSON beside your template project.
The [runnable definition](../examples/evolutionary-example/project-workflow/workflow.json)
and [template](../examples/evolutionary-example/project-workflow/README.md)
show the complete contract. Manual evaluation requires Python 3.10+, Node.js
22.13+ and the tools declared by your project, with no OpenEvolve dependency:

```sh
mkdir -p /tmp/hardware-work
python3 /installed/examples/evolutionary-example/run.py evaluate \
  --project /tmp/hardware-work --workflow /path/to/workflow.json \
  --candidate /path/to/candidate.sv --timeout 60
chipsim --agent /tmp/hardware-work
```

The definition has these required fields; additional fields reject:

| Field | Contract |
| --- | --- |
| `format`, `version` | `chipsim-evolution-workflow`, integer `1` |
| `goal` | Explicit hardware objective, 1–4000 characters |
| `template` | Existing directory, resolved relative to this JSON; absolute paths also work |
| `files` | Explicit relative file paths, including both design manifests, the candidate, testbenches, scoring scripts, constraints and tool inputs |
| `candidate`, `language` | The only replaceable file; `verilog` with `.v`/`.sv`, or `vhdl` with `.vhd`/`.vhdl` |
| `target` | Managed target with tasks and nonempty `requiredChecks` |
| `report` | `{ "task": "measure", "path": "out/metrics.json" }`; a required output of that reachable task |
| `objectives` | 1–16 explicit name/unit/direction/range/weight objects |

`files` accepts 1–256 regular files, at most 4 MiB each and 16 MiB total.
Paths cannot escape the template, traverse symlinks or include repository/cache
directories. Candidate source is at most 64 KiB. The runner snapshots and
fingerprints the listed files once per invocation; every fresh candidate project
copies those exact bytes before replacing its RTL. Changes to the authoring
template do not change an active invocation. Changes to frozen bytes reject the
next evaluation. Include every required input explicitly; files are not fetched
or toolchains installed automatically. Managed design validation still applies.

Use independent fixed reference tests and declare correctness and hard constraints
in `requiredChecks`. Nonempty checks alone do not establish their adequacy.
For physical PPA, retain real synthesis/place/route reports with the library,
process corner, clock/IO constraints and tool identity in the fixed managed
inputs/evidence. A functional simulation score is not a physical measurement.

## Measurements and fitness

For example, declare objectives like these when your real tool reports them:

```json
[
  {"name":"area","unit":"um2","direction":"minimize","range":[0,10000],"weight":1},
  {"name":"frequency","unit":"MHz","direction":"maximize","range":[0,500],"weight":2}
]
```

The trusted report must contain each named measurement as
`"area": {"value": NUMBER, "unit": "um2"}`. Values must be finite numbers,
not booleans; units must match exactly. Objective names are unique and cannot be
`combined_score`; weights are positive and at most 1,000,000; ranges contain
two increasing finite bounds. Units are declarations, not automatic conversion.

For each value, normalize `(value-low)/(high-low)` and clamp to `[0,1]`.
For minimization, subtract that utility from 1. `combined_score` is the weighted
mean of utilities, maximized by the optimizer. Raw measurements and units are
retained even outside the normalization range. Out-of-range values are not hard
constraint failures unless the managed checks declare those constraints.

The adapter verifies the run closure and follows exact attempt/artifact IDs.
It accepts only the specified producer's report from the current job, so a
same-named simulator output cannot supply fitness. A completed evaluation is
`passed` only when all required checks pass and the report validates. A measured
report with failed gates receives fitness `-1`, retaining its raw measurements;
missing/invalid reports and incomplete execution also receive `-1`, with
`measured: false` and no invented measurements. Built-in teaching goals retain
their existing zero failure penalty and partial functional scores.

The supplied custom example counts observed output-bit transitions from a real
counter waveform and gates fitness with 80 independent functional observations.
This illustrates the contract; the fixed output behavior gives a passing counter
the same observed activity. It is not an area, power or timing optimization
benchmark. Replace the managed measurement task with your actual tool flow to
optimize a meaningful hardware objective.

## Search, deadlines and ancestry

Use an already approved OpenEvolve environment/configuration. Its system prompt
must describe your interface, mutable evolve block, objectives and fixed tests;
the workflow JSON does not rewrite provider prompts or authorize API costs.

```sh
/path/to/approved/venv/bin/python /installed/examples/evolutionary-example/run.py evolve \
  --project /tmp/hardware-work --workflow /path/to/workflow.json \
  --config /path/to/approved.yaml --iterations 5 --timeout 60 --search-timeout 900
```

`--timeout` bounds one managed evaluation (1–300 seconds). `--search-timeout`
bounds evolution from invocation setup through queue waits, checkpoint import and
fresh finalist evaluation (1–86400 seconds, default 900). Expiry returns 124,
closes the owned session as failed, stops the optimizer process group and requests
cancellation of this invocation's jobs. No selected result is accepted after
expiry, even if the optimizer returns its best-so-far result while stopping.
Cleanup/journal writes can take extra time; shutdown escalates to KILL after
five seconds. Ctrl-C/SIGTERM returns 130. POSIX supervision is required.
Provider-side call limits and spending remain external. SIGKILL requires manual
job recovery/cancellation.

Every call writes its own exclusive configuration under
`evaluations/SESSION/invocations/INVOCATION/adapter.json`. The runner prints and
returns both UUIDs. Checkpoints, `CANCEL`, frozen custom inputs, selected source
and isolated attempt directories live there. `evaluate --session UUID` appends
to a running session without replacing another invocation's configuration or
cancellation marker; its caller owns session closure. Rejected inputs create no
invocation. Existing session-level files remain intact.

Optimizer evaluations use unique attempt identities even when two individuals
contain identical RTL. The supervisor imports actual parent/generation from
OpenEvolve 0.4.0 checkpoint records, matching evaluator identity and exact code
SHA-256. Migration copies are not additional variations. It imports no optimizer
metrics: managed evaluator measurements remain authoritative for reporting.
Checkpoint scanning is bounded to 128 directories and 512 program files each;
partial, malformed or unmatched records leave ancestry unknown. Recorded parents
may arrive on a later checkpoint poll. Root is displayed only for explicit
generation zero; other missing parents display `unknown`.

Selection is re-evaluated in a fresh managed job. A matching recorded optimizer
individual keeps its identity and ancestry for that new measurement; the bridge
does not invent an extra generation. If no matching checkpoint is available,
fresh evaluation still works and ancestry remains unknown. Manual evaluations
can supply known `--parent`/`--generation` explicitly.

All journal metrics/ancestry remain agent-reported. Inspect the linked run and
artifacts to verify stored bytes and checks. Input isolation and hashes are not
an OS sandbox or a proof of correctness. See [AGENT_CONTROL.md](AGENT_CONTROL.md)
for execution/evidence boundaries and [AGENT_WORK.md](AGENT_WORK.md) for the TUI.

## Verification

`node --test test/evolution.test.js test/evolution-workflow.test.js` checks
contracts, isolation, scoring, checkpoint mapping and a queue/deadline protocol
fixture. Set `CHIPSIM_TEST_EVOLUTION=1` for real managed Icarus checks, verified
objective reports, independent correctness gating, fresh finalist ancestry and
deadline cancellation during simulation. Optimizer fixtures make no model
requests and are not evidence of a new evolutionary search. Dashboard unit and
PTY tests inspect unknown/root labels at 80×24 and 120×40; installed-package
checks validate discovery and the packaged custom workflow.
