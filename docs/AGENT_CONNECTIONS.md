# Connect an agent to ChipSim

ChipSim is a local execution and evidence workbench for an external coding
agent. Choose a connection your host supports. All routes share project files,
managed jobs, checks and immutable artifacts; the terminal is the interactive
viewer. ChipSim does not supply an LLM, configure a provider or start agent turns.

| Connection                 | Entry point                                     | Use                                                                                              |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CLI subprocess             | `chipsim agent help`, `chipsim workbench tools` | Any agent with process access; all headless command families.                                    |
| Pi / prime-agent extension | `extensions/chipsim.ts`                         | Named tools, the general `chipsim_command`, snapshots and `/chipsim` terminal handoff.           |
| MCP client                 | `chipsim mcp --project /absolute/project`       | The shared workbench tool family over stdio, including file edits without host filesystem tools. |

## Two direct connections from any local MCP client

Register `chipsim mcp --project /absolute/project` for hardware and evidence tools. Register `pi-durable-mcp` separately if the user has configured the Pi Durable goal service. Both are standard local stdio descriptors. Use `command -v chipsim` and `pi-durable-mcp --print-command` for absolute paths. Each client discovers tools from the two registered servers.

For a single measurement, use ChipSim directly. For an explicitly requested persistent job, read Pi Durable's `helper_info({includeGuide: true})` and select regular or evolution for that job. When Pi Durable submits ChipSim work, its ChipSim registry entry must be bound to the same project as the job. A second client can use the Pi job ID for goal status and the linked ChipSim job ID for hardware evidence.

## Discover the actual installation

Use Node.js 22.13+. Install the CLI from a stable checkout or an offline npm
archive as described in [README](../README.md). No runtime npm package is needed
for CLI/native use. Do not install or register tools merely by reading this guide.

```sh
chipsim --help
chipsim agent help
chipsim workbench tools
chipsim design commands
```

`agent help` returns `connections`, absolute `documentation` paths and installed
`examples` paths. `connections` describes commands, native workbench tool names,
snapshot source fields and MCP setup; it does not probe availability or mutate
client settings. In an uninstalled checkout use
`node /absolute/chipsim/scripts/chipsim.mjs` in place of `chipsim`.
Arrays in `connections.cli` omit the executable; uppercase placeholders must be
replaced. Paths containing spaces stay one literal argument. Preserve stdout,
stderr and exit status separately.

An agent registered against one checkout may differ from `chipsim` on PATH.
Compare the discovered installation paths before diagnosing version drift.
Prepared PDF projects carry copied guides and programming context from their
preparation version. Current installed help is authoritative for current tooling;
`agent context` refreshes model context, not copied documentation.

The native extension below targets Pi and the TypeScript prime-agent 0.9.8
extension API. For Rust prime-agent 0.10, use the MCP setup below.

## Native Pi / prime-agent tools

Use the host's installer only when installation is requested:

```sh
pi install /absolute/path/to/chipsim
prime-agent package install /absolute/path/to/chipsim
```

Restart/reload through the host's supported mechanism. See
[AGENT_EXTENSIONS.md](AGENT_EXTENSIONS.md) for local/session registration,
removal, inspected host versions and terminal limitations.

Start with `chipsim_help`. `chipsim_workbench_TOOL` exposes each shared
workbench operation with an explicit `project`, for example:

```javascript
chipsim_workbench_project({ project: "/absolute/project" });
chipsim_workbench_file_read({
  project: "/absolute/project",
  path: "engine.sv",
});
chipsim_workbench_job_start({
  project: "/absolute/project",
  target: "simulation",
  requestId: "candidate-1",
});
chipsim_snapshot({ netlist: "/absolute/netlist.json", columns: 120, rows: 40 });
```

Calls use the current host call's cwd. Workbench tools use the packaged CLI's
Node subprocess boundary, including under compiled/Bun hosts; `CHIPSIM_NODE`
selects Node when necessary. Workbench arguments stream over bounded stdin JSON
so the 1 MiB file limit does not depend on operating-system argv limits. The
CLI equivalent is `workbench TOOL --project PROJECT --input -` with UTF-8 JSON
on stdin (8 MiB transport bound; normal tool/file bounds still apply).
Structured workbench failures remain
`details.ok: false` / `isError: true`; process startup, cancellation and protocol
failures throw. The general tool and older named tools retain their documented
exception contract. Native tools do not need the optional MCP SDK.

Use `chipsim_command` for the other CLI families and text help, with literal
`args`. It accepts `workbench`, `agent`, `hdl`, `circuit`, `table`, `design`, `job`,
`artifact`, `checks`, `benchmark` and the legacy `evolution` family. Launch the persistent MCP server through an
MCP client, not through this one-response command tool. `/chipsim` hands off a
supported terminal; prime-agent daemon hosts return a separate-terminal command.

## MCP connection

Install the optional SDK **inside the same ChipSim installation** the client
will launch. `agent help` → `connections.mcp.dependencyInstall` gives the absolute
prefix; the relative form below is run from that installation root:

```sh
npm ci --prefix extensions/mcp
chipsim mcp --project /absolute/existing/project
```

Supply this process descriptor in your client's supported MCP configuration:

```json
{
  "command": "/absolute/path/to/chipsim",
  "args": ["mcp", "--project", "/absolute/existing/project"]
}
```

The surrounding configuration key depends on the client. An uninstalled checkout
can instead launch `node` with the CLI script path followed by those arguments.
Each server is bound to one existing directory, which may be empty. Its stdout
is reserved for MCP stdio messages; setup errors go to stderr. No HTTP listener
or shared selected-project state is created. Separate servers isolate roots.

For ordinary Pi, Codex CLI and Rust prime-agent, register the stdio server with absolute
paths (replace the three paths for your installation):

```sh
pi mcp add chipsim -- /absolute/node /absolute/chipsim/scripts/chipsim.mjs mcp --project /absolute/project
codex mcp add chipsim -- /absolute/node /absolute/chipsim/scripts/chipsim.mjs mcp --project /absolute/project
prime-agent mcp add chipsim -- /absolute/node /absolute/chipsim/scripts/chipsim.mjs mcp --project /absolute/project
codex mcp list
pi mcp list
prime-agent mcp get chipsim
```

The project directory must exist. These commands change each client's user MCP
settings; use a different connection name for a different project. Restart the
client/session after registration. No model provider configuration is needed.
Codex can inspect its connections with `/mcp`. In prime-agent's Python tool:

```python
connections = await mcp.list_connections()
tools = await mcp.list_tools("chipsim")
guide = await mcp.call_tool("chipsim", "chipsim_resource_read", {
    "uri": "chipsim://guide/connections"
})
project = await mcp.call_tool("chipsim", "chipsim_project", {})
```

Prime-agent's tools-only MCP API reads guides through `chipsim_resource_read`.
This returns the same allowlisted resource content as `resources/read`, inside
`{format, version, ok, result: {uri, mimeType, text}}`; inspect `ok` and parse
`text` as JSON only when its MIME type is JSON. Codex can use this tool too.

### Verified prime-agent 0.10 Python client

The recorded Rust prime-agent **0.10.0** Python client acceptance covered the 32-tool inventory at its validation date. It exercised tools-only guide access, structured results, CAS errors, isolated projects, managed execution, reload and request replay, and verified binary retrieval. The attached result identifies that exact inventory. For the running version, read `chipsim_project` and refresh `tools/list`. [Host compatibility acceptance](prime-agent-mcp-acceptance.json)
This verifies the installed `rlm.mcp` client with isolated host-config replies;
it does not start a model turn or claim an end-to-end Rust daemon/UI test.

Prime-agent raises `rlm.mcp_base.McpToolError` when ChipSim returns `isError`.
Successful calls return the structured envelope directly; do not apply
`json.loads` to it. Catch the exception to inspect an `EDIT_CONFLICT` or other
failure, reread the source and decide whether a new action is appropriate.
To refresh this Python client's server connection and live schema inventory:

```python
await mcp.reload("chipsim")
tools = await mcp.list_tools("chipsim")
```

Reloading the connection leaves accepted ChipSim jobs durable. It is distinct
from `chipsim_job_cancel`, which explicitly stops an owned job.

Prime-agent's stdio client forwards only a small safe environment by default.
For a custom manufacturing cache, configure an explicit environment reference
(the right-hand side of `--env` is a variable name, not a literal path):

```sh
export CHIPSIM_MANUFACTURING_CACHE=/absolute/cache
prime-agent mcp add chipsim-cache --env CHIPSIM_MANUFACTURING_CACHE=CHIPSIM_MANUFACTURING_CACHE -- /absolute/node /absolute/chipsim/scripts/chipsim.mjs mcp --project /absolute/project
```

Without this override ChipSim uses its ordinary per-user cache. The referenced
variable must be available to the prime-agent process. Add references similarly
for any other explicitly selected ChipSim environment settings. These registration
commands change user settings; the compatibility test does not run them.

From a source checkout, run the acceptance with the Python interpreter used by
prime-agent's kernel (with its MCP dependencies installed):

```sh
/path/to/prime-kernel/bin/python test/prime-mcp-acceptance.py --prime /absolute/prime-agent
```

`--runtime-src` supports installations with a different runtime location. Optional
`--registered-settings /path/to/settings.json` additionally probes the existing
`chipsim` descriptor and compares its tool schemas against the checkout. The
runner writes `acceptance.json` beside the temporary projects with the validation
time, runner checksum and job/run IDs. It leaves the registered project and
settings untouched.

Start with `chipsim_project` and `chipsim://guide/workbench`. Read `chipsim://guide/evolution` for benchmark scoring, `chipsim://guide/evolution-objectives` for weighted workflows, or `chipsim://guide/manufacturing` for physical preparation and release. List tools and resources. Tools are named `chipsim_TOOL`, installed agent guides are listed
under `chipsim://docs/NAME.md`, schemas under `chipsim://schema/tools`, project
status under `chipsim://project/status`, and programmable starter files under
`chipsim://examples/programmable/FILE`. Recipe discovery uses
`chipsim://guide/recipes?topic=programmable` or `topic=tinytapeout`.

Use the live `tools/list` workbench schema for exact arguments, including the `chipsim_benchmark_*` operations. The general `chipsim_command`, PDF commands and Activity journal writers belong to the CLI or native extension. MCP workbench calls use the bound project and take `candidate` when operating in an editable copy.
This is a trusted local development service: declared task commands execute with
the user's permissions; file-path checks do not sandbox arbitrary tool execution.

## Choose the right context and finish the loop

- For arbitrary RTL/design directories, use workbench `project` (works before a
  manifest exists), input recipes and `design status/plan` once configured.
- `agent context CHIP_OR_PREPARED_PROJECT` describes `.chip` behavioral model
  interfaces and source requirements. It is not arbitrary RTL discovery or a
  native CPU/firmware capability claim. See [PROGRAMMING.md](PROGRAMMING.md).
- For finite control images, use `design guide programmable`; discover
  `examples.programmable` from installed help. `program-image` is separate from
  `.chip` and from a native assembler/compiler.
- For physical work, choose the explicit flow: ORFS uses `design guide physical`;
  pinned Tiny Tapeout/LibreLane uses `design guide tinytapeout` and
  [TINYTAPEOUT.md](TINYTAPEOUT.md). External PDKs/tools are not installed implicitly.

Read files, create an isolated candidate if useful, validate/plan, start a job
with a stable `requestId`, poll status/log cursors, then inspect actual checks
and verified artifacts. Acceptance is not readiness. Replaying an accepted ID
survives invalid/missing manifest drafts; a new ID validates current inputs.
Disconnecting or ending a wait does not cancel a durable job; cancel explicitly.
Retain candidate IDs with every candidate call and use the correct evidence
store. See [WORKBENCH_MCP.md](WORKBENCH_MCP.md) for bounds and recovery.

Nested HDL source freshness uses the captured manifest directory and input
inventory (`currentPath`), with missing/unmapped origins unknown. Netlists show
static connectivity without simulated values; model/data selection explicitly
leaves static mode. Numeric metric deltas require matching explicit contexts,
scope and units. Keep these distinctions in reports and user handoffs.
