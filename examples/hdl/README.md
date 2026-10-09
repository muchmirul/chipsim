# Open-source HDL examples

The unmodified `upstream/adder.sv` and `upstream/adder.vhdl` are cocotb examples, each explicitly released as **CC0-1.0**. [provenance.json](upstream/provenance.json) records the pinned upstream revision, original URLs and SHA-256 hashes. Their original notices remain intact. The ChipSim testbenches and reference script are also CC0-1.0.

Both testbenches exercise every pair of four-bit inputs (256 cases), independently assert the five-bit sum, and record a clock, edge counter, mixed `10XZ` word and NAND probes. Inputs change every 5 ns. Source signals have different names in the two simulators; the supplied mapping makes these names explicit.

From the repository checkout, with Icarus Verilog and GHDL on PATH:

```sh
node scripts/chipsim.mjs hdl run examples/hdl/adder-verilog.project.json --out tmp/hdl-verilog
node scripts/chipsim.mjs hdl run examples/hdl/adder-vhdl.project.json --out tmp/hdl-vhdl
node scripts/chipsim.mjs --vcd tmp/hdl-verilog/trace.vcd
node scripts/chipsim.mjs hdl compare tmp/hdl-verilog/trace.vcd tmp/hdl-vhdl/trace.vcd --map examples/hdl/adder-compare.json --out tmp/hdl-comparison
```

Choose unused output directories on subsequent runs. Each run copies its sources and records hashes, backend versions, compiler/simulator diagnostics and waveform artifacts. Open `waveform.json` to retain run provenance; the raw VCD contains dumped signal values and simulator time.

The comparison checks 256 points, at 5 ns intervals from 0 through 1275 ns, including input buses, sum, edge count, NAND output and mixed logic. It does not check changes between those points. The explicit end is needed because Icarus and GHDL do not necessarily dump the same final timestamp at testbench termination.

## Compare HDL with a ChipSim behavior model

The NAND probes expose both inputs and the output as one-bit signals. The reference script extracts the actual bundled Nexperia 74HC00 datasheet, compiles its function table, verifies citations/acceptance cases, drives the same NAND inputs, and exports a ChipSim trace and timing/mapping file. Poppler is required for this step.

```sh
node examples/hdl/nand-reference.mjs tmp/hdl-nand-reference
node scripts/chipsim.mjs hdl compare tmp/hdl-verilog/trace.vcd tmp/hdl-nand-reference/trace.json --map tmp/hdl-nand-reference/mapping.json
node scripts/chipsim.mjs hdl compare tmp/hdl-vhdl/trace.vcd tmp/hdl-nand-reference/trace.json --map tmp/hdl-nand-reference/mapping.json
```

Here one abstract model tick is explicitly assigned 5 ns **for the comparison experiment**. The model itself still represents ideal NAND table behavior, without electrical delays. This comparison says nothing about a whole chip or physical timing accuracy.

Run `npm run test:hdl` for both real simulators, independent arithmetic expectations, the datasheet-model comparison, injected discrepancies/failures, and terminal interaction. The test requires both backends and fails if either is missing.
