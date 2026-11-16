# Tiny Tapeout power-controller example

A small, original digital power controller for the Tiny Tapeout IHP
`ihp-sg13cmos5l` process, one 1x1 tile at 50 MHz. The design provides PWM,
power-good startup supervision, and latched shutdown for an external power stage.

- Sixteen duty settings, N/16 for N=0..15; PWM frames have 256 clocks.
- Frame-boundary duty changes preserve the current pulse.
- Eight-clock minimum startup delay and 256-clock power-good deadline.
- External fault or loss of power-good stops drive and latches shutdown.
- Safe fault-clear interlock, asynchronous active-low reset, and independent ena gating.

At the selected clock this is 195.3125 kHz PWM, 160 ns minimum startup and 5.12 us
timeout. These are digital demonstration constants. Analog regulation, sensing,
and gate drive are external; control inputs except reset must be synchronous.
The maximum duty is 93.75% and there is no 100% command.

See [pinout and bring-up](docs/info.md), [requirements and acceptance mapping](docs/requirements.md),
and the [public-pin testbench](test/tb.sv). Both RTL and the physical-flow netlist
must pass the same 14 cases. Timing, DRC, LVS and native precheck are separate gates.

## Reproduce through ChipSim MCP

From the repository root, with Node 22.13+, Python 3.11/3.12 and a working Docker engine:

```sh
npm ci --prefix extensions/mcp
node example/power-controller/reproduce.mjs --out /tmp/power-controller-run
```

Use a new output directory. The helper connects the official MCP SDK to a fresh
ChipSim stdio server and uses MCP tools for setup, bootstrap, file edits, managed
jobs, readiness checks, packaging and binary downloads. It obtains machine-local
tool/PDK paths and locks through `environment_setup`; it does not copy stale
absolute paths from the checked-in execution manifest. It reads the pinned
profile, preserving clock, tile size, source, tests and constraints.

Pass `--cache CACHE_ROOT` or set `CHIPSIM_MANUFACTURING_CACHE` to reuse a compatible
managed cache. Missing dependencies are installed explicitly by the setup job.
Ctrl-C requests cancellation and waits for the active managed job to stop.
If the client is forcibly killed, its journals retain request and job IDs for
explicit status inspection/cancellation; disconnected jobs remain durable. Confirm
the old client has stopped before removing its reported journal lock.

The fresh output contains an MCP-created working project, native evidence under
`.chipsim/`, and verified files in `delivery/`. Sibling `.prepare.json`, `.simulation.json`, `.release.json` and `.delivery.json`
journals retain durable request/job identities for the official helper. Resume an
interrupted operation with `node extensions/mcp/workflow.mjs resume --state JOURNAL`. The helper verifies every binary chunk and complete file hash.
The generated ZIP is extracted and passed through native precheck before release.

The files in this checked-in project preserve the original run's manifests and
pins. `tt/` is a generated external support checkout and is ignored by Git;
`reproduce.mjs` recreates it through MCP in the fresh project. The raw PDK and
Python tool environments remain external dependencies.

## Delivery and evidence

The original recorded validation and deliverable identities are in `VALIDATION.json`.
[Current reliability revalidation](VALIDATION-reliability.json) records the updated
runtime and official helper's fresh-project runs. The original committed delivery
remains the historical snapshot; the new helper retrieves fresh delivery files.
The `delivery/` directory contains `submission.zip`, checksums, release manifest
and archive-validation XML. Full `evidence.zip` is generated locally and ignored
by Git because it includes captured external support-tool sources; its checksum
is retained and `reproduce.mjs` regenerates it. `submission.zip` includes the native
GDS/OAS/LEF/netlist/parasitic files and project documentation/licenses.
The companion evidence retains original sources, tool identities, logs and checks.
These are local Tiny Tapeout handoff files; actual shuttle submission, payment,
and manufacturer acceptance are external.

To inspect the current working project, launch:

```sh
node scripts/chipsim.mjs --design example/power-controller
```

Use the reproducible fresh project path instead after cloning, because `.chipsim/`
evidence and `tt/` are intentionally not committed. GDS/OAS remain native physical
files for KLayout. Original RTL/tests are MIT; retained technology notices are in
[docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
