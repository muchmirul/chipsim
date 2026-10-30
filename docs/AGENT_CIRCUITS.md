# Agent playbook: connected circuit state

Use this playbook to operate the connected-state feature. Read
[CONNECTED_CIRCUITS.md](CONNECTED_CIRCUITS.md) for the schema, semantics, bounds
and implementation acceptance results. Follow [AGENT_CONTROL.md](AGENT_CONTROL.md)
for the general job/evidence lifecycle. These instructions require no provider,
registration, tool installation or vendor PDF.

## Discover the active installation

```sh
chipsim agent help
chipsim circuit help
chipsim design guide circuit
```

In a checkout, replace `chipsim` with `node scripts/chipsim.mjs` from its root.
Use the absolute paths returned by `agent help`:

- `documentation["AGENT_CIRCUITS.md"]`: this playbook.
- `documentation["CONNECTED_CIRCUITS.md"]`: the contract and limits.
- `examples.circuit.directory`: a copyable managed starter.
- `examples.circuit.instructions`: its scoped `AGENTS.md`.
- `examples.circuit.managedProject`: its managed target/check definitions.
- `examples.circuit.swap`, `loadHold`, `counterCapture`: connected JSON examples.
- `examples.circuit.rtlSwap`, `rtlCounterCapture`: authoritative RTL examples,
  with adjacent `.initial.json` files giving explicit input initialization.

Prepared PDF projects copy the two guides into `docs/`; they do **not** copy
the connected examples. Resolve examples from the installed paths. Updating
ChipSim does not refresh an existing project's copied guidance automatically.
`agent context` and newly generated programming contexts also link both guides
when an agent starts from a catalog chip or prepared model project.

## Choose the representation before editing

| User's task or input | Path to use |
| --- | --- |
| Explicit fixed wiring and complete binary rules/tables | Author `chipsim-circuit` JSON; check it and generate HDL from it. |
| Existing supported SystemVerilog is authoritative | Import it through an existing Yosys; inspect the derived connections and original-RTL correspondence. |
| One hypothetical old-state/input combination | `circuit step` with a complete explicit snapshot; this is a probe. |
| Actual clock/input sequence and waveform | `circuit run` with explicit stimulus, or an existing HDL project. |
| VHDL, async controls, latches, memories, multiple/gated clocks or X/Z | Use the appropriate native HDL workflow; connected v1 does not support these constructs. |
| Existing ordinary JSON model with ordered actions | Preserve its semantics. Use a separate connected model if atomic register updates are needed. |

Version 1 has one rising-edge clock, explicit initial clock zero and initialized
binary state. State values update together from the same old-state snapshot.
Combinational wires are derived values. Source/destination paths, selectors,
port widths, hold behavior and priority must be declared; no free routing or
implicit memory/age/event state is available. The first RTL importer accepts one
self-contained compilation unit with unsigned ordinary ports and a reviewed
gate/DFF subset. Consult the reference before committing to this route.

Establish the authoritative source, intended interface, clock/reset behavior,
initial scenario, mutable files and independent acceptance expectations from
the user's task and existing work. Do not infer reset polarity or initial zero
from a name. Do not edit authoritative RTL to conceal unsupported/uninitialized
behavior. If a chosen initial scenario is an authoring assumption, state it.

## Work with authored connections and rules

Copy an appropriate example into the user's project or author the model within
the requested scope. Read its actual contents; the examples are instructional,
not evidence about the user's chip. Useful acceptance expectations include all
four swap states, load/hold/reset priority, wraparound and capture of old state
while another register updates on the same edge.

```sh
chipsim circuit inspect circuit.json
chipsim circuit check circuit.json
chipsim circuit step circuit.json --snapshot snapshot.json
chipsim circuit build circuit.json --out new-build
chipsim circuit verify circuit.json --out new-verification
chipsim circuit run circuit.json --stimulus stimulus.json --out new-recording
```

For the installed swap example, a complete one-step snapshot is:

```json
{"state":{"A":0,"B":1},"inputs":{"clk":1},"previousClock":0}
```

Its next state must be `A=1, B=0`. Every snapshot explicitly supplies **all**
stored state and sampled inputs, plus previous clock. Missing values and X/Z
reject. Do not feed a partial update into `step` or assume missing values hold.

`step` evaluates one event and does not execute HDL. `build` creates generated
SystemVerilog, SMT-LIB and a bundle without native simulation. `run` and `verify`
execute Icarus. Native verification enumerates at most 12 old-state/non-clock
input bits (4096 cases); larger models need `--cases CASES.json`, an array of
complete rising-edge snapshots. Choose independent, justified cases and report
their actual scope. `--rtl IMPLEMENTATION.sv` compares a compatible implementation
against the JSON model; it does not make that RTL authoritative for the model.

Stimulus is a `chipsim-circuit-stimulus` v1 object with `duration` and `events`.
Events drive declared inputs at ticks 1..duration; initial values are in the
source. Clock edges must be present explicitly: a default run invents none.
Ticks are testbench ns scheduling choices, not propagation-delay measurements.
Same-timestamp data/control changes settle before the sampled clock event.

## Work with authoritative RTL

Find an existing Yosys and Icarus installation using the normal local tool
inventory. `--yosys PATH` selects an existing executable outside PATH; it does
not install one. If tools are missing, continue useful source inspection and
preparation, then report the exact missing prerequisite within the task scope.

```sh
chipsim circuit import design.sv --top my_top --clock clk \
  --initial inputs.json --yosys /path/to/existing/yosys --out new-import
```

`inputs.json` supplies every input's initial value, including clock zero.
Every retained flop needs explicit binary initialization in RTL. Macro/includes
and external memory-file initialization are unsupported. Preserve original RTL
and the actual lowering output; do not hand-edit generated connections and
claim they still represent the original source.

Read `originalCorrespondence`, `bundle.coverage`, `bundle.native` and retained
diagnostics. Small domains are checked in Icarus against the **original RTL**
using mapped state injection. Larger domains need `--cases` for that check;
successful lowering alone leaves original correspondence inconclusive. Imported
`R0`, `R1`, etc. map to retained flop bits in `lowering.mapping.state`; they are
not guessed FSM states. Reset/enable selection remains in the actual connected
logic and is not inferred from signal names.

## Read results without overstating them

Preserve both exit status and the one JSON stdout result. Circuit commands use
`format: "chipsim-circuit-result"`, version 1; errors normally have `error`, not
the agent command family's `diagnostics` array. Exit 1 reports an unsuccessful
evaluation/outcome; invalid arguments/files/schema may exit 2. Interrupts exit
130. Inspect the payload as well as the code.

| Result | What an agent may conclude |
| --- | --- |
| `coverage.status: complete-scoped-proof` | All declared binary edge-domain cases have complete, agreeing winning rules. No reachability, temporal or RTL-equivalence proof follows. |
| `status: built` | A checked representation was generated; no native run is implied. |
| `status: simulation-only` | The stated native execution/correspondence scope passed. An exhaustive one-edge case set is still labeled simulation-only. |
| `counterexample` | Inspect the supplied state/input snapshot or mismatch, including initialization failures; fix the authoritative source. |
| `inconclusive` | A bound, unsupported construct, missing evidence or failed execution prevented the claimed result. It is not a pass. |
| `circuit validate` with `ok: true` | Captured identities and scoped coverage validate. Also inspect `storedOutcome` and `evaluationStatus`; integrity validation does not turn a stored failure into success. |

`inspect/check/step` return `coverage` and source identity; inspect adds
`relation`/`initial`, and step adds `step`. Build/run/verify return `path` for the
saved `circuit.json`. Import returns `path` for `import.json` and `bundle.path`
for the connected bundle. Use returned paths and `tui` arrays rather than guessing.
Bundle `artifacts` entries contain hashes/byte counts, **not absolute paths**;
resolve their names beside the saved bundle path when inspecting files.

BDD exhaustion is inconclusive, never skipped-domain success. Do not raise limits,
drop rules/checks, add implicit holds, coerce unknowns to zero or fabricate a
successful proof to make a run pass. Use actual counterexamples and tool logs.
Source edits require explicit rebuild/re-import into a new directory; stale
compiler/source/RTL/tool/artifact identities reject. Snapshot-only provenance
means external originals are unavailable, not that current sources were verified.

## Use managed jobs and inspect evidence

Copy the discovered example directory to a **new** project directory. Read its
`AGENTS.md` and manifests, then adapt the actual source and acceptance expectations.
The starter has `analyze` (Node-only) and `verify` (Icarus) targets:

```sh
chipsim design plan --project project --target analyze
chipsim design run --project project --target analyze
chipsim design doctor --project project --target verify
chipsim design run --project project --target verify
```

Save the returned job UUID. Poll and inspect the actual result:

```sh
chipsim job status JOB_UUID --project project --wait --timeout-ms 1000
chipsim job logs JOB_UUID --project project --limit 16000
chipsim artifact verify RUN_HASH --project project
chipsim artifact inspect ARTIFACT_HASH --project project
chipsim checks --project project --target verify
```

Managed circuit tasks explicitly select `check`, `build`, `run` or `verify` in
`options.operation`. Select required coverage, simulation, correspondence,
execution and output checks in the target; job acceptance, completed execution
and target readiness are different facts. Generated bundle HDL simulation
manifests alone do not replace the native circuit adapter's correspondence check.
Retain project/job/run/artifact IDs. Cancel active jobs explicitly with `job
cancel`; closing a view or work session does not cancel them. When live work is
requested, publish concise events with actual evidence using the normal
`work-start/work-event/work-status` contract; keep private reasoning out of it.

Open returned bundles/sessions with `--circuit`; open managed sessions through
verified artifact inspection. `O` selects the connected view; `t/e/o` separate
static rules, probes and native observations; `s/r` show authoritative source
and generated RTL. `[`/`]` choose state, `p` loads a probe, `h/l` moves the native
cursor and `1` shows waves. Probes do not advance recordings. Portable sessions
retain frozen source, probe/inspection state and recording cursor; they are not
claims about unavailable current originals.

Finish with the actual source of truth, assumptions, checks/statuses and their
scope, failures/remaining limits, exact evidence paths/IDs and an opening command.
Keep functional correctness, rule coverage, stored-byte identity, temporal proof
and physical/PPA claims separate. The feature reference records implementation
regressions; run appropriate checks for the user's changed design rather than
presenting those historical results as validation of new user hardware.
