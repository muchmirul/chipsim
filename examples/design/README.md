# Artifact graph integration fixtures

`minimal` is a five-file counter project with a self-checking Verilog testbench.
It needs only Icarus (`iverilog`/`vvp`) for simulation. Copy it to a new directory
and adapt the RTL/tests. `chipsim design guide rtl` discovers its installed path;
the [input guide](../../docs/DESIGN_INPUTS.md) explains each file and optional
next stages. No preexisting waveform, firmware or PDK is required.

`peripheral` is a two-word scratch register design with independent reset,
write, hold and readback tests. Icarus runs it without additional EDA tools:

```sh
chipsim design run --project examples/design/peripheral --target simulation --wait
chipsim --design examples/design/peripheral
```

The `debugging` target needs the pinned ChipSim observer build. `generation`
needs PeakRDL and FuseSoC. `verification` adds Verilator/cocotb, Yosys, SBY with
Z3, and EQY. The RDL generator is exercised separately from the hand-authored
peripheral; no equivalence between those implementations is claimed.

`asic` uses SKY130 HD through a locally installed ORFS. Set `physical.options.flow`
to that installation's `flow` directory and record its platform/flow dependency
digests in `chipsim.lock.json`. It requests `finish`, `drc` and `lvs`, then checks
the configured final metrics, KLayout DRC report and LVS database. Missing decks,
unsupported reports or incomplete comparisons block readiness. Timing covers the
reported constrained paths at the typical corner; other corners and constraint
coverage remain outside this fixture. A produced GDS does not satisfy the policy
by itself. See [physical checks](../../docs/DESIGN.md#physical-report-checks).

`physical-inspection` additionally requires OpenROAD-MCP 1.1.0 on PATH. It binds
the physical task's ODB into a finite session, reads the database, queries design
area and saves an inspected ODB. Its policy checks the MCP session and outputs;
use `asic` to evaluate the timing/DRC/LVS policy. Lock the server installation
and dependencies for `inspect-physical` as well as the ORFS/PDK installation.

`soc` compiles a freestanding RV32I program, binds its byte-oriented Verilog
memory image into an Icarus PicoRV32 simulation, and checks the actual MMIO
results on EBREAK. It requires `riscv64-unknown-elf-gcc` and its `objcopy`.
The Renode `software` target uses the same ELF with a separately declared memory
platform; it does not claim timing equivalence to the PicoRV32 RTL simulation.
It records the two observed words in the log; `renode:execution` checks only
process completion. Project-specific co-simulation uses a compiled Renode HDL
bridge declared as another input/binding.

PicoRV32 is copied unchanged from YosysHQ/picorv32 commit
`ef203c2b0a3fb793280f5114941416c425c5b461`, file `picorv32.v`, SHA-256
`0836050971b3c6cdd28ac3b1e5719a67fb645161912bef1e472e63995ceb0622`.
Source: https://github.com/YosysHQ/picorv32/blob/ef203c2b0a3fb793280f5114941416c425c5b461/picorv32.v
The ISC permission and copyright notice remain at the top of the file.
The surrounding ChipSim fixture is illustrative and has no silicon fidelity claim.
