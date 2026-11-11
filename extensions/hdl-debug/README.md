# Optional ChipSim simulator observers

Current builds advertise `capture-scopes-v1` and `capture-process-file-v1` in
their fingerprint manifest.
`CHIPSIM_DEBUG_SCOPES` carries validated newline-separated exact hierarchy
prefixes. Both backends filter signal/process observations before native budgets;
assertions remain global. Icarus also receives the selected elaborated process
IDs in `capture-processes.txt` after compilation; only the path is supplied via
`CHIPSIM_DEBUG_PROCESS_FILE`. The bounded text format has a
`chipsim-capture-processes-v1` header, a decimal row count and one unique `p:T_N`
ID per line. The observer verifies count, line lengths, syntax and EOF before
recording, with a maximum of 16,384 IDs. Missing or malformed files mark capture
incomplete rather than defaulting to all processes. These variables are set
only by explicit HDL runs and cleared for version probes/waveform-only runs.
See [manifest capture scope](../../docs/HDL_DEBUG.md#select-a-capture-hierarchy).

These adapters target **Icarus Verilog v12_0** and **GHDL v4.1.0 mcode**.
The observer sources and patch recipes in `iverilog/` and `ghdl/` are
GPL-2.0-or-later; see [COPYING](COPYING) and [NOTICE](NOTICE). The recipes contain small upstream
context fragments under the respective upstream GPL terms. The simulators,
compiler toolchains, generated executables and full upstream sources are not
bundled in the ChipSim npm package.

Build explicitly with `scripts/build-hdl-debug.sh NEW_PREFIX NEW_BUILD_DIRECTORY`.
The recipe downloads official tag archives, verifies these SHA-256 values before
extracting or patching, refuses existing destinations, preserves sources/logs,
and writes a fingerprint manifest for the resulting binaries:

| Project | Source                                                                  | SHA-256                                                            |
| ------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Icarus  | https://codeload.github.com/steveicarus/iverilog/tar.gz/refs/tags/v12_0 | `a68cb1ef7c017ef090ebedb2bc3e39ef90ecc70a3400afb4aa94303bc3beaa7d` |
| GHDL    | https://codeload.github.com/ghdl/ghdl/tar.gz/refs/tags/v4.1.0           | `0aab531b45a6613b0918f3ac6ec717b8acfad051d1abb1c39eb7490590c7a324` |

`apply.py` stages exact-context edits before writing; a different upstream
version is rejected. `manifest.mjs` records binary fingerprints after building.
Icarus includes its compiler and VVP target as well as the driver and runtime;
GHDL uses its mcode executable. `chipsim hdl doctor --debug` verifies the manifest.
The install prefix includes the upstream license texts and observer attribution
under `licenses/`. Each edited upstream file receives a dated ChipSim modification
notice; its original copyright/license headers remain intact.
When distributing binaries, deliver the exact corresponding patched sources and
build/installation scripts under the GPL source requirements. Retaining a private
build directory is insufficient. See [publication notes](../../docs/LICENSING.md).

The Icarus target exports elaborated scopes, declarations, process IDs and static
connections. VVP exports scheduled process activations and read-only VPI value
observations, original scheduler queue regions, assertion calls and termination.
The GHDL patch retains process RTI/context, observes effective signal updates,
records process and postponed phases/delta indices, and traverses elaborated
RTI/compiler read/driver metadata. Neither adapter modifies HDL text, deposits
values, forces signals, or inserts HDL processes. They run in the simulator's
existing single-threaded observation points. Wall-clock overhead is expected;
these are development capture tools, not simulation performance benchmarks.

`CHIPSIM_DEBUG_STREAM` and `CHIPSIM_DEBUG_DESIGN` select dedicated JSONL files.
The normal runner clears both variables. Simulator stdout/stderr remains
independent diagnostics; HDL `$display`/`report` output cannot masquerade as
structured observer records. Protocol 1 uses `header`, `design`, `object`,
`edge`, `observe`, `event`, `limit`, `unsupported`, `end` and `design-end` records.
The normalizer rejects inconsistent IDs, widths, end counts and protocol versions.
A killed run may have one incomplete final JSONL line, which is discarded with
an incomplete status. Malformed complete records are errors.

See [the user and recording guide](../../docs/HDL_DEBUG.md) for capabilities,
limits and the independent stock-simulator/terminal acceptance tests.
