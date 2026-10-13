# Versioned design workbench

ChipSim records managed work as **input snapshot → task attempt → artifacts →
checks**. A snapshot captures dirty working files as well as effective task
configuration, tool identities, and declared dependency locks. A waveform, proof
result, netlist, physical database, and layout remain in their native formats.
ChipSim stores descriptors and links around them, rather than converting all
payloads to JSON.

## Start a project

Use `chipsim design guide [TOPIC]` and [input preparation](DESIGN_INPUTS.md)
when starting from an idea or partial files. The optional recipes cover minimum
files, testbenches, missing-input preparation and installed starter paths. The
[minimal counter](../examples/design/minimal) is a complete five-file managed
simulation project; its two HDL files and HDL manifest also run standalone.

```sh
chipsim design commands
chipsim design init ./chip-work
# Edit chip-work/chipsim.design.json and add the HDL project and source files.
chipsim design doctor --project ./chip-work
chipsim design plan --project ./chip-work --target simulation
chipsim design run --project ./chip-work --target simulation
chipsim --design ./chip-work
```

`design commands` returns machine-readable command arguments, option bounds,
effects and native integration formats without requiring a project. The same
definitions validate the workbench CLI. `design status --project ./chip-work
--target simulation` reports current readiness, required checks, the latest run,
active jobs, task/tool availability and suggested literal argument arrays. It
does not probe tool versions or execute tasks. A successful status query can
report `ready: false`; `checks` still exits unsuccessfully when readiness is blocked.

For an agent control loop, start a job, poll it briefly, and inspect the result:

```sh
chipsim design run --project ./chip-work --target simulation
chipsim job status JOB_ID --project ./chip-work --wait --timeout-ms 1000
chipsim job logs JOB_ID --project ./chip-work --offset 0 --limit 16384
chipsim design status --project ./chip-work --target simulation
```

`--timeout-ms` accepts 1–60000 and requires `--wait` on run, retry or one job's
status. Timeout returns the job with `waitingStopped: true`, `waitReason: "timeout"`;
the accepted job continues. An unbounded `--wait` retains its one-day limit.
Save log `cursor` as the next byte offset even when `nextOffset` is null: null
means the current end of the file, and running jobs can append more bytes later.

Initialization creates both manifests without overwriting either existing file.
The generated target expects a `sim.project.json` using the existing HDL manifest
format. The supplied `examples/design/peripheral` project is runnable with Icarus
and provides additional targets for the external tools. It is illustrative
hardware, not a vendor-derived model.

`design run` returns a job ID after acceptance. A detached Node worker continues
after the initiating terminal or agent closes. `--wait` waits for completion;
stopping the wait does not cancel the job. One execution task runs at a time per
project. Separate projects have independent workers. Jobs are local POSIX
processes; Windows process-tree cancellation is not supported by this release.

```sh
chipsim job status JOB_ID --project ./chip-work
chipsim job logs JOB_ID --project ./chip-work --offset 0 --limit 16000
chipsim job cancel JOB_ID --project ./chip-work
chipsim job retry JOB_ID --project ./chip-work
```

Cancellation collects available outputs. Retrying uses the original snapshot and
a new attempt; start a new run to use edited sources. Worker crashes become
`interrupted` on the next status/read. Owned child processes are identified by
PID and Linux process start time before recovery terminates them. Staging remains
available for diagnosis even when publication itself fails.

## Project contract

Both manifests use version 1. Paths in filesets, inputs, bindings and output
declarations are relative to the design manifest directory; traversal and
symbolic links are rejected. Directory inputs are recursively captured, excluding
`.git`, `.chipsim`, and `node_modules`. Preserve HDL order in the HDL manifest.

```json
{
  "format": "chipsim-design",
  "version": 1,
  "id": "peripheral",
  "filesets": {"rtl": ["rtl"]},
  "tools": {},
  "tasks": {
    "sim": {
      "adapter": "hdl",
      "options": {"project": "sim.project.json", "debug": false},
      "outputs": [{"path": "out/waveform.json", "kind": "waveform"}]
    }
  },
  "targets": {
    "simulation": {
      "tasks": ["sim"],
      "requiredChecks": ["sim:simulation", "sim:outputs"]
    }
  }
}
```

A task has an adapter, optional `inputs`, `filesets`, `needs`, `bindings`, `tool`,
`options`, `outputs`, `checks`, and `timeoutMs` (100–86400000). Each target selects
task IDs and required `TASK:CHECK` names. Dependencies are resolved before
execution; missing tasks and cycles reject planning. Bindings both declare a
dependency and copy a verified upstream artifact into the consumer's workspace:

```json
{"task":"registers","output":"out/registers.sv","path":"rtl/registers.sv"}
```

An output declaration has `path`, `kind`, optional `format`, and `required`
(default true). Missing required outputs cannot pass readiness. Other generated
files are retained as artifacts, except intermediate `.o`, `.a`, and `.d` files
unless explicitly declared. Artifacts advertise available inspection features;
FST and binary physical databases are retained without claiming an internal
ChipSim viewer.

Tool profiles under `tools` can specify `command`, `versionArgs`, `args`, and
`env`; a task selects one with `tool`. External tasks can override arguments with
`options.args`, an array passed without a shell. `{workspace}` and `{out}` expand
inside arguments/environment values. Task commands execute only on an explicit
run action; `doctor` and `plan` probe tool versions. Freshness and artifact
inspection never execute configured version commands. `command` is an explicit adapter for custom local workflows, not a
mechanism for interpreting imported evidence.

Declare every source, test, script, library and configuration consumed by a task.
Native HDL adapters discover their manifest's sources/includes/assets; native
model/program adapters include the attached prepared project. Generic external
commands can access the host filesystem, so declaration completeness remains
the project author's responsibility. This is a reproducible-input workbench,
not an operating-system sandbox. Tool options and explicitly supplied environment
values become part of the evidence; do not place credentials in them.

`chipsim.lock.json` has `format: "chipsim-lock"`, `version: 1`, and `dependencies`.
Each external dependency records `path`, `sha256`, and optional `tasks` IDs. Its
digest is the canonical SHA-256 of the sorted recursive `{path,sha256,bytes}`
inventory. Internal symbolic links are recorded as `{path,link}`; their targets
must remain within the inventoried directory. `.git` and `.chipsim` are excluded.
Use `chipsim design lock --project PROJECT --path DIRECTORY` to
calculate a dependency entry without modifying the lock file. Dependencies such
as ORFS and the PDK remain separately installed; a mismatch rejects execution.
Pinned tool executable hashes and reported versions are captured automatically.

## Adapters and native files

| Adapter | Options / inputs | Outputs / checks |
| --- | --- | --- |
| `hdl` | `project`, optional `debug`; Icarus/GHDL project and HDL | Existing `out/` recordings, VCD, diagnostics; `simulation` |
| `model` | `model`, `project`, optional `params`, `inputs`, `ticks` | Existing traces/session; source and model acceptance checks |
| `program` | `program`, `model`, optional prepared `project`, `ticks`, `steps` | `.chip` source, traces, program debug and session |
| `document` | `manual` PDF | Prepared project under `out/`; `preparation` |
| `waveform` | `waveform` VCD/JSON | `out/waveform.json`; `import` |
| `compare` | `left`, `right`, `map` | `out/comparison.json`; `comparison` |
| `fusesoc` | `core`, optional `target`; declared `.core` and source files | Setup-only resolved files, EDAM YAML and backend scripts under `out/` |
| `peakrdl` | `rdl`, optional `exportArgs` per exporter | Register `.sv`, `.h`, IP-XACT `.xml`, normalized metadata `.json` under `out/` |
| `verilator` | `top`, declared RTL; optional `flags`, `runArgs`, `buildOnly` | Compiled simulator and configured VCD; process result |
| `cocotb` | `makefile`, optional `simulator`, `makeArgs`, `results` XML path | xUnit test results, logs, simulator waveforms; individual `test-N` and aggregate `tests` |
| `sby` | `config` `.sby`, optional `tasks`, `output`, `scope`, `assumptions` | Status files, logs, available counterexamples; `formal` |
| `eqy` | `config` `.eqy`, optional `output`, `scope`, `assumptions` | Partitions, statuses, available counterexamples; `equivalence` |
| `orfs` | `flow` installed flow directory, `config` `.mk`, optional `stages`, `reports` | Stage `.v`, `.sdc`, `.odb`, `.spef`, `.gds`, metrics JSON, DRC `.lyrdb`, LVS `.lvsdb`; configured `timing`, `drc`, `lvs` checks |
| `firmware` | Declared `.c`/`.s`/`.S`, `linker`, optional `compiler`, `objcopy`, `flags`; `.asm` needs an explicit assembler task | `out/firmware.elf`, `.map`, `.bin`, byte-oriented `.hex` |
| `renode` | `script` `.resc`, declared `.repl`, firmware, compiled HDL bridge | Captured logs and outputs explicitly enabled by the script |
| `openroad-mcp` | Finite `requests` array of `{name,arguments}` tool calls | `mcp-session.jsonl`, `mcp-results.json` and generated native files; `mcp` |

The Renode adapter runs a project-supplied platform and HDL co-simulation bridge;
it does not infer a bus or synthesize a platform from arbitrary RTL. The MCP
adapter records an explicit bounded session over stdio and does not install or
configure a provider. It captures initialization, requests, responses, stderr
diagnostics and generated files. Tool profiles supply the server command,
arguments and environment; `{workspace}` and `{out}` also expand in request
arguments. Use tool profiles for a pinned installation's syntax.
No dependency is automatically downloaded by ChipSim commands.

OpenROAD-MCP reports errors inside its JSON payload, including when `isError`
is absent. ChipSim checks both forms, stops the sequence on the first failed or
incomplete call, and retains the exact transcript plus normalized results.
Truncated responses and unknown response contracts are inconclusive. Use an
explicit `session_id` in `create_interactive_session` and reuse it on later
calls; sessions are local to that finite task. The `mcp` check establishes complete
successful calls, not timing closure or another hardware property. The supplied
`physical-inspection` target binds the physical task's ODB into such a session,
queries area, and publishes a new ODB and transcript. Install the server separately
and lock its installation and dependencies. The adapter probes `--help` because
OpenROAD-MCP 1.1.0 has no `--version`; the transcript captures server identity.
Tasks that create or use an OpenROAD session also fingerprint the declared
OpenROAD executable. Imported server libraries still need a dependency lock.

All tasks publish `execution` and `outputs` checks. Process success does not imply
test success, proof, timing closure, DRC, or LVS. Empty test suites and unknown
solver results are inconclusive. EQY's top-level `FAIL` means equivalence was not
established; it is not automatically a counterexample. Formal scope and assumptions
remain attached to the exact configuration snapshot.

For tool-specific JSON reports, declare checks with `name`, `path`, `field`
(dot-separated), `operator` (`eq`, `lte`, `gte`), `value`, `scope`, and optional
`assumptions`. Numeric comparisons require finite numbers. Missing/malformed
reports cannot pass. Preserve timing `stage`, `corner`, and `units` under
`options.context`; raw native reports remain available for inspection.

### Physical report checks

An ORFS task opts into native report checks with `options.reports`:

```json
{
  "stages": ["finish", "drc", "lvs"],
  "context": {"stage":"finish", "corner":"sky130hd typical", "units":{"time":"ns"}},
  "reports": {
    "timing": {
      "path":"out/logs/6_report.json",
      "metrics":[
        {"field":"finish__timing__setup__ws", "operator":"gte", "value":0},
        {"field":"finish__timing__drv__setup_violation_count", "operator":"eq", "value":0},
        {"field":"finish__timing__drv__hold_violation_count", "operator":"eq", "value":0}
      ],
      "assumptions":["Unconstrained paths and other corners are outside this check"]
    },
    "drc":{"path":"out/reports/6_drc.lyrdb"},
    "lvs":{"path":"out/results/6_lvs.lvsdb"}
  }
}
```

Paths are relative to the captured task workspace. Timing field names are exact
top-level native JSON keys, with 1–32 `eq`/`gte`/`lte` finite numeric comparisons.
Every requested metric must exist. Timing also requires a declared stage, corner,
time unit and captured SDC; each result retains observed values, thresholds and
constraint hashes. These criteria cover only the reported paths and selected
corner. They do not establish complete constraints, exception correctness or
multi-corner closure.

After ORFS, ChipSim runs a bounded KLayout reader in the owned job to read the
DRC/LVS databases. Its `chipsim-physical-reports.json` summary fingerprints the
native files; normalization rejects changed or missing bytes. DRC passes only
with zero items and at least one rule category. LVS requires compared circuits,
no extraction errors, and exact matches at circuit/net/device/pin/subcircuit
levels. Mismatches fail; warnings, skipped comparisons, empty databases and
unsupported-platform placeholder text remain inconclusive. Report reading
occurs during execution; later inspection reads sealed evidence only.

Missing reports never become a pass, and failed tool execution prevents a passing
physical verdict. Checks link both the summary and original native reports.
The selected PDK and rule decks define coverage; these checks do not establish
foundry signoff. ORFS and KLayout formats are documented in the
[ORFS flow](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts) and
[KLayout API](https://www.klayout.de/doc/code/class_NetlistCrossReference.html).

## Inspect, compare and share evidence

```sh
chipsim artifact list --project ./chip-work --limit 20
chipsim artifact inspect ARTIFACT_ID --project ./chip-work
chipsim artifact verify RUN_OR_ARTIFACT_ID --project ./chip-work
chipsim artifact compare LEFT_RUN RIGHT_RUN --project ./chip-work
chipsim checks --project ./chip-work --target simulation
chipsim artifact export RUN_ID --project ./chip-work --out ./evidence-bundle
chipsim artifact import ./evidence-bundle --project ./another-project
```

The terminal opens Project, Pipeline, Artifacts and Checks views through Tab;
`0` returns to Project. `r` accepts the selected target, `X` explicitly cancels
the selected job, and `R` retries it. Enter opens actions and related evidence;
`o` opens an artifact using the existing waveform/debug/session viewer or launches
KLayout for layout. Background updates never replace the active experiment.
Source links, consumers, checks and producer records are available through the
artifact metadata and related-evidence menu. Inspection selections and typed
cursors are saved separately in `sessions/tui.json`.

Checks are evaluated against current target policy and task inputs. An unrelated
file edit leaves a task current; a consumed-input edit marks affected tasks and
their consumers stale. Missing, invalid, stale, failed or inconclusive required
checks block readiness. A target with no required checks cannot be release-ready.
Run comparison reports byte identity and preserved context, not numerical timing
equivalence across different corners or constraints.

Records and payloads live under `.chipsim/design/records` and `objects`, addressed
by SHA-256. Staging and mutable job state live under `jobs`; successful result
pointers publish only after record and payload validation. These hashes detect
changed bytes and links; they are not a signature certifying the author's claims.
Payloads are copied, never hard-linked into writable tool workspaces.

Export bundles include input snapshots and transitive evidence. They are offline
inspection directories containing `bundle.json`, `records/`, and `objects/`.
Replay additionally requires the recorded tools and external dependency locks.
Old directories require explicit import and have unknown provenance, completeness
and check coverage. They cannot be reused automatically. Existing standalone
commands keep their output formats and add `artifacts.json` inventories; use a
design target for captured input snapshots and durable execution.

Limits: 256 tasks per project, 20,000 files per snapshot/collection, 2 GiB per
payload, 16 MiB JSON records, and 16 MiB cumulative process logs per job. Queries
are bounded and paginated. A damaged cache entry is rejected, never accepted as
passing evidence. There is no automatic deletion/garbage collection of evidence.

## Verification

`node --test test/design.test.js` covers snapshot execution during edits,
dependency bindings, freshness/reuse, detached jobs, cancellation, retry, crash
recovery, corruption, portable bundles, explicit historical imports, inconclusive
results, read-only inspection, MCP protocol failures, and both terminal sizes.
`npm run test:eda` runs the real primary-tool fixtures and fails when required
executables are unavailable. `--core` selects Icarus/GHDL and artifact checks;
`--digital` adds generation, regression, formal, firmware and Renode. The full
suite also requires `CHIPSIM_ORFS_ROOT` pointing to an installed ORFS `flow`
directory and checks physical-flow completion and required native output files.
It does not replace the platform's timing, DRC or LVS acceptance policies. The
standard HDL, debugger, TUI, install and verification suites remain applicable.

`npm run test:physical` isolates the real ORFS flow and native report checks.
Set `CHIPSIM_ORFS_ROOT` to the installed flow directory and put its tools on PATH.
Add `-- --mcp` and set `CHIPSIM_MCP_ROOT` to the server installation directory to
test the connected ODB inspection task. The harness locks those directories,
verifies report evidence, and checks that readiness reflects the native verdicts.
A reported LVS mismatch can therefore pass the integration harness while leaving
the design's `ready` flag false. Missing tools or unreadable reports fail the
harness; no required backend is silently skipped. `CHIPSIM_KEEP_EDA=1` retains a
successful test project too. Native reader acceptance also runs independently:
`klayout -b -r scripts/test-design-reports.py` covers clean/violating DRC,
matching/mismatching LVS and unreadable reports.

The SKY130 HD fixture completed synthesis through GDS with ORFS revision
`8ae3ae362e2e9be94ab1d27b3dd647c8328a783f`, OpenROAD
`v2.0-17598-ga008522d8` and KLayout `0.28.16`. Its explicit die/core areas leave
clearance between I/O pins and the power grid. The final GDS, ODB, SPEF, netlist
and reports passed artifact-integrity verification. The 2024 flow's bundled LVS
inputs are incompatible with the tested KLayout reader (CDL subcircuit separators
and report output selection). The extended check used the same flow with the
SKY130 HD CDL and LVS deck from upstream revision
`479d02aaee049b960ea302bf2043d6816341a160`; the entire resulting flow directory was
fingerprinted in the lock. That run passed the configured timing criteria
(setup slack 17.092 ns, zero reported setup/hold violations) and DRC (zero items,
166 categories). LVS reported mismatches, so the design correctly remained
**not ready**. This is an integration acceptance result, not a tapeout-ready
reference design. The exact upstream inputs are
[CDL](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts/blob/479d02aaee049b960ea302bf2043d6816341a160/flow/platforms/sky130hd/cdl/sky130hd.cdl)
and [LVS deck](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts/blob/479d02aaee049b960ea302bf2043d6816341a160/flow/platforms/sky130hd/lvs/sky130hd.lylvs).

The real OpenROAD-MCP 1.1.0 server passed a finite session reading that ODB,
querying area, writing a new ODB and terminating. A separate blocked-command
session failed, stopped subsequent calls, and retained its transcript. Protocol
fixtures additionally cover malformed and truncated responses. The Renode
fixture executes firmware on its declared software platform; RTL co-simulation
continues to require the project's compiled HDL bridge and bus configuration.
