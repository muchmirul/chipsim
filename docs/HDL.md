# HDL projects, waveform import and behavior comparison

ChipSim's terminal workbench can inspect external HDL traces, run **Verilog/SystemVerilog with Icarus Verilog** and **VHDL with GHDL**, and compare mapped signals with another HDL waveform or a ChipSim behavior trace. The execution backend supplies HDL scheduling semantics. Waveform replay in ChipSim is a recorded-results viewer.

## Start with the supplied open-source designs

Install Icarus Verilog (`iverilog` and `vvp`) and GHDL on PATH. On Debian/Ubuntu, the packages are `iverilog` and `ghdl`. No additional npm runtime packages are needed; importing an already produced waveform needs neither simulator.

```sh
chipsim hdl doctor
chipsim hdl run examples/hdl/adder-verilog.project.json --out tmp/verilog-run
chipsim hdl run examples/hdl/adder-vhdl.project.json --out tmp/vhdl-run
chipsim --vcd tmp/verilog-run/waveform.json
chipsim hdl compare tmp/verilog-run/trace.vcd tmp/vhdl-run/trace.vcd --map examples/hdl/adder-compare.json --out tmp/compared
```

Without a local ChipSim installation, substitute `node scripts/chipsim.mjs` for `chipsim`. All output directories must be new. See [the example walkthrough](../examples/hdl/README.md), including comparison against the actual datasheet-derived 74HC00 behavior model. The upstream adders are unmodified CC0 cocotb examples with pinned hashes and URLs.

## Import and inspect waveforms

```sh
chipsim --vcd external.vcd
chipsim hdl import external.vcd --out tmp/imported
chipsim --vcd tmp/imported/waveform.json --snapshot --columns 80 --rows 24
```

Inside the terminal, press **H** for Import, Run and Compare. `d` can also import a `.vcd`, waveform JSON, or saved waveform session. Existing waveforms, log, register/value inspection, signal-name search, edge jumps, zoom, exact step details and playback operate on the imported signal trace. `S` saves a portable waveform session; `x` exports JSON, CSV or VCD; `V` hands VCD to the optional external viewer. JSON preserves unavailable values and import/run metadata; VCD re-export represents unavailable initial values as X and uses flat escaped signal names to preserve the original full identifiers.

**Horizontal positions are timestamp sample indices, not physical spacing.** Each cursor position shows its exact simulator time, with integer precision down to femtoseconds. One recorded sample contains final dumped values at that timestamp; within-timestamp updates/delta-cycle history are not exposed as debugger steps. Playback moves through samples rather than advancing a live HDL simulator. Parameter, stimulus, register and `.chip` edits are disabled for a recorded waveform: change the HDL testbench and run again.

The importer retains hierarchy in full identifiers, aliases, widths up to 4096 bits, held values, per-bit `0/1/X/Z` and GHDL's `U/W/L/H/-` extensions. Unknowns never become numeric zero. It rejects real/string/event variables and malformed/unsupported VCD commands instead of guessing their meaning. Limits: 64 MiB input, 512 declarations, 20000 timestamp samples, and at most 2 million signal/sample cells. A signal not dumped yet is unavailable, distinct from a dumped X. VHDL records, enumerations and other types absent from GHDL's VCD cannot be recovered; GHW/FST import is not implemented.

## HDL project manifest

```json
{
  "format": "chipsim-hdl-project",
  "version": 1,
  "name": "Counter experiment",
  "language": "verilog",
  "standard": "2012",
  "sources": ["counter.sv", "counter_tb.sv"],
  "top": "counter_tb",
  "includeDirs": ["include"],
  "assets": ["data.hex"],
  "parameters": { "WIDTH": 8 },
  "waveform": "trace.vcd",
  "timeoutMs": 30000
}
```

Paths are relative to the manifest and remain within its directory. Source order is significant for VHDL analysis. The selected `top` is the testbench module/entity, so parameters/generics target that top. For VHDL use `"language":"vhdl"`, usually `"standard":"08"`; optional `stopTime`, e.g. `"10us"`, bounds simulator time. `timeoutMs` (100–120000) bounds wall-clock time for each process, independently of simulation time.

Verilog testbenches must write the configured VCD filename using `$dumpfile`/`$dumpvars` and terminate with `$finish`; failing assertions should use `$fatal` for a failing exit code. ChipSim runs `vvp -n` so `$stop` does not open an interactive simulator prompt. GHDL is run with `--vcd` and `--assert-level=error`; use a terminating testbench or `stopTime` when it has a free-running clock. A configured stop time is a trace boundary, not evidence that every test assertion was reached. The manifest does not supply clocks/reset/input stimulus itself.

Runs copy declared sources/assets and include directories into a fresh run folder before compilation. Limits: 256 files/directories, 4 MiB per file, 16 MiB total copied source data; symlinks are rejected. The compiler runs on that copy, with argument arrays and no shell. Sources/includes/assets must contain everything the testbench needs; undeclared external files, custom libraries, mixed-language elaboration, simulator plugins and arbitrary extra compiler flags are outside this runner. HDL execution uses the user's local process permissions.

`result.json` records tool versions, source hashes, stage commands/status and artifact paths; `diagnostics.json` keeps stdout/stderr. Successful and failed runs retain their directories. Available partial waveforms are exported even when a simulator fails, but failing runs do not replace the active terminal experiment. Diagnostic output and waveform size are bounded. Ctrl-C or quitting the terminal cancels an active runner and restores terminal mode.

Alternatively, run and open directly:

```sh
chipsim --hdl examples/hdl/adder-verilog.project.json --hdl-out tmp/new-run
```

## Map signals and time explicitly

```json
{
  "mode": "sampled",
  "rightTick": "5ns",
  "sampleEvery": "5ns",
  "from": "0ns",
  "to": "100ns",
  "signals": [
    { "left": "tb.enable", "right": "signal.enable", "role": "input" },
    { "left": "tb.count", "right": "reg.count", "role": "output" }
  ]
}
```

```sh
chipsim hdl compare run/trace.vcd model-trace.json --map mapping.json --out tmp/review
```

Names must match exactly and widths must agree. Waveform identifiers are the full imported names. Exported ChipSim model identifiers use `signal.ID` and `reg.ID`. Export the model JSON trace with the current version so its declarations/widths are included. When the left or right input is a model trace, `leftTick` or `rightTick` is required, respectively, and comparison mode must be explicit. That time assignment is an experiment assumption; it does not turn normalized model ticks into vendor timing claims.

`continuous` (the default for two waveforms) compares held values at the union of recorded change times, including short dumped pulses. `sampled` requires `sampleEvery`, compares only its explicit grid, and requires the end on that grid. Values at a timestamp include all dumped updates at that timestamp. By default the report compares the overlap but marks differing start/end coverage as a mismatch. An explicit `from`/`to` selects a narrower shared experiment range; the range cannot extend beyond either trace.

Results report matching status, coverage, number of changed samples, first differing time in femtoseconds, and exact differing bit strings. X/Z and the VHDL states compare literally, never as wildcards. Unavailable values cannot establish a match, even when both traces omit the value. Up to 2000 changed samples are retained in detail, with a `truncated` flag and full counts. Input-role mappings report stimulus discrepancies separately from output discrepancies; unlisted inputs are not checked. TUI comparison preserves the working model, trace, configuration and cursor and supports exporting the same report.

`chipsim hdl` commands print one versioned JSON result. Exit status: 0 for successful commands/matching comparisons, 1 for failed HDL execution or differing comparisons, 2 for invalid arguments/files/mappings. A completed comparison has `ok:true` even when `comparison.match:false`; inspect both fields. A matching trace comparison proves only the mapped observations in its declared range, not whole-design equivalence, physical timing accuracy, or datasheet fidelity.

## Verification

`npm test` includes parser, exact-time/logic comparison, process failure/cancellation and waveform state/rendering tests without requiring installed HDL backends. `npm run test:hdl` requires both real simulators, exercises the upstream designs, independent 256-case oracle, real sourced model comparison, mismatch/error cases and real terminal import/run/compare/export. `npm run test:install` checks packed CLI commands outside the checkout. Backend versions used for development: Icarus Verilog 12.0 and GHDL 4.1.0 (mcode).

The terminal and headless CLI implement this workflow. The static browser retains its existing model workflow; it does not launch local compiler processes or import external HDL traces.
