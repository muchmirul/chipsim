# Text-first engineering and MCP

ChipSim keeps HDL, control programs, tests and constraints as project text. Its
terminal and headless tools inspect captured execution and netlists. There is no
browser UI and no second hardware language required. External decision systems
(such as Notion) remain authoritative for requirements and architecture decisions.
Optional `engineering` metadata in `chipsim.design.json` links requirement IDs/HTTPS
URLs, candidate labels, `hardware`, `program`, `tests`, `constraints` path arrays,
and `capabilityContracts` paths. These labels do not establish verification.

## Install and connect

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
`chipsim://guide/connections`, `chipsim://guide/workbench` and
`chipsim://schema/tools` expose connection guidance, the workflow and
schemas. All current agent guides are also listed under `chipsim://docs/NAME.md`,
from the same inventory as installed help and prepared-project copies.
Resource discovery also lists the detailed design/HDL/debug/physical
guides and all ten programmable starter files (including README) under
`chipsim://examples/programmable/FILE`. Read those resources to bootstrap a
project entirely through MCP; recipe details use
`chipsim://guide/recipes?topic=rtl`. Project file/evidence resources support `candidate`, `offset`, `limit`.

## Agent loop

1. Discover `chipsim_project`, list/search/read files. Build `chipsim.design.json`
   and `chipsim.lock.json` using file tools if absent; `design guide` documents
   adapters. Create an isolated candidate before changing several files.
2. Use `chipsim_file_write` with the SHA-256 from a read. `expectedHash: null`
   means create only. Conflicts return `EDIT_CONFLICT`; read again before retrying.
   Writes atomically replace one file. Invalid drafts remain available. Candidate
   copies have their own jobs/evidence; pass their ID on every relevant call.
3. Validate a target, capture a plan, then start it with a unique `requestId`.
   A repeated request ID with the same target/options returns the same job even
   after reconnect and source edits, including missing or invalid design/lock
   drafts. Only new request IDs validate the current manifests. Different
   parameters still return `REQUEST_CONFLICT` while drafts are invalid.
   Use a new ID for a new run; `job_retry` reuses the original snapshot explicitly.
4. Poll status and byte-cursor logs. Accepted, executing, process completion,
   simulation, capture and target readiness are separate facts. Bounded waiting or
   disconnecting never cancels a job. `job_cancel` explicitly stops owned processes.
5. Inspect actual checks and verified artifacts, including failures, partial
   captures and unsupported/inconclusive results. Artifact IDs link source,
   hierarchy, connections, events, assertions, trace values and reports.
6. Repair text, rerun, compare and export verified run evidence. Keep independent
   tests and declared constraints fixed. A failure is evidence, not permission to
   weaken acceptance criteria. Export includes captured sources/configuration,
   tool/dependency identities and native outputs; install those tools to reproduce.

Files are UTF-8, at most 1 MiB, with 32,768-code-point response pages; text offsets count
Unicode code points. Search is literal, returning lines, hashes and skipped-file
counts. Lists/graphs/events use offset pagination (maximum 200 items). Responses
are bounded to 512 KiB. Symlinks, traversal and internal store/dependency edits are
rejected. Content hashes and cooperating-client locks prevent lost updates; an
external editor must coordinate with an in-progress write. If a process dies
while holding a mutation lock, `PROJECT_BUSY` reports its owner and path. Stop
clients and remove that stale lock before retrying; ChipSim never silently steals
it. Candidate edits are isolated files, not an atomic multi-file edit of the
original root. Select a candidate directory for continued development.

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
