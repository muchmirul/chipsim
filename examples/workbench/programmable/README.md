# Fixed hardware with two finite control images

This original fixture loads four 8-bit words into `control_engine`. The same
RTL executes either `program.json` (add) or `second-program.json` (add/XOR).
Both independently produce the testbench's expected result of 10. The contract
declares instruction encodings, exact consecutive issue cycles, memory depth,
durations and finite ALU occupancy; `program-image` validates those declarations
and emits `out/program.hex` plus `out/program-validation.json`.

Copy this directory to a new project before editing. Use Node.js 22.13+, installed
Icarus observer tools for default debug capture, and Yosys for synthesis:

```sh
chipsim design doctor --project PROJECT --target simulation
chipsim design run --project PROJECT --target simulation --wait
chipsim design run --project PROJECT --target synthesis --wait
```

Replace `PROJECT` with the copied directory. For stock waveform-only execution,
explicitly set the simulate task's `options.debug` to false and declare the
waveform output instead of `out/debug.json`; do not claim a debug capture exists.
The `image` task's HEX output is bound into the simulator's `program.hex` asset.
Rejected encodings/resources stop downstream execution. Tests, RTL and contract
remain fixed when comparing the two programs; copy the second program over
`program.json` in a candidate, rerun, and compare actual run IDs/checks/artifacts.

Use `agent help` → `examples.programmable` to locate this installed starter.
MCP clients can read every starter file, including this README, from
`chipsim://examples/programmable/FILE` and author a project through file tools.
For exact tool schemas and connection routes read
[the installed connection guide](../../../docs/AGENT_CONNECTIONS.md) and
[workbench guide](../../../docs/WORKBENCH_MCP.md); those relative links refer to
the installed example, not a copied standalone project.

The synthesis target produces static Yosys JSON for `--netlist` or workbench
hardware/snapshot inspection. No layout, timing closure, generic CPU execution,
implicit scheduler or whole-design equivalence is claimed. Contract consistency
does not prove the hardware implements the contract; HDL assertions remain an
independent acceptance requirement.
