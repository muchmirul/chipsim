# Start here: using ChipSim as a coding agent

Read this guide together with the working project's `AGENTS.md`. Use the installed
`chipsim` command; in the checkout, `node scripts/chipsim.mjs` is equivalent.
`chipsim agent help` returns command contracts and absolute paths to installed
guides. Paths resolve from the command's working directory. Prepared projects
contain a documentation snapshot; `agent context` does not refresh copied docs.

Read [AGENT_CONTROL.md](AGENT_CONTROL.md) for the full operating procedure and
[LOCAL_REFERENCES.md](LOCAL_REFERENCES.md) for private source setup.

## Choose the workflow

| User's task                                              | Start with                                                 | Read next                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Repair or optimize one RTL file against fixed tests      | `chipsim evolution list`, then `describe --benchmark NAME` | [EVOLUTION.md](EVOLUTION.md)                                             |
| Build hardware from an idea or partial files             | `chipsim design guide`, then `chipsim design commands`     | [DESIGN_INPUTS.md](DESIGN_INPUTS.md), [DESIGN.md](DESIGN.md)             |
| Understand or program a document-backed model            | `chipsim agent context PROJECT --model MODEL_ID`           | [PROGRAMMING.md](PROGRAMMING.md), [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) |
| Create an experiment from authored register/stimulus CSV | `chipsim table help`                                       | [CSV_INPUTS.md](CSV_INPUTS.md)                                           |
| Run an HDL testbench or inspect VCD                      | `chipsim hdl help`                                         | [HDL.md](HDL.md), [HDL_DEBUG.md](HDL_DEBUG.md)                           |
| Show reported progress and candidate history             | `chipsim --agent PROJECT` in another terminal              | [AGENT_WORK.md](AGENT_WORK.md)                                           |

For complete connected wiring/state rules, use `chipsim circuit help` and
[AGENT_CIRCUITS.md](AGENT_CIRCUITS.md). `circuit` checks old-state simultaneous
updates and explicit connections; `evolution` evaluates and improves a candidate.
The [connected circuit contract](CONNECTED_CIRCUITS.md) states its supported
binary synchronous subset and native correspondence limits.

Two evolution definition formats are available. This guide uses the native
`chipsim evolution --benchmark` family and `chipsim-evolution-benchmark` JSON.
The separate installed `examples.evolution.runner` accepts `--workflow` and
`chipsim-evolution-workflow` JSON for Verilog/VHDL with multiple weighted measured
objectives; see [EVOLUTION_OBJECTIVES.md](EVOLUTION_OBJECTIVES.md). Their flags,
report schemas and scoring penalties differ; use the guide for the chosen entry
point. Both keep search external through OpenEvolve and reuse managed evidence.

Inspect existing work before creating prerequisites. Use only relevant stages.
A `.chip` program exercises declared model behavior; native firmware requires an
explicit compiler and execution backend. Document-backed work preserves original
PDF fingerprints and one-based page citations. RTL, CSV and ordinary design work
can proceed without a PDF. The TUI is the interactive frontend; text commands
support automation.

## A manual RTL improvement loop

Evolution requires Node.js 22.13+ and Python 3.10+ (`PYTHON` selects the Python
environment). Counter evaluation needs Icarus (`iverilog`, `vvp`); ALU also needs
Yosys; enabled equivalence needs EQY and its configured proof tools. Install tools
separately. Discovery and custom validation do not execute EDA tools.

Save complete JSON output. The work directory must exist; it does not need a PDF
project or a design manifest for bundled benchmarks.

```sh
mkdir -p ./work
chipsim evolution describe --benchmark counter --format text
chipsim evolution evaluate --benchmark counter --project ./work > before.json
chipsim evolution report before.json --format text
# Create ./candidate.sv with the interface declared by describe.
chipsim evolution evaluate --benchmark counter --candidate ./candidate.sv \
  --project ./work > after.json
chipsim evolution compare before.json after.json --format text
chipsim evolution reproduce after.json --project ./work
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
optional formal/replay recipes. Validate with `chipsim evolution validate
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
  session. `--case N` replays a saved failure, preserving counter initialization
  history or the failing ALU RTL/netlist stage. A reproduced failure does not
  establish full acceptance. Custom focused replay needs a declared recipe.
- Retain the managed artifact store and evidence links. Saved JSON alone is
  not a portable evidence bundle. Reproduction needs captured dependencies,
  executable identities and evaluator/runtime; the original source project
  may be removed. Never alter snapshots or sealed evidence to make a run pass.

## Sessions, search and agent tools

`evaluate`, `evolve` and `reproduce` create and finish their own work sessions by
default. For a manual multi-candidate session, start `agent work-start PROJECT
--goal "OBJECTIVE" --mode evolution`, retain its ID, and pass `--session ID` to
evaluations. Repeated submissions reuse that session's frozen definition.
Each command has its own invocation directory and cancellation marker; a failed
or interrupted submission leaves the caller-owned session available for retries
and cancels only its own invocation's jobs. Finish
the caller-owned session with a terminal `summary` event; see
[AGENT_WORK.md](AGENT_WORK.md). Avoid duplicate sessions around self-managed
commands. The dashboard shows reported actions and linked evidence; preserve
the user's inspected recording and cursor.

`evolve` uses separately installed/configured OpenEvolve. Run search within the
user's requested scope and selected configuration; its provider may receive
candidate RTL/feedback. Offline evaluation does not configure a provider.
Handwritten passing fixtures and manual improvements do not establish that
search ran. The selected search candidate is independently evaluated again.

Evolution commands wait for evaluation. Allow the default 60-second counter or
300-second ALU budget plus cleanup; `--timeout 1..300` changes an evaluation
budget. Ctrl-C requests managed-job cancellation and retains partial evidence.
Ordinary `design run` jobs have a different lifecycle: retain the job ID, poll
status/logs with their cursors, and use explicit `job cancel`. A status-poll
timeout leaves a durable design job running.

In Pi/prime-agent, prefer available named ChipSim tools. Use `chipsim_command`
for evolution, with literal arguments and enough time for the selected budget:

```json
{
  "args": [
    "evolution",
    "evaluate",
    "--benchmark",
    "alu8",
    "--project",
    "./work"
  ],
  "timeoutMs": 360000
}
```

No shell operators belong in an argument array. `timeoutMs` defaults to 180000
and can reach 86400000 for search. Other coding agents use the same CLI through
argument-array subprocess calls. See [AGENT_EXTENSIONS.md](AGENT_EXTENSIONS.md)
for cancellation and terminal handoff.

## What to return to the user

Report the candidate/benchmark, actual commands/settings, acceptance and failed
or incomplete checks, before/after measurements with units and comparability,
formal scope/assumptions, and job/run/artifact links. Include the saved report,
reproduction command and remaining limitations. Distinguish reported metrics,
verified evidence bytes, sampled behavior and proven scope. Never fabricate
results or weaken expected behavior to improve a score.
