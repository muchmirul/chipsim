# Text-first engineering and MCP

ChipSim keeps HDL, control programs, tests and constraints as project text. Its
terminal and headless tools inspect captured execution and netlists. There is no
browser UI and no second hardware language required. External decision systems
(such as Notion) remain authoritative for requirements and architecture decisions.
Optional `engineering` metadata in `chipsim.design.json` links requirement IDs/HTTPS
URLs, candidate labels, `hardware`, `program`, `tests`, `constraints` path arrays,
and `capabilityContracts` paths. These labels do not establish verification.

## Install and connect

Open `chipsim_project({})` first. Confirm the returned `root` before editing or starting a job. Check `diagnostic` when targets are missing or the manifest is an invalid draft. For one-file scoring read `chipsim://guide/evolution`. For persistent search and goal tracking, use the separately registered Pi Durable connection when requested.

### Check your connection's version

This guide describes ChipSim `0.3.0` with **40 MCP tools** and
`toolInventorySha256` `c60f0c84932a2ad70116c61df48a773308e06dc1d2400b86199e50ddaae596f5`.
Compare both `serverVersion` and `toolInventorySha256` in the `chipsim_project`
result. Source checkouts can change their tools within the same package version.
A running stdio server keeps the tool definitions it loaded at startup, while
a guide read can pick up newer files from disk.

If either value differs, reconnect the ChipSim MCP session so the client starts
a fresh server from the intended installation. Call `chipsim_project` again
and refresh discovery with `tools/list`. On a tools-only host, read
`chipsim://schema/tools` through `chipsim_resource_read` for the server's
current schemas. Confirm the same project root and resume jobs with their
existing request IDs or job IDs. If the client manages the connection, ask it
to reload the MCP session before using any newly advertised operation.

### Changes in this inventory

- Use `chipsim_environment_check` to inspect prerequisites before setup.
- Recover isolated work with `chipsim_candidate_list`, review it with
  `chipsim_candidate_diff`, and apply it with `chipsim_candidate_apply`.
- Transfer a verified evidence bundle to another project with
  `chipsim_evidence_import`. Use the original request ID to resume an upload.
- Use `candidateResource` from `chipsim_benchmark_prepare` to read the frozen
  baseline. The resource works through both resource APIs.
- Read `comparison` and `changes` in release discovery. A changed task graph
  blocks packaging. Policy-only changes re-evaluate verified evidence and may
  require a new package. Inspect the structured requirement, proof and timing
  fields before reporting readiness.

Start with [AGENT_CONNECTIONS.md](AGENT_CONNECTIONS.md) for CLI/native/MCP
selection and a client process descriptor. MCP exposes the workbench family
listed by tools/list, not all CLI families. Native tools use the packaged Node
CLI and require no MCP SDK.

The standalone CLI remains dependency-free. Install the optional, separately
locked official MCP SDK package from the ChipSim installation:

```sh
npm ci --prefix extensions/mcp
chipsim mcp --project /absolute/project/directory
```

Configure an MCP client to launch `chipsim` with arguments
`["mcp", "--project", "/absolute/project/directory"]`. Standard output is reserved
for the SDK's stdio protocol. Diagnostic errors use stderr. Each server is bound
to one explicit local directory; separate server processes isolate projects.
The root may initially be empty. This is a local trusted development service:
authored task commands execute with the user's permissions. Root-bound file tools
are not a sandbox for HDL tools or arbitrary declared task commands.

The official SDK negotiates the supported protocol version. No HTTP listener,
model provider, telemetry or agent-client configuration is installed. The MCP
transport uses the same bounded JSON schemas and services as:

```sh
chipsim workbench tools
chipsim workbench project --project .
chipsim workbench file_read --project . --input '{"path":"engine.sv"}'
```

For larger CLI arguments, `--input -` reads UTF-8 JSON from stdin, bounded to
8 MiB before normal schema/file limits. Native workbench tools use this route
automatically so valid 1 MiB file writes are not limited by argv size.

Native Pi/prime-agent extensions expose `chipsim_workbench_TOOL` with the same
schemas plus an explicit `project`; `chipsim_command` also accepts this family.
`chipsim://guide/connections` covers setup, `chipsim://guide/workbench` is this guide and `chipsim://schema/tools` describes the shared schemas with unprefixed workbench names. MCP `tools/list` gives the actual `chipsim_` tool names and schemas. Additional agent guides are listed under `chipsim://docs/NAME.md`,
from the same inventory as installed help and prepared-project copies.
Resource discovery also lists the detailed design/HDL/debug/physical
guides and all ten programmable starter files (including README) under
`chipsim://examples/programmable/FILE`. Read those resources to bootstrap a
project entirely through MCP; recipe details use
`chipsim://guide/recipes?topic=rtl`. Project file/evidence resources support `candidate`, `offset`, `limit`.

Hosts that expose tools without resource APIs can call
`chipsim_resource_read({uri: "chipsim://guide/connections"})`, then read
`chipsim://guide/workbench`. It returns `{uri, mimeType, text}` in the normal
workbench result envelope and uses the same resource allowlist and bounds.
Put candidate and paging parameters in project resource URIs. Native stage artifact URIs may also carry `benchmarkJob`. Read `candidateResource` when benchmark preparation returns it. Resource reads are scoped to this server.

## Find the right tool

Use the `chipsim_` prefixes for the operations in this table. The live inventory determines what's available, including `environment_check`, `candidate_list`, `candidate_diff`, `candidate_apply` and `evidence_import`. Check `tools/list` when reconnecting to a different installation.

| Need | Operations |
| --- | --- |
| Inspect project and tool prerequisites | `project`, `environment_check`, `workflow_status`, `resource_read` |
| Find, read and edit project text | `file_list`, `file_read`, `file_search`, `file_write`, `revision` |
| Work in a candidate and apply a reviewed change | `candidate_create`, `candidate_list`, `candidate_diff`, `candidate_apply` |
| Plan and run a design target | `validate`, `plan`, `job_start`, `job_status`, `job_logs`, `job_cancel`, `job_retry`, `checks` |
| Run one frozen benchmark measurement | `benchmark_prepare`, `benchmark_start`, `benchmark_result` |
| Inspect or transfer evidence | `artifacts`, `artifact_read`, `evidence`, `compare`, `export`, `evidence_import` |
| Inspect captured hardware, waveforms or source | `hardware`, `trace`, `source`, `differences`, `snapshot` |
| Prepare or deliver a pinned manufacturing project | `manufacturing_profiles`, `environment_setup`, `project_bootstrap`, `release_status`, `release_package` |

Read successful results from `structuredContent` where the client exposes it. Some tools-only clients return the decoded object directly. Other clients expose the equivalent JSON text content. Read `ok` and then `result` or `error.code` and `error.message`. MCP reports `isError` when `ok` is false. For `EDIT_CONFLICT`, reread and reconcile the edit. For `REQUEST_CONFLICT`, distinguish recovery of the existing action from a genuinely new request.

For `benchmark_result`, `BENCHMARK_PENDING` means the original job is still running; poll it. A `CANDIDATE_HASH_MISMATCH` on `benchmark_start` will not resolve by retrying. A failed benchmark job can still have a verified diagnostic report. Read the returned `artifact` without `benchmarkJob` for the full outer report; use `evidence.benchmarkJob` with a native stage artifact from `formal.diagnostics`. Do not treat diagnostics (`measured: false`, `score: null`) as a scored design. See [EVOLUTION.md](EVOLUTION.md#score-a-candidate-over-mcp).

## Agent loop

1. Discover `chipsim_project`, list/search/read files. Build `chipsim.design.json`
   and `chipsim.lock.json` using file tools if absent; `design guide` documents
   adapters. Create an isolated candidate before changing several files.
2. Use `chipsim_file_write` with the SHA-256 from a read. `expectedHash: null`
   means create only. Conflicts return `EDIT_CONFLICT`; read again before retrying.
   Writes atomically replace one file. Invalid drafts remain available. Candidate
   copies have their own jobs/evidence; pass their ID on every relevant call.
3. Validate a target and use `plan` to inspect captured inputs and tool identities when needed. The plan probes configured tools. Start the target with a unique `requestId`.
   A repeated request ID with the same target/options returns the same job even
   after reconnect and source edits, including missing or invalid design/lock
   drafts. Only new request IDs validate the current manifests. Different
   parameters still return `REQUEST_CONFLICT` while drafts are invalid.
   Use a new ID for a new run; `job_retry` reuses the original snapshot explicitly.
4. Poll status and byte-cursor logs. Call `job_status` with exactly one of `job` or `requestId`. Pass the same `candidate` if the job was created in a candidate. A request lookup that returns `state: "unknown"` has no recorded binding in this scope. Recover a lost submission by replaying the same arguments and ID. Pass the returned log cursor as the next `offset`. Accepted, executing, process completion,
   simulation, capture and target readiness are separate facts. Bounded waiting or
   disconnecting never cancels a job. `job_cancel` explicitly stops owned processes.
5. Inspect actual checks and verified artifacts, including failures, partial
   captures and unsupported/inconclusive results. Artifact IDs link source,
   hierarchy, connections, events, assertions, trace values and reports.
6. Repair text, rerun, compare and export verified run evidence. Keep independent
   tests and declared constraints fixed. A failure is evidence, not permission to
   weaken acceptance criteria. Export includes captured sources/configuration,
   tool/dependency identities and native outputs; install those tools to reproduce.

For a selected run, read `checks.ready` as a verdict on that target, not on the whole project. `requirementCoverage` summarizes the declarations and evidence policy captured **for that run**: `covered` and `unverified` list requirement IDs. A declared ID needs applicable evidence rules and verified passing evidence for each; a waiver is not proof. For example, `ready: true` with `requirementCoverage.status: "unverified"` means the target passed but no declared requirement was demonstrated. `not-declared` is not a verification pass, and `unavailable` means no usable captured run. Inspect `requirementResults` and `comparison` separately when evaluating current policy.

For example, use these arguments for an explicitly authorized run when `project` lists a target named `simulation`. Replace the example request ID with a unique value for this run. If working in an isolated candidate, include the same `candidate` ID from inspection through evidence retrieval.

| MCP tool | Arguments and value to retain |
| --- | --- |
| `chipsim_environment_check` (when listed) | `{"target":"simulation"}` to inspect prerequisites. |
| `chipsim_validate` | `{"target":"simulation"}` to check the manifest and inputs. |
| `chipsim_job_start` | `{"target":"simulation","requestId":"run-counter-01"}`. Save the returned job `id`. |
| `chipsim_job_status` | `{"requestId":"run-counter-01","waitMs":1000}` or `{"job":"JOB_UUID"}`. Save the returned `run` when published. |
| `chipsim_checks` | `{"target":"simulation","run":"RUN_SHA256"}`. Check `ready`, the source comparison and each required verdict. |
| `chipsim_artifacts` | `{"run":"RUN_SHA256"}`. Follow a selected artifact ID through `chipsim_evidence` or `chipsim_artifact_read`. |

Files are UTF-8, at most 1 MiB, with 32,768-code-point response pages; text offsets count
Unicode code points. Search is literal, returning lines, hashes and skipped-file
counts. Lists/graphs/events use offset pagination (maximum 200 items). Responses
are bounded to 512 KiB. Symlinks, traversal and internal store/dependency edits are
rejected. Content hashes and cooperating-client locks prevent lost updates; an
external editor must coordinate with an in-progress write. If a process dies
while holding a mutation lock, `PROJECT_BUSY` reports its owner and path. Confirm the recorded owner is dead and all cooperating clients have stopped before explicitly removing a stale lock. Candidate edits are isolated files, not an atomic multi-file edit of the
original root. Select a candidate directory for continued development.

Benchmark evaluation uses the same managed jobs and supports recovery by request ID. See [standalone benchmarking and durable search](EVOLUTION.md#standalone-benchmarking-and-durable-search) for capture, measurement and report inspection.

To read a native report or waveform through the same MCP connection, pass the returned `evidence.benchmarkJob` to `chipsim_artifacts` with the stage run ID. Pass that same `benchmarkJob` to `chipsim_artifact_read` with the selected artifact ID. The server verifies the outer job and its captured stage evidence before opening the stage workspace.

## Linked inspection

`chipsim_hardware` returns real elaborated RTL or Yosys module definitions, not
inferred circuitry from arbitrary source text. Objects and edges keep artifact-
local IDs. Queries include child objects, literal signal search, connections,
fanin and fanout. Yosys cells/ports/buses retain their native type/direction and
source attributes; a module definition is not an elaborated instance hierarchy.
Open Yosys JSON through `chipsim --netlist YOSYS.json` or a verified netlist
artifact in the project panel. Static inspection keeps the prior experiment
hidden and unchanged: simulation/view/edit/export shortcuts cannot operate it,
and the HDL menu does not offer comparison of that hidden trace.
Use Tab for project views, `m` to select a model, or `H`/`d` to load other data.
Waveforms only expose recorded signals. None of these views invent next-state
logic or classify every variable as storage. Existing connected-circuit contracts
remain the explicit supported route for hypothetical state evaluation.

`chipsim_trace` retains exact time, scheduler order, X/Z and capture status. Static
writers and observed process events are distinct. `chipsim_source` reads captured
source bytes and reports current-file freshness where a path can be resolved.
For managed HDL artifacts, `currentPath` is relative to the design root and comes
from the captured task's HDL manifest directory and consumed input inventory.
Nested projects therefore check their actual source, even if the live manifest
is now an invalid draft. Missing, generated or unmapped inputs retain unknown
freshness; a same-named root file is not substituted.
Source changes never replace a recording or move its cursor. `checks` reports
stale target evidence; validate/run/open through the project panel to refresh.

`chipsim_snapshot` returns the same terminal rendering as:

```sh
chipsim --hdl-debug RUN/debug.json --view schematic --at-event 3
```

Tab reaches Schematic; j/k selects objects, Enter opens linked details, F2 changes
panes, J/N changes the shared event cursor. Graph truncation is explicit. Both
80×24 and 120×40 layouts are supported. Physical layout artifacts remain native
files for KLayout; the terminal diagram makes no physical placement claim.

## Programmable fixture

`examples/workbench/programmable` is an original four-word hardware fixture with
add and XOR control programs. Its finite `program-image` adapter reads explicit
`chipsim-program-contract` and `chipsim-program` v1 JSON. It validates opcode and
operand widths, memory depth, consecutive issue cycles, instruction duration and
finite resource occupancy. It emits `out/program.hex` and typed diagnostics in
`out/program-validation.json`; it never rewrites hardware, inserts waits or
reorders instructions. Resource reservation work is bounded to one million.
These contract checks do not prove the hardware obeys the contract.

```sh
chipsim design run --project examples/workbench/programmable --target simulation --wait
chipsim design run --project examples/workbench/programmable --target synthesis --wait
```

The default simulation uses optional native debug tools. A failed program
validation gates the downstream simulator. Replace `program.json` with the second
program to exercise the same hardware with a different control image. Real HDL
assertions remain an independent acceptance condition. A Yosys synthesis target
produces inspectable netlist JSON; generic cell counts are not physical PPA.
Run comparisons calculate numeric deltas only for matching explicit, nonempty
reported contexts, scopes, metric fields and units. Missing/null/empty contexts
leave `comparable: false` and `delta: null`, while retaining both observed values.

## Physical flow and verification

See [Tiny Tapeout integration](TINYTAPEOUT.md) for the pinned native physical flow,
precheck and evidence boundaries. No challenge-specific private HDL or decision
documents are copied into this repository, and no template size is silently
changed. Measured quantities retain their names, units and scope; there is no
invented competition score or automatically selected architecture.

Implementation: `src/workbench/`, `extensions/mcp/`, shared `src/design/` services,
and `src/tui/schematic.js`. `npm run test:mcp` uses the official SDK client to
create/edit/run/inspect/repair/reproduce a design solely through MCP, including
reconnection, concurrent clients, cancellation, synthesis and two control images.
`test/workbench.test.js` covers CAS conflicts, root bounds, source freshness,
partial/corrupt evidence, graph identity and both terminal sizes.

## Manufacturing development and delivery

[Manufacturing](MANUFACTURING.md) describes `manufacturing_profiles`, explicit
managed `environment_setup`, `project_bootstrap`, `release_status` and
`release_package`. Setup works before design manifests exist and uses the same
job lifecycle. `artifact_read` returns base64 byte chunks, chunk SHA-256, full
payload SHA-256 and the next byte offset (maximum 65,536 bytes per chunk).
Only verified artifact IDs can be read; it does not open arbitrary host paths.
Ordinary evidence export retains its existing meaning. A manufacturing package
requires the selected profile's minimum checks and complete native files.

## Guided workflow and resumable client

`workflow_status` inspects persisted jobs, the bound project/candidate, release
blockers and suggested explicit actions. It does not start jobs or repair locks.
YAML metadata requiring a configured parser is deferred to an explicit
`release_status` call; workflow discovery does not execute that parser.
`project` reports `serverVersion` and `toolInventorySha256` to diagnose a stale
connection. Existing clients retain their existing fields and tools.

Create an empty project directory before preparation; bootstrap preserves existing
files. Install `extensions/mcp` dependencies and run `node extensions/mcp/workflow.mjs
--help` for the official SDK helper. Use `prepare --project DIR --profile ID
--metadata FILE --state JOURNAL`, `run --project DIR --target TARGET --state
JOURNAL`, `deliver --project DIR --run RUN --out DIR --state JOURNAL`, or
`resume --state JOURNAL`. Each operation uses a new journal outside design
inputs. Preparation explicitly installs the pinned dependencies. Journals retain
request identities before submission; replay never silently starts a replacement
run. Downloads verify chunk and whole-file hashes, including existing partial
bytes. Destination conflicts stop the operation. Ctrl-C requests cancellation;
unexpected disconnection leaves jobs durable. Failed jobs require explicit retry.
New helper journals capture the selected manufacturing cache and replay it even
if the client's current environment changes. Journals also retain per-generation
log cursors, bounded log tails and verified download byte progress. Root device
and inode identities reject a project directory replaced at the same path.

`project_bootstrap` accepts an optional `requestId`. A durable receipt records the
intended file inventory before installation. Repeating the same request checks
all existing owned files and installs missing whole top-level destinations after
an interrupted bootstrap. Edited files, extra captured files, altered templates or changed
request parameters stop reconciliation. Calls without a request ID retain the
create-only contract. The official helper supplies a persistent bootstrap request
ID and therefore reconciles a lost server response on resume. A server killed while
owning the project mutation lock leaves that lock intact. Confirm its reported
owner is dead and all project clients are stopped before explicitly removing it;
resume then verifies the receipt. The helper never steals that lock.
Legacy journals that lack that identity still require explicit inspection. A dead helper's exclusive journal lock must be removed only after
confirming no client owns it; locks are never silently stolen.

Native failures retain bounded current-task log excerpts, source locations when
reported, exit status and report diagnostics. An unfinished xUnit report does
not hide a simulator assertion or become a passing test. Unknown test identity
remains null. Historical evidence lacking new diagnostic fields remains readable.

Workflow stages distinguish profile selection, bootstrap, bootstrap recovery,
active jobs, failures, implementation/verification, release, packaging and ready
delivery. Suggested calls retain explicit request IDs and metadata requirements;
inspection never executes configured tools or mutates orphan job state.

Structured diagnostics use an explicit recorded failing case when available,
list multiple failed cases, and leave unknown attribution null. Both native
process failures and zero-exit reports containing failures remain nonpassing.

## Readiness and handoff between clients

`checks` and `release_status` compare the captured target's full execution graph with the current graph. Inspect `comparison` for captured and current graph and policy digests and `changes` for the affected tasks. An added independent task requires a passing run of the changed target. A change confined to the target policy can reuse captured checks that satisfy the new policy. A completed simulation-only project reaches the terminal `verified` stage.

Use `environment_check` before selecting a target or starting manufacturing setup. Its observer section describes locally installed debug capabilities. Supplying a target inspects its executable paths without running configured version commands. A profile cache reported present still needs the ordinary pinned setup verification.

Use `candidate_create` with a stable `requestId` to recover the same candidate after a lost reply. A candidate selector on creation identifies its parent. `candidate_list` accepts a request ID and pagination. `resource_read` inherits an explicit candidate for project URIs and reports a conflict if the URI names a different candidate. `benchmark_prepare` provides a read-only `candidateResource` and the SHA-256 of the captured baseline.

1. Read `candidate_diff` for the candidate's base revision, current revision and changed file digests. Page through all changes and read candidate file contents as needed.
2. Send `candidate_apply` with `candidate`, `expectedRevision` equal to the base, and `expectedCandidateRevision` equal to the reviewed revision. The destination is the candidate's original parent. A conflicting edit returns `EDIT_CONFLICT`. Accepted changes have a recovery receipt in the destination until its revision matches the selected candidate.
3. To deliver manufacturing evidence to a second project, read the package job's `evidence.zip` with `artifact_read` and pass each chunk's `offset` and base64 `data` to the receiving project's `evidence_import`. Use the same `requestId`, whole-file `sha256` and total `bytes` throughout. Omit data to query the next offset after a reconnect. Use `finish:true` on the final chunk. The receiver validates the ZIP and its complete evidence closure before publishing its root. Verify the returned ID with `evidence`.
