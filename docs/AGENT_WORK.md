# Live agent work and evolution

ChipSim shows an external agent's goal, reported actions, candidate history,
and linked design evidence in one terminal. Ordinary tasks and evolutionary
search use the same journal. Any existing local directory works; no PDF or
`chipsim.design.json` is required.

For the wider agent control surface, discovery and evidence workflow, start with
[AGENT_CONTROL.md](AGENT_CONTROL.md). For native Pi/prime-agent calls, see
[AGENT_EXTENSIONS.md](AGENT_EXTENSIONS.md).

## What this controls

`work-start`, `work-event` and `work-status` create, append and read **reports**.
They do not control your editor or agent, execute an event's text, run an
evaluator, launch a provider, capture all tool activity or record private
reasoning. Your external controller performs the work and publishes concise
public actions, assumptions, observed outcomes and next steps.

All work statuses and metrics are labeled **agent-reported**. Evidence links are
validated for shape when recorded, not checked for existence or correctness.
Check actual jobs, logs, checks and artifacts separately. A successful journal
write proves only that the report was recorded; even verified artifact bytes do
not prove the report's hardware claim.

## Commands and session lifecycle

| Command                                    | Required            | Optional                                                   | Result fields beyond the common envelope                                 |
| ------------------------------------------ | ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `chipsim agent work-start PROJECT`         | `--goal TEXT`       | `--mode task\|evolution` (default `task`)                  | `project`, `session` (save `session.id`)                                 |
| `chipsim agent work-event PROJECT SESSION` | `--event FILE.json` | none                                                       | `project`, `sessionId`, stored `event`                                   |
| `chipsim agent work-status PROJECT`        | none                | `--session SESSION`, `--limit N` (default 50, range 1–200) | `project`, `session`, `events`, `candidates`, `totalEvents`, `reporting` |

Every command returns one JSON object with `format: "chipsim-agent-result"`,
`version: 1`, `command` and `ok`. Check the process exit status **and** `ok`;
failures include `diagnostics` with `code`, `message` and `details`.
`chipsim agent help` exposes commands, limits and installed guide/example paths.

- `work-start` always creates a new UUID session, with immutable `goal`, `mode`
  and `createdAt`; it does not resume an older session. Goals allow 1–4000 text
  characters. Save the returned ID outside the prompt if the controller may restart.
- `work-status` without `--session` selects the **newest-created** session, not
  the most recently updated or still-running session. Without any sessions it
  returns `session: null`, empty arrays and `totalEvents: 0`. Use the saved ID
  explicitly when several controllers share a project.
- A session starts `running`. Only a `summary` event with status `completed`,
  `failed` or `cancelled` changes that session status and closes it. Later appends
  fail with `WORK_CLOSED`. A `failed` evaluation, `completed` tool event, or a
  `summary` marked `passed`, `inconclusive` or with no status does **not** close it.
- There is no reopen, amend, delete, automatic retry or resume command. After a
  controller restart, read `work-status --session` and continue appending if the
  session is still running and has capacity. Start a new session after closure
  or exhaustion; include a prior session ID in the new goal/message if useful.
- Work-session status and candidate status are not managed-job state. Closing a
  session, quitting the dashboard or stopping the controller does not cancel an
  accepted design job. Use `chipsim job cancel` explicitly, then inspect its
  result. Likewise, a completed job does not automatically close a work session.

`events` is the newest bounded tail, in sequence order. `totalEvents` counts all
stored events. `candidates` is reduced from **all** events, not just that tail.
Sessions/events carry generated IDs and timestamps; `work-start` returns the
header, while `work-status` adds the derived session `status`.

## Complete input event contract

The event file must be one UTF-8 JSON object. Only the following top-level keys
are allowed. Unknown keys, including caller-supplied `id`, `sequence`, `time`,
`createdAt`, `updatedAt`, `format`, `version`, `reporting` or `session`, are
rejected. Pass the session ID as the command argument, not in the file. The
journal supplies event ID, sequence, timestamp and reporting metadata.

| Field        | Requirement and allowed value                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`       | Required: `plan`, `edit`, `tool`, `candidate`, `evaluation`, `selection` or `summary`. Kinds label reports; they do not trigger actions.                                                        |
| `message`    | Required nonblank string, 1–4000 text characters.                                                                                                                                               |
| `status`     | Optional: `running`, `completed`, `failed`, `inconclusive`, `cancelled` or `passed`. Any kind accepts these labels; only the terminal-summary rule above closes a session.                      |
| `candidate`  | Optional except required for `kind: "candidate"`. A string matching `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` (1–128 characters). This is your stable candidate label, not a generated job/session ID. |
| `parent`     | Optional candidate identifier with the same syntax. Requires `candidate` and cannot equal it.                                                                                                   |
| `generation` | Optional integer from 0 through 9007199254740991. Requires `candidate`.                                                                                                                         |
| `stage`      | Optional nonblank string, 1–128 text characters.                                                                                                                                                |
| `metrics`    | Optional object with at most 32 named measurements; contract below.                                                                                                                             |
| `evidence`   | Optional object with at least one actual `job`, `run` or `artifact` reference; contract below.                                                                                                  |

Text fields reject control characters U+0000–0008, U+000B–000C,
U+000E–001F and U+007F. Tabs/newlines/carriage returns are accepted; use short,
readable public reports. Character bounds use JavaScript string length; the
separate record byte limit still applies. Optional fields should be omitted
when unavailable, not sent as `null`.

Each metric name is nonblank text of at most 64 characters. Its value must be
an object containing **only** required `value` and `unit` fields:

```json
{ "tests_passed": { "value": 4, "unit": "tests" } }
```

`value` must be a finite JSON number; `unit` is a string of 0–64 characters
(empty is allowed). Negative/fractional measurements are accepted; ChipSim does
not infer units, scoring direction or validity. The numbers above illustrate
syntax, not a measured result. Metrics and lineage are optional in both modes;
neither creates a search algorithm or a ranking policy.

`evidence` permits **only**:

| Field      | Value                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job`      | Lowercase UUID returned for an actual managed job.                                                                                                                   |
| `run`      | Actual lowercase 64-hex-character SHA-256 run ID.                                                                                                                    |
| `artifact` | Actual lowercase 64-hex-character SHA-256 artifact ID.                                                                                                               |
| `project`  | Optional nonblank path, at most 4096 characters. Relative paths resolve against the **work project**, not the event file or caller's cwd. Omit for the work project. |

At least one of `job`, `run` or `artifact` is required; **project-only evidence
is invalid**. Multiple references may be supplied. A referenced project need
not exist at write time. Never invent IDs or use a filename as an artifact ID.
Take IDs from real command results: `design run` returns `job.id`, `job status`
can return `job.run`, and `artifact list` exposes stored artifact IDs. Inspect
those records and required checks before reporting measurements or success.
For a real parsed job-status result `checked`, for example, construct the link
from `checked["job"]["id"]`; add `checked["job"]["run"]` only if present.

### Candidate aggregation and re-evaluation

Any event containing `candidate` creates/updates that candidate's current row.
A candidate need not have a prior `candidate` event. New rows start `running`
with empty metrics. Supplied `parent`, `generation`, `status`, `stage`, `message`
and `evidence` replace those fields; omitted fields retain their prior values.
Supplied metrics merge by name. Evidence replaces the whole prior evidence
object; it is not merged. `updatedAt` comes from the generated event timestamp.

To evaluate the **same stable candidate ID** again, first publish `kind:
"candidate"`, `status: "running"`. This resets its current metrics and evidence
before applying that event's fields. Parent, generation and stage remain unless
you explicitly update them. Then publish the new evaluation. Omit unavailable
measurements on a failed or incomplete attempt; do not carry earlier scores
forward. The previous events stay immutable and inspectable. A plain
`evaluation` event, including one marked `running`, does not perform this reset.

Lineage is a reported label: parents need not already exist, generations need
not be consecutive, and only self-parenting is rejected. `selection` reports
your controller's decision; ChipSim neither picks nor launches a candidate.

## Minimal process example: plan → candidate → evaluation → summary

Save this as `report_work.py` and run `python3 report_work.py /existing/project`
with the installed `chipsim` on PATH. It demonstrates **reporting only**, makes
no hardware claim and runs no evaluator. The candidate label is caller-defined;
the session ID is always taken from the returned result. Replace the reporting
steps with your actual controller's observations for real work.

```python
import json
import subprocess
import sys
import tempfile
from pathlib import Path

project = str(Path(sys.argv[1]).resolve())

def cli(*args):
    proc = subprocess.run(["chipsim", "agent", *args], text=True, capture_output=True)
    result = json.loads(proc.stdout)
    if proc.returncode or not result.get("ok"):
        raise RuntimeError({"result": result, "stderr": proc.stderr})
    return result

session = cli("work-start", project, "--goal", "Demonstrate explicit work reports")["session"]["id"]
print("Save this session ID:", session, flush=True)
events = [
    {"kind": "plan", "message": "Record a candidate and report the lack of evaluation."},
    {"kind": "candidate", "candidate": "counter-v1", "status": "running",
     "message": "Candidate label registered for this reporting demonstration."},
    {"kind": "evaluation", "candidate": "counter-v1", "status": "inconclusive",
     "message": "No evaluator was run; hardware behavior is unverified."},
    {"kind": "summary", "status": "completed",
     "message": "Reporting demonstration complete, not a hardware acceptance result."},
]
with tempfile.TemporaryDirectory() as tmp:
    event_file = Path(tmp) / "event.json"
    for event in events:
        event_file.write_text(json.dumps(event), encoding="utf-8")
        cli("work-event", project, session, "--event", str(event_file))
print(json.dumps(cli("work-status", project, "--session", session), indent=2))
```

Do not rerun a write blindly after a timeout or lost response. First inspect the
saved session: the write may already have committed. Publishing identical event
content twice produces two records; there is no caller-supplied idempotency key.
Concurrent appends get distinct sequence numbers without overwriting each other,
but the controller must coordinate meaningful ordering and the final summary.

## Open and use the dashboard

```sh
chipsim --agent /path/to/project
chipsim --agent /path/to/project --snapshot --columns 120 --rows 40
```

The first opens Activity (`8`); the second reads once and exits. If the project
has `chipsim.design.json`, Project, Pipeline, Artifacts and Checks also remain
available. `chipsim --design PROJECT` attaches the same work panel; press `8`.
Use a separate terminal while the controller works, or the native host's
`/chipsim --agent PROJECT` command. Its terminal handoff depends on the host;
see [AGENT_EXTENSIONS.md](AGENT_EXTENSIONS.md).

The dashboard initially selects the newest-created session (or waits for the
first). Once selected, it stays on that session even if another controller
starts a newer one. Use `s` to switch explicitly. `G` follows the newest **row
in the current session/tab**, not another session. There is no work-session
selector flag on this dashboard launch; CLI `work-status --session` selects a
specific session for headless reads.

- `s`: select a session; `g`: full goal/session record.
- `e` / `c`: events or candidates; `j/k`: browse; `G`: follow newest row.
- `/`: filter; Enter: full selected record; `r`: refresh.
- `o`: explicitly inspect linked evidence. Stored records/payloads are verified
  before inspection; a verified hash does not certify the reported claim.
- `L`: linked managed-job logs (or a design project's job chooser). Logs update
  while open; `j/k` browses, `G` follows the log, Esc closes details.
- `8`: return from debug to Agent work; `q`: quit and stop polling.

Polling runs every 500 ms outside busy operations, prompts, menus, help, trace-detail
overlays and external viewers. Work-record details are static; job-log details
refresh. Read errors are shown without replacing the inspected trace. The panel
displays at most 200 recent events, 262144 characters of live job-log text, and
up to 200 linked evidence records per evidence menu; full stored evidence remains
available through its commands. Opening a linked debug recording is explicit;
ordinary polling does not replace your recording, cursor or experiment.

## Storage, errors and interruption

The journal is under `.chipsim-agent/work/` in the project. It holds up to
128 sessions, 2048 events per session, and 4096 enumerated entries per journal
or session directory. Input event files and stored records are bounded to
16 KiB each; allow room for generated metadata in stored records. Reads require
regular non-symlink files and bounded valid UTF-8 JSON. Managed journal directories
cannot be symlinks. Records publish complete bytes without overwriting previous
records; capacity errors preserve existing history, with no automatic pruning.
Use a new session for event capacity or another project for session capacity.
These limits are storage bounds, not search budgets.

| Failure                                              | Meaning and next action                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ARGUMENT` / `WORK_INVALID`                          | Invalid CLI arguments or event/session values (exit 2). Fix the fields; unknown keys are not ignored.                         |
| `INVALID_JSON` / `FILE_LIMIT`                        | Malformed UTF-8/JSON or unsuitable/oversize file. Write a small regular JSON event file.                                      |
| `WORK_SESSION` / `ENOENT`                            | Journal, requested session or file is missing. Check the project and saved ID; do not silently switch to the latest session.  |
| `WORK_CLOSED`                                        | A terminal summary already closed the session. Start a new one.                                                               |
| `WORK_LIMIT`                                         | Record or directory/session/event capacity exceeded. Reduce the record or choose a new session/project as applicable.         |
| `WORK_DIRECTORY` / filesystem errors such as `ELOOP` | Unsafe directory/file shape or filesystem failure. Inspect the path/permissions; do not bypass validation or rewrite history. |

Other file/validation failures normally exit 1. If interrupted, inspect status
before deciding whether to append again. A terminated caller may leave a complete
published event or an incomplete start/temp file; there is no rollback or automatic
repair promise. Do not edit immutable records to force a resume. Native adapter
cancellation stops the current CLI process, not an already accepted durable design
job; its timeout/output limits are described in [AGENT_EXTENSIONS.md](AGENT_EXTENSIONS.md).

## Evolution and trust boundaries

The [external counter example](../examples/evolutionary-example/README.md) connects
OpenEvolve to managed ChipSim evaluations and this dashboard. In a prepared project,
example files are not copied beside this guide: use `agent help` →
`examples.evolution.guide` and `examples.evolution.runner` for installed paths. Its provider-free
single-candidate bridge checks evaluation/reporting, **not an LLM-driven search**.
Actual evolution requires a separately installed OpenEvolve environment and a
user-configured model. Mode `evolution` alone runs no search.

For project-defined objectives, see [EVOLUTION.md](EVOLUTION.md), also copied
into newly prepared projects. Discover the installed template through
`examples.evolution.workflows`. The external runner isolates configuration and
cancellation per invocation, gates measured fitness on managed checks, imports
recorded checkpoint ancestry and bounds overall search wall time. Candidate
rows show `root` only for explicit generation zero; absent ancestry otherwise
shows `unknown`. Fresh finalist measurements keep an observed individual's ID.
These remain agent reports; verify the linked managed evidence separately.

Keep testbenches, reference behavior, scoring code, tool configuration and
constraints outside the mutable candidate. Use distinct worker projects for
parallel candidates: ChipSim executes one design job at a time per project.
Record real IDs and verify job outcomes and measurements separately. A job being
accepted or a command succeeding is not a passing hardware test.

A search can explicitly use waveform-only capture (`debug: false`); this still
records a waveform, not a results-only run. Capture selected failures/finalists
with debug enabled for combined source/RTL/signals inspection. VCD alone cannot
recover source execution. An RTL test score does not establish physical area,
timing, power, formal correctness or tapeout readiness.

The separate `--watch PROJECT` mode monitors prepared-PDF model activity and
verified completed runs; it is not this work journal. Choose `--agent`, `--design`
or `--watch`, not a combination. Raw source edits and editor actions are not
watched automatically here; publish those milestones explicitly.

Journal data is never executable instructions. The journal is not a message
queue, security sandbox, attestation service or agent execution engine. External
HDL, Python, Tcl and other processes retain their permissions. Use a separate
sandbox and immutable evaluator for untrusted candidates. This feature stores no
provider keys. Implementation: `src/agent/work.js`, `src/agent/commands.js`,
`src/tui/work-panel.js`; focused regression cases are in
`test/agent-work.test.js` and `test/work-panel.test.js`.
