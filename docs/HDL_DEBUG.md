# Synchronized HDL source, hardware and signals

Open an instrumented Verilog or VHDL run with **I** in ChipSim's TUI. Three
panes show the **same immutable snapshot after the selected recorded event**:
original HDL source/process, elaborated RTL blocks/connections, and signal
waveforms. The shared identity is `(runId, eventIndex)`. Moving the cursor changes
all three panes together, including while seeking backward.

## Install the optional capture tools

Opening a recording or a portable session needs only Node.js 22.13+ and ChipSim.
Capturing uses the pinned, instrumented simulator for the project's language.
HDL runs capture debug events by default; ordinary system Icarus/GHDL serve
explicit waveform-only runs (`--no-debug`, or managed `options.debug: false`).
Missing observer tools are reported as a setup failure with diagnostics and a
partial recording; no tool installation or silent waveform fallback occurs.

On Debian/Ubuntu, the build prerequisites are `build-essential`, `gnat`,
`autoconf`, `gperf`, `flex`, `bison`, `curl`, `python3`, and the usual tar/coreutils.
The recipe builds Icarus v12_0 and GHDL v4.1.0 mcode, verifies downloaded archive
hashes, and retains patched sources and build logs. It was tested from fresh
source releases on Linux with GCC/GNAT 13. Both paths below must be new; create
parent directories first. No package installation triggers this build.

```sh
mkdir -p "$HOME/.local/share" "$HOME/.cache"
sh scripts/build-hdl-debug.sh \
  "$HOME/.local/share/chipsim-debug-tools" \
  "$HOME/.cache/chipsim-debug-build-new"
chipsim hdl doctor --debug
```

For another installation prefix, set `CHIPSIM_HDL_DEBUG_TOOLS=/absolute/prefix`.
Doctor verifies its protocol and binary fingerprints; missing, changed or
incompatible tools are reported explicitly. Imports do not read this setting,
run compilers, or execute embedded source. See the
[observer recipes and licenses](../extensions/hdl-debug/README.md).

The observer directories are GPL-2.0-or-later; the independent ChipSim runner
remains MIT. Recipes retain upstream copyright headers and add dated modification
notices to edited upstream files. The installed `licenses/` folder includes the
observer NOTICE and upstream GPL texts. If sharing instrumented binaries, deliver
their complete corresponding patched source and build scripts under the GPL;
keeping the sources only in a private build directory is insufficient. See
[source/binary distribution notes](LICENSING.md#observer-source-and-binary-distribution).

## Record, open and inspect

```sh
chipsim hdl run examples/hdl/counter-verilog.project.json --out tmp/counter-verilog
chipsim hdl run examples/hdl/counter-vhdl.project.json --out tmp/counter-vhdl
chipsim --hdl-debug tmp/counter-verilog/debug.json
chipsim --hdl-debug tmp/counter-vhdl/debug.json --snapshot --view debug --at-event 40 --columns 120 --rows 40
```

Use unused output directories each time. In an uninstalled checkout, replace
`chipsim` with `node scripts/chipsim.mjs`. **H → Run Verilog / VHDL project** performs
the same capture inside the TUI; **H → Open debug recording / debug session** opens
an existing artifact. `d` also accepts both formats. `--at-event` is an event
index, while `--at` remains the ordinary model/waveform cursor option.
`chipsim --hdl PROJECT --hdl-out NEW_DIRECTORY` captures and opens the combined
debug view by default; add `--no-debug` to run/open waveform only. `--debug`
remains a compatible explicit capture flag on `hdl run`.

A run copies source/includes/assets before compiling. `debug.json` embeds original
UTF-8 source snapshots with SHA-256 fingerprints, project options, tool identity,
elaborated objects/connections, ordered events, diagnostics and capture status.
`events.jsonl` and Icarus `design.jsonl` retain the raw dedicated observer stream;
`result.json` and `diagnostics.json` retain commands, status and stdout/stderr.
Verilog debug runs do not require `$dumpvars`. When VCD exists, the runner also
keeps its ordinary waveform artifacts.

Compile errors, assertion failures, timeouts, cancellation and limits retain
artifacts. A valid prefix is marked **PARTIAL**. If no event stream can be
validated, the recording still contains source snapshots and diagnostics, with
zero events and unavailable execution/values. These runs never replace an active
experiment automatically. Open their `debug.json` explicitly to inspect them.
Source-location or object-reference corruption rejects an imported recording
before changing the active run, cursor, or trace.

## Read the three panes

At 110×32 and larger, source and hardware sit side by side above waveforms.
At 80×24, they stack vertically. F3 expands a focused pane for full source,
connections or waveform detail. Pane titles repeat the event number; the common
header shows run identity, exact physical time, available scheduler phase/delta,
completeness and replay state. Horizontal distance represents **event order**.
Multiple events at the same physical time remain separate.

- **Source:** `▶` marks a recorded process activation at its declaration/start
  location. It does not imply every statement on that line executed. `›` marks
  the browsed line. `BROWSE` means source selection is independent of execution;
  G follows recorded events again. Enter lists source files and full event/source
  details. Signal updates show declaration context, without a process marker.
- **Hardware:** actual elaborated hierarchy, processes, ports, variables/nets,
  Icarus operators, and static read/write/sensitivity/alias connections. `▶`
  means that process was activated; `*` means the recorded value changed at this
  event. A variable is not labeled a flip-flop merely because it is declared
  `reg`. Function/task/generate scopes retain their type. Static connections show
  possible structural relationships, not observed data transfers.
- **Signals:** after-event values and event-index waveforms. Selecting a signal
  or process links its source, hardware scope and related signals. The selected
  signal stays visible in a small pane. `≋` marks compressed columns containing
  multiple values. Enter retains exact full-width bits and source metadata.

Process activations that change no signals are retained. Deferred updates are
separate from process activation: the process event may still show the old output
until the simulator's later update. Execution highlighting is cleared at each
non-process event. Static writer/driver relationships do **not** identify the
writer of an individual event; this instrumentation reports event writers as
unavailable rather than guessing from the last active process.

## Controls

| Key               | Debug recording behavior                                             |
| ----------------- | -------------------------------------------------------------------- |
| I / 9 / 2 / 1 / 3 | Combined / HDL source / RTL hardware / signals / event log           |
| h/l, ←/→, J/N     | Previous/next recorded event                                         |
| 0, $, t           | First, last, or specified event index                                |
| Space             | Replay/pause saved events                                            |
| F2                | Cycle focused pane; Tab still cycles views                           |
| F3                | Expand/restore focused pane                                          |
| j/k, ↑/↓          | Browse within the focused pane                                       |
| Enter             | Full event/value/source details, static links, scope and pin choices |
| G                 | Follow recorded event locations and related hardware/signals         |
| K                 | Configure up to 32 replay stop conditions                            |
| C                 | Seek to the next configured stop after the current event             |
| F, +/−, =, z      | Numeric base, zoom, fit, center                                      |
| w/e/b, [/]        | Signal edges and previous/next recorded value change                 |
| S, x, H           | Save session, export, run/open HDL menu                              |
| ? / q             | Debug help / quit                                                    |

Stops cover process activation, signal change, exact signal value, literal
binary rising/falling edges, and assertions/reports. Space pauses on a matching
event; C seeks directly. Unknown-to-one is not a binary rising edge. Conditions
operate on saved events; they do not control or restart a simulator. A signal
value condition matches its after-event held value. To change stimulus or code,
edit the testbench/project and explicitly capture another run.

## Generated environment sources

SystemVerilog projects may include a finite inline digital environment profile;
see [HDL_ENVIRONMENT.md](HDL_ENVIRONMENT.md). Native runs embed the generated
`chipsim_environment.sv` beside authored source snapshots, with normal source
hashes and linked process locations. Nominal, disturbed and sampled DUT signals
are actual backend observations, not moved waveform segments. The profile and
realized edge schedule remain in `environment.json` in the run folder. A portable
debug recording embeds the generated source and original manifest profile; keep
the run's report for convenient edge-by-edge inspection. Replaying does not
regenerate stimulus, execute HDL or reconfigure a DUT.

## Portable data and limits

`chipsim-hdl-debug` version 1 stores a run, timescale, source snapshots, design,
events, capabilities, status, and diagnostics. IDs are unique within one run;
do not correlate compiler-generated IDs across runs. Events have contiguous
`seq`, exact integer-string `time`, kind, optional phase/delta/process/source,
and sparse full-bit-string changes. GHDL's delta is backend supplied; Icarus
queue regions do not acquire invented delta numbers. A sparse checkpoint every
256 events reconstructs arbitrary after-event snapshots without a dense
signals-by-events matrix.

`chipsim-hdl-debug-session` version 1 embeds the recording and cursor, browsed
source/line, follow mode, scope/selection, pinned/selected signals, pane focus,
maximized state, numeric format, zoom/offset and replay stops. Validation of the
whole artifact precedes installation. Saving uses portable embedded sources;
restoring needs neither the original project paths nor simulators.

**JSON export** retains the recording. **CSV export** has one row per event,
including same-time activations, sparse changes, process and source metadata.
**VCD export is a timestamp projection:** it retains final recorded signal values
at each timestamp and explicitly drops intermediate same-time values, process
activations, source/RTL mappings, phases and deltas. A partial timestamp may be
unsettled. The export menu and VCD comment label this loss. Ordinary waveform
comparison and external dwfv also use that projection, not event equivalence.

Defaults: 100,000 events, 512 observed digital signals, 4096 bits per signal,
64 MiB event data, 16 MiB source snapshots (4 MiB/file, 256 files), 16,384 design
objects, 65,536 connections, and 96 MiB portable input. Limits are fixed for this
version. Event limits stop capture without altering the HDL simulation; the
runner still terminates on the manifest's wall-clock timeout. Oversized or
unsupported signals produce explicit partial status. The raw artifact size
watchdog can terminate runaway capture; diagnostics describe the interruption.
Ordinary VCD projections retain their separate waveform limits.

Digital values retain `0/1/X/Z` and VHDL `U/W/L/H/-`, wide vectors, signed metadata,
aliases and declaration order. Signed binary values display as two’s-complement
decimal when F selects decimal; unknown states remain literal. Icarus memory words are individual observed
signals with a structural aggregate for indexed accesses. GHDL arrays/records
flatten in declared scalar order with `bitNames`; integer values retain 32/64-bit
encoding, other enumerations retain ordinal encoding. GHDL `shares-bits` edges
mean some scalar storage overlaps, not necessarily whole-vector equality.
Real/string/access types, optimized-away objects, runtime local variables, and
arbitrary statement/CPU-instruction stepping are outside this observer. A source
outside the copied project is explicitly unmapped. The graph is elaborated RTL,
not a synthesized netlist or physical layout. HDL runs require an HDL/testbench
project; firmware on an arbitrary CPU requires a separate CPU/ISA model.

## Acceptance checks

`npm run test:hdl-debug` requires both instrumented backends and ordinary
Icarus/GHDL on PATH. It compares instrumented and stock adder/counter waveforms
against independent arithmetic/handshake expectations, validates fault
assertions, no-change activations, deferred updates, waits/delays, generated
instances, arrays, wide/signed values, alias consistency and nine-state order.
It checks real event/byte/width/signal limits, unsupported signal types, compile failures, timeout/cancellation and partial
artifacts. Unit tests reconstruct every fixture event backward and verify that
all panes and full-screen views match. A real PTY checks 120×40/80×24 resize,
focus/expand, stepping/stops, portable sessions, failed-run preservation,
partial export and terminal cleanup. Also run `npm run verify`, `npm run
test:tui`, `npm run test:hdl`, and `npm run test:install`.
