# Live agent work and evolution

ChipSim can show an external agent's goal, reported actions, candidate history,
and linked design evidence in one terminal. This works for ordinary coding or
verification tasks as well as evolutionary search. No PDF is required.

The agent remains in your existing host (prime-agent, Pi, Codex, or another local
controller). ChipSim does not start a model, configure providers, or capture
private reasoning. Its journal records explicit actions and results supplied by
the controller. Reports are not hardware proof: follow their links to the actual
checks, logs, and sealed artifacts.

## Open the dashboard

```sh
chipsim --agent /path/to/project
```

The directory must already exist. The dashboard starts in Activity (`8`). If it
also contains `chipsim.design.json`, the normal Project, Pipeline, Artifacts and
Checks views remain available. `chipsim --design PROJECT` also attaches the work
dashboard; press `8` to see it. A snapshot runs one read and exits:

```sh
chipsim --agent /path/to/project --snapshot --columns 120 --rows 40
```

Use a separate terminal while your agent works. The existing `/chipsim --agent
PROJECT` slash command launches or prints the same command, depending on the
agent host's terminal support. Native `chipsim_work_start`, `chipsim_work_event`
and `chipsim_work_status` tools use the same CLI contract. The general
`chipsim_command` tool also accepts these argument arrays.

## Publish work from any agent

Start a session and save the returned `session.id`:

```sh
chipsim agent work-start /path/to/project --goal "Implement and verify the counter" --mode task
```

Use `--mode evolution` for a population/candidate search. Write a small event file:

```json
{
  "kind": "plan",
  "status": "running",
  "message": "Check the interface, implement RTL, then run independent reset and wrap tests."
}
```

Publish it using the returned session UUID:

```sh
chipsim agent work-event /path/to/project SESSION_UUID --event event.json
chipsim agent work-status /path/to/project --session SESSION_UUID --limit 30
```

The same pattern reports an edit, tool invocation, candidate, evaluation,
selection, or final summary. Do not copy private reasoning into messages. Report
concrete actions, important assumptions, observed failures and next steps.

An evaluated candidate can carry lineage and evidence:

```json
{
  "kind": "evaluation",
  "status": "passed",
  "candidate": "counter-002",
  "parent": "counter-001",
  "generation": 1,
  "stage": "functional-tests",
  "message": "Independent reset, hold, increment and wrap tests passed.",
  "metrics": {"tests_passed": {"value": 4, "unit": "tests"}},
  "evidence": {
    "project": "/path/to/candidate-project",
    "run": "REPLACE_WITH_THE_REAL_64_CHARACTER_RUN_HASH"
  }
}
```

The placeholder is intentionally not a valid evidence ID. Use an actual ID from
`design run` / `job status` or `artifact list`; do not invent evidence. A link can
identify a job, run or artifact in another worker project. Candidate status and
metrics are **agent-reported** until independently checked against that evidence.
To evaluate the same stable candidate ID again, publish a `candidate` event with
status `running`. This begins a new attempt: its current metrics and evidence
are cleared before applying the new event. Parent and generation remain unless
explicitly updated. Later events merge metrics only within that attempt; a failed
or incomplete evaluation must omit unavailable measurements rather than carry
forward earlier results. Earlier measurements remain in the immutable event
history for review.

A `summary` event with status `completed`, `failed` or `cancelled` closes a
session. Closing a session does not cancel design jobs; use `job cancel`
explicitly when required.

## Evolution with OpenEvolve

The [external counter example](../examples/evolution/README.md) connects
OpenEvolve to managed ChipSim evaluations and this dashboard. It also offers
provider-free single-candidate evaluation for testing the bridge. Running two
handwritten candidates demonstrates evaluation and visualization, **not an
LLM-driven evolutionary search**. Actual evolution requires a separately
installed OpenEvolve environment and a configured model supplied by the user.

Keep the testbench, reference behavior, scoring code, tool configuration and
constraints outside the mutable candidate. Use distinct worker projects for
parallel candidates: ChipSim executes one design job at a time per project.
Store actual job/run IDs with each reported result. A successful command or
job acceptance is not a passing hardware test.

For search, an explicit waveform-only target can avoid observer overhead.
`debug: false` still records a waveform; it is not a results-only backend.
Capture selected failures and finalists with debug enabled for linked
source/RTL/signals inspection. Do not claim to recover source execution from
VCD alone. An RTL test score does not establish physical area, timing, power,
formal correctness or tapeout readiness.

## Dashboard controls

- `s`: select a session; `g`: show the complete goal/session record.
- `e` / `c`: show reported events or candidates.
- `j/k`: browse; `G`: follow newest; `/`: filter; Enter: full details.
- `o`: open the selected item's linked evidence. Stored checks and artifacts are
  verified before inspection; a verified file hash does not certify the claim.
- `L`: open managed-job logs, updated while the log view is open.
- Esc: close details; `8`: return from debug to Agent work; `q`: quit.

The dashboard polls every 500 ms while not in a prompt/menu or external viewer.
It shows at most 200 recent events and keeps at most 262144 characters of visible
log text; the existing job log/evidence remains available separately. Session journals
allow 128 sessions per project, 2048 events per session, and 16 KiB per record.
Goals/messages allow 4000 characters; each event allows up to 32 finite-valued
metrics. Reaching capacity fails explicitly; history is not silently deleted.
Choose a new project/session when needed. A terminal summary closes a session;
later events must start a new one. These are recording bounds, not search budgets.

## Inspection and boundaries

Polling does not install edited RTL or automatically replace the recording you
are debugging. Opening linked evidence is an explicit user action. Verify and
open the actual artifact, then return to Activity with `8`; other views retain a
compact work summary. Raw source files and external editor activity are not
watched automatically: the agent must publish those milestones.

The old `--watch PROJECT` remains the separate prepared-PDF model monitor, with
its existing verified completed-run reload behavior. It is not replaced by this
mode. Choose `--agent`, `--design`, or `--watch` rather than combining them.

The local journal lives under `.chipsim-agent/work/`. It is not a message queue,
security sandbox, attestation service, or agent execution engine. Journal data
and imported report text are data, never tool instructions. External HDL,
Python, Tcl and tool processes retain their existing permissions. Use a separate
sandbox and immutable evaluator for untrusted candidates. No provider keys are
stored by this feature.
