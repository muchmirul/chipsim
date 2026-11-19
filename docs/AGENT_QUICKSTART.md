# Start here: using ChipSim as a coding agent

Choose CLI, native Pi/prime-agent tools or MCP using
[AGENT_CONNECTIONS.md](AGENT_CONNECTIONS.md). `agent help` returns a current
`connections` inventory and installed paths. Native `chipsim_workbench_TOOL`
calls take `project`; MCP `chipsim_TOOL` calls use the server's bound root.
Use `workbench tools` / MCP tool discovery for schemas, and workbench `project`
for arbitrary RTL directories. `agent context` remains model/PDF-specific.

For guided digital manufacturing, call `workflow_status` on the bound project
and follow its explicit next actions. The official `extensions/mcp/workflow.mjs`
helper provides preparation, run, delivery and resume commands with durable
journals outside the project. See [manufacturing](MANUFACTURING.md) for the pinned
profile and [reliability](MCP_RELIABILITY.md) for acceptance coverage.

For an MCP-only chip-development loop, read [WORKBENCH_MCP.md](WORKBENCH_MCP.md): create/read/edit project text, fork candidates, validate targets, start durable jobs, inspect real failures, repair and export evidence. The original programmable fixture separates fixed hardware from two control images.

Read this guide together with the working project's `AGENTS.md`. Use the installed
`chipsim` command; in the checkout, `node scripts/chipsim.mjs` is equivalent.
`chipsim agent help` returns command contracts and absolute paths to installed
guides. Paths resolve from the command's working directory. Prepared projects
contain a documentation snapshot; `agent context` does not refresh copied docs.

Read [AGENT_CONTROL.md](AGENT_CONTROL.md) for the full operating procedure and
[LOCAL_REFERENCES.md](LOCAL_REFERENCES.md) for private source setup.

## Choose the workflow

| User's task                                                   | Start with                                                       | Read next                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Create/edit/run a project using MCP or native workbench tools | Workbench `project`, file tools and `job_start` with `requestId` | [AGENT_CONNECTIONS.md](AGENT_CONNECTIONS.md), [WORKBENCH_MCP.md](WORKBENCH_MCP.md) |
| Run finite control images on fixed hardware                   | `chipsim design guide programmable`                              | [WORKBENCH_MCP.md](WORKBENCH_MCP.md); installed `examples.programmable`            |
| Run the pinned Tiny Tapeout physical flow                     | `chipsim design guide tinytapeout`                               | [TINYTAPEOUT.md](TINYTAPEOUT.md)                                                   |
| Score or repair one RTL file against fixed tests              | `chipsim_benchmark_prepare` or `chipsim benchmark describe`      | [EVOLUTION.md](EVOLUTION.md)                                                       |
| Run a persistent scored search when explicitly requested      | Pi Durable's `helper_info({includeGuide: true})`                 | [Pi Durable search with ChipSim](EVOLUTION.md#run-a-persistent-pi-durable-search)   |
| Build hardware from an idea or partial files                  | `chipsim design guide`, then `chipsim design commands`           | [DESIGN_INPUTS.md](DESIGN_INPUTS.md), [DESIGN.md](DESIGN.md)                       |
| Understand or program a document-backed model                 | `chipsim agent context PROJECT --model MODEL_ID`                 | [PROGRAMMING.md](PROGRAMMING.md), [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md)           |
| Create an experiment from authored register/stimulus CSV      | `chipsim table help`                                             | [CSV_INPUTS.md](CSV_INPUTS.md)                                                     |
| Run an HDL testbench or inspect VCD                           | `chipsim hdl help`                                               | [HDL.md](HDL.md), [HDL_DEBUG.md](HDL_DEBUG.md)                                     |
| Track managed execution or a persistent goal                  | `chipsim_job_status` or Pi Durable's `job_status`                 | [WORKBENCH_MCP.md](WORKBENCH_MCP.md), [EVOLUTION.md](EVOLUTION.md)                   |

For complete connected wiring/state rules, use `chipsim circuit help` and
[AGENT_CIRCUITS.md](AGENT_CIRCUITS.md). `circuit` checks old-state simultaneous
updates and explicit connections. `benchmark` measures one candidate.
The [connected circuit contract](CONNECTED_CIRCUITS.md) states its supported
binary synchronous subset and native correspondence limits.

For fixed native benchmarks, use `chipsim benchmark evaluate --benchmark NAME`
or a `chipsim-evolution-benchmark` JSON definition. For weighted managed
Verilog/VHDL workflows, use `chipsim benchmark evaluate --workflow FILE` with
`chipsim-evolution-workflow` JSON. MCP accepts either definition path in
`chipsim_benchmark_prepare`. In both cases, ChipSim captures and measures the
hardware inputs. Pi Durable runs OpenEvolve when a persistent search is requested.
[Weighted workflows](EVOLUTION_OBJECTIVES.md)

For a complete memory-bearing RTL flow, `agent help` → `examples.rtlVerification`
and `design guide rtl` → `recipe.verificationExample` locate the ready/valid FIFO
starter. It includes scoped debug, fixed independent tests, synthesis, generated
netlist simulation, EQY induction and a reversible occupancy fault. Copy it to a
new project and follow its README; missing tools or unproven formal results block
the acceptance target. HDL job logs contain native assertion diagnostics;
failed job/task status also links the full diagnostic artifact.

Inspect existing work before creating prerequisites. Use only relevant stages.
A `.chip` program exercises declared model behavior; native firmware requires an
explicit compiler and execution backend. Document-backed work preserves original
PDF fingerprints and one-based page citations. RTL, CSV and ordinary design work
can proceed without a PDF. The TUI is the interactive frontend; text commands
support automation.

## A manual RTL improvement loop

The benchmark CLI requires Node.js 22.13+ and Python 3.10+ (`PYTHON` selects the Python
environment). Counter evaluation needs Icarus (`iverilog`, `vvp`); ALU also needs
Yosys; enabled equivalence needs EQY and its configured proof tools. Install tools
separately. Discovery and custom validation do not execute EDA tools.

Save complete JSON output. The work directory must exist; it does not need a PDF
project or a design manifest for bundled benchmarks.

```sh
mkdir -p ./work
chipsim benchmark describe --benchmark counter --format text
chipsim benchmark evaluate --benchmark counter --project ./work > before.json
chipsim benchmark report before.json --format text
# Create ./candidate.sv with the interface declared by describe.
chipsim benchmark evaluate --benchmark counter --candidate ./candidate.sv \
  --project ./work > after.json
chipsim benchmark compare before.json after.json --format text
chipsim benchmark reproduce after.json --project ./work
```

The default counter deliberately fails. Exit 1 can still provide a complete
failure report; inspect it before deciding the command crashed. Do not join an
expected failing baseline and its report command with shell `&&`. Evaluation
exit 0 means acceptance, exit 1 means failure/inconclusive/error, and interruption
exits 130. Default stdout is one `chipsim-evolution-result` version-1 envelope;
progress is stderr. Inspect `ok` and `result.status`, then `accepted`, `stages`,
`diagnostics`, `cases`, `metrics`, `formal` and evidence links. An error result
may contain only status/message. Use `--format text` for human inspection.

Read failed checks and independent expected values before editing. Change only
the candidate during a comparison/search. Keep tests, oracle, interface,
reference, synthesis recipe and scoring policy fixed. X/Z, missing tools,
timeouts and incomplete checks cannot establish correctness. Counter partial
fitness measures repair progress; ALU/custom optimization scores require every
required stage to pass. Report generic cell counts as a size proxy with units.

Custom definitions declare one editable `.v`/`.sv` file (64 KiB maximum), all
fixed inputs, ordered design stages, exact report producers, an objective and
optional formal/replay recipes. Validate with `chipsim benchmark validate
--benchmark ./benchmark.json`. The installed `EVOLUTION.md` path is returned by
`agent help`; the package's adjacent `examples/evolution/custom-counter` is a
runnable starter to copy into your project. See [EVOLUTION.md](EVOLUTION.md)
for complete definition and stage-report contracts.
For exact installed paths, use `agent help` → `examples.nativeEvolution`:
`customBenchmark` locates the starter definition, `aluCandidate` the shared-adder
fixture, and `runner` the compatibility entry point. These differ from
`examples.evolution`, which locates the multi-objective runner and teaching goals.

## Acceptance, comparison and reproduction

- Add `--formal` when equivalence is required. `formal.required: true` in a
  definition always requires it. Missing tools, timeout or an unproven result
  block acceptance and positive fitness. Report scope and initialization
  assumptions. EQY `FAIL` alone is not a demonstrated counterexample.
- `compare` can exit successfully with `comparable: false`; inspect `reasons`
  and `winner`. Ranking needs matching verified inputs, settings, tools and
  evaluator/runtime. Keep trusted setup fixed or start a new baseline/session.
- Full `reproduce REPORT --project WORK` restores captured inputs in a fresh
  evaluation. `--case N` replays a saved failure, preserving counter initialization
  history or the failing ALU RTL/netlist stage. A reproduced failure does not
  establish full acceptance. Custom focused replay needs a declared recipe.
- Retain the managed artifact store and evidence links. Saved JSON alone is
  not a portable evidence bundle. Reproduction needs captured dependencies,
  executable identities and evaluator/runtime; the original source project
  may be removed. Never alter snapshots or sealed evidence to make a run pass.

## Search, progress and recovery

For an MCP measurement, read `chipsim://guide/evolution`. Use
`chipsim_benchmark_prepare` to capture the context and baseline, start with
`chipsim_benchmark_start` and a stable request ID, then get status and
`chipsim_benchmark_result`. Keep the same context when comparing candidates.
Recover a lost reply using the original request ID. A status wait ending leaves
the job running. Use `chipsim_job_cancel` to stop an owned job.

For a persistent scored search, explicitly select Pi Durable on its own MCP
connection. Read `helper_info({includeGuide: true})` and pick the ChipSim example.
The Pi model proposes one file at a time, ChipSim scores it, and OpenEvolve
chooses a measured parent for the next proposal. Pi Durable stores the
baseline, candidate lineage and the fresh finalist result in the durable job.
Use its `job_status` for progress and the linked ChipSim IDs for native evidence.
For a regular persistent task, use Pi Durable with the mode fields omitted.

Standalone `chipsim benchmark` waits for its evaluation and retains evidence
without an Activity journal. Allow the default 60-second counter or 300-second
ALU budget plus cleanup. `--timeout 1..300` changes the evaluation budget.
Ctrl-C requests cancellation and retains partial evidence. The two old search
launchers and manual journal writers emit deprecation warnings this release.
For compatibility and existing Activity history see [AGENT_WORK.md](AGENT_WORK.md).

In the native Pi/prime-agent extension, use `chipsim_command` with literal arguments
for the standalone CLI:

```json
{
  "args": ["benchmark", "evaluate", "--benchmark", "alu8", "--project", "./work"],
  "timeoutMs": 360000
}
```

See [AGENT_EXTENSIONS.md](AGENT_EXTENSIONS.md) for the native route.

## What to return to the user

Report the candidate/benchmark, actual commands/settings, acceptance and failed
or incomplete checks, before/after measurements with units and comparability,
formal scope/assumptions, and job/run/artifact links. Include the saved report,
reproduction command and remaining limitations. Distinguish reported metrics,
verified evidence bytes, sampled behavior and proven scope. Never fabricate
results or weaken expected behavior to improve a score.
