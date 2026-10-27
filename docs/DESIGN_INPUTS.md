# Starting a chip project: files and agent preparation

ChipSim can start with an idea, existing RTL, a testbench, firmware, a manual, or
a recorded waveform. **You do not need to supply all file types.** Select a
useful goal and prepare only its prerequisites. These are optional recipes, not
a mandatory sequence or a new validation gate.

Agents can discover this knowledge without a project or installed EDA tools:

```sh
chipsim design guide
chipsim design guide rtl
chipsim design guide testbench
chipsim design guide firmware
chipsim design commands
```

Through the general agent tool, use
`chipsim_command({args:["design","guide","rtl"]})`. The result is a versioned
JSON guide with input roles, `whenMissing` preparation advice, tool requirements,
outputs, limitations and absolute paths to installed examples/documentation.
Other topics are `waveform`, `registers`, `formal`, `physical` and `model`.
The command reads no project, writes nothing and launches no tools.

## What the file extensions mean

| File                   | Role in ChipSim                                                            | What else is needed                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.csv` | Authored register maps or timed model stimulus | `table registers` requires width/order; `--inputs` validates tick/signal/value against a model. No PDF required; see [CSV_INPUTS.md](CSV_INPUTS.md). |
| `.v`, `.sv`            | Verilog/SystemVerilog hardware or HDL testbench source                     | For simulation: a harness, source manifest, top and compatible simulator. For synthesis: synthesizable RTL, DUT top and flow constraints.                              |
| `.vhd`, `.vhdl`        | VHDL hardware/testbench through GHDL                                       | HDL manifest and a suitable harness. The supplied physical flow consumes Verilog-compatible RTL/netlists.                                                              |
| `.vcd`                 | Recorded digital signal values; direct import/replay and simulation output | Only the file to inspect it. It cannot rerun or reconstruct the full design. Supported signal types/limits are in [HDL.md](HDL.md).                                    |
| `.asm`                 | Assembly whose ISA and dialect depend on the toolchain                     | A selected CPU, compatible assembler, memory map and execution harness. Use an explicit `command` task; the firmware adapter does **not** automatically select `.asm`. |
| `.s`, `.S`, `.c`       | Firmware sources selected by the `firmware` adapter                        | Matching cross GCC/objcopy, linker layout/startup and CPU RTL or emulator platform. `.S` uses the compiler's preprocessed assembly convention.                         |
| `.py` + `Makefile`     | A cocotb testbench and its simulator configuration                         | DUT HDL, cocotb, make and the selected simulator. Produces xUnit results and any configured waveform.                                                                  |
| `.chip`                | ChipSim behavioral experiment script                                       | A supported model and any required source/guide evidence; this is not CPU assembly.                                                                                    |
| `.elf`, `.bin`, `.hex` | Compiled firmware/image artifacts                                          | A matching loader/platform; image addresses, word width and endianness must agree. Not a universal direct input to the TUI.                                            |

An ordinary fixed-function block needs no assembly. A VCD is normally an
**output** of simulation, so do not ask the user to provide one before running
new RTL. A PDF is optional for original hardware design; it is required where
the chosen document-backed model/source-verification workflow needs it.

## Digital timing experiments

For finite delay, jitter or glitches, add an inline `environment` profile to a
SystemVerilog HDL manifest and wire `chipsim_environment.disturbed` into the DUT.
The profile alone does not connect signals or create clock/reset. See the
[environment guide](HDL_ENVIRONMENT.md) and
[examples](../examples/hdl/environment/README.md). Run again after each edit;
inspect actual DUT samples and `environment.json`, not only nominal events.
These are declared binary test conditions, not measured physical behavior.

## Smallest useful RTL start

The shipped [minimal counter](../examples/design/minimal) contains:

```text
my-chip/
  counter.v              hardware: 4-bit counter with reset and enable
  counter_tb.v           stimulus, expected results, VCD dumping, end/timeout
  sim.project.json       ordered source files, standard and testbench top
  chipsim.design.json    simulation task and required checks
  chipsim.lock.json      external dependency declarations (empty here)
```

The **first three files** suffice for a standalone HDL run. DUT and testbench
may share one source file, but separate files are easier to reuse. The last two
add managed jobs, input snapshots and artifact/check history. The example needs
Node.js 22.13+ and the [Icarus observer tools](HDL_DEBUG.md) for default debug
capture; it needs no PDF, firmware, PDK, formal tool or physical-design installation.
For stock Icarus (`iverilog`, `vvp`) waveform-only runs, use `--no-debug` on
`hdl run`, or set the managed task's `options.debug` to `false`. Missing observer
tools never silently downgrade a debug run.

From a checkout, copy the example into a new directory:

```sh
cp -R examples/design/minimal ../my-chip
chipsim design doctor --project ../my-chip --target simulation
chipsim design run --project ../my-chip --target simulation
chipsim --design ../my-chip
```

For an installed package, `design guide rtl` returns the actual
`guide.starter.directory` and file list. The agent can copy those files to a
new directory using its file tools. Adapt the design and expectations to the
user's requested behavior; the counter is an illustrative example, not an
implementation of every requested chip. Keep a small specification of intended
interfaces, clock/reset and behavior, with unresolved choices identified.

Alternatively, run just the source manifest, then open its linked debug recording:

```sh
chipsim hdl run ../my-chip/sim.project.json --out ../my-chip-first-run
chipsim --hdl-debug ../my-chip-first-run/debug.json
```

`design init NEW_PROJECT` creates only the two design manifests. The agent must
prepare `sim.project.json`, RTL and a testbench before running that default
target. It may use the three simulation files from this example as a starting
point. Existing files must not be overwritten to install a template.

The testbench checks reset, increment, disabled hold, 4-bit wrap and reset
priority. It drives controls away from the sampled edge, checks after sequential
updates, calls `$fatal` on failure, writes `trace.vcd` with
`$dumpfile`/`$dumpvars`, and finishes within a simulation timeout. A printed
error alone may not fail a simulator. Simulation uses `counter_tb` as top;
synthesis would use `counter` and exclude the testbench.

## Prepare missing inputs instead of requiring all outputs upfront

An agent can adapt the following approach to the task:

1. Read the intent and inventory existing files, manifests, installed tools and
   previous results. Pick a useful target; reuse working project structure.
2. Separate source inputs from generated dependencies and optional outputs.
   Identify what is present, what can be authored/generated, what must be found
   externally and any material unknowns that need an answer.
3. Create missing RTL, testbench, configuration or startup/linker files within
   the requested design scope. Derive test expectations from the specification,
   not from the observed output of the DUT. Record illustrative choices as
   assumptions. Do not silently guess a vendor ISA, register map or reset rule.
4. Search local files and installed examples before obtaining upstream IP or
   tool/PDK assets. Use compatible sources, retain licenses/provenance and pin
   revisions. Follow the agent's existing installation permissions. ChipSim's
   guide does not install anything or change agent/provider settings.
5. For a missing generated file, prepare its **producer**, then bind its output
   to the consumer. Declare every consumed source, header, Python helper, vector
   and configuration; lock external dependencies. Do not create a placeholder
   waveform, firmware image, proof, report or PDK file to make checks pass.
6. Once prerequisites exist, probe tools, run the selected target and inspect
   real results. Preserve failure logs and traces, repair the cause, and run
   again with changed inputs. Report actual scope and unresolved gaps.

For example, no `firmware.hex` yet means compile the program first and bind
`out/firmware.hex` into the HDL task's `firmware.hex` asset. No generated register
RTL means prepare a SystemRDL task and bind its `.sv` result. These dependencies
belong in the artifact graph; users need not upload generated files manually.
See [bindings and captured inputs](DESIGN.md#project-contract).

The agent should continue useful preparation before reporting a blocker. Ask
for material design decisions that cannot be resolved from context, such as the
required ISA or interface. Having no VCD yet is normal, not a blocker. Existing
ChipSim source verification, job execution and evidence rules still apply; this
guide adds no mandatory workflow stages.

## Inputs for optional development paths

| Goal                            | Minimum useful inputs                                                         | Prepare if absent                                                             | Produced evidence                                                               |
| ------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Inspect signals                 | Supported VCD or ChipSim waveform JSON                                        | Find original output, or run a real simulation                                | Imported waveform and terminal view; original provenance may be unknown         |
| Simulate RTL                    | DUT + HDL harness + source manifest                                           | Author ports/behavior and bounded independently checked stimulus              | Simulator logs, VCD, waveform JSON; managed checks when using a design task     |
| Python regression               | DUT + Python tests + cocotb Makefile/task                                     | Configure DUT top, simulator, test module and any helpers/vectors             | xUnit per-test checks; configured waveform                                      |
| Generate registers / set up IP  | `.rdl`, or `.core` and declared dependencies                                  | Define register behavior or obtain/pin compatible licensed IP                 | RTL/header/IP-XACT/register metadata, or EDAM/scripts; FuseSoC setup only       |
| Formal properties / equivalence | RTL/properties + `.sby`, or gold/gate RTL + `.eqy`                            | Define justified assumptions; generate the second implementation if needed    | Scoped proof status/logs and available counterexamples                          |
| Firmware on a SoC               | CPU/platform + ISA/ABI/memory map + program/startup + linker script + harness | Select/build the CPU system, compile code, bind ELF/HEX into its loader       | ELF/map/BIN/HEX plus execution logs, checked MMIO results and configured traces |
| Physical implementation         | Synthesizable RTL/top + `config.mk` + SDC + compatible locked flow/PDK/decks  | Prepare real constraints and acquire/install compatible assets                | Netlist, ODB/DEF/SPEF/GDS, metrics and DRC/LVS reports                          |
| Document-backed model           | Searchable manual + bounded sourced model; optional `.chip`                   | Extract/search sources, author missing model and independent acceptance cases | Verified sources, traces, checks and session                                    |

The [peripheral fixture](../examples/design/peripheral) includes HDL and cocotb
testbenches, generation, formal and physical targets. The
[SoC fixture](../examples/design/soc) includes PicoRV32, RV32I startup/C/linker
files and a firmware-checking RTL testbench. It also demonstrates a separate
Renode software platform; RTL co-simulation requires a project-supplied bridge.
The [adapter table](DESIGN.md#adapters-and-native-files) and `design commands` describe
native file boundaries for every integration.

Plain HDL checks currently report simulation status and retain native logs;
cocotb xUnit adds structured per-test outcomes. Seeds and coverage can be inputs
and reports in explicit project tasks, but ChipSim does not yet supply a native
seed-matrix runner, merged functional-coverage dashboard or verification-plan
manager. A simulation pass proves only the exercised checks. Formal results have
their declared scope, and GDS production alone is not physical verification or
foundry signoff.
