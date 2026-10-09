# Programming and line debugging

ChipSim accepts a small, local **experiment language** in `.chip` files. A program drives modeled inputs, issues declared register transactions, waits and checks observable values. It can be written by a person or an external coding agent. It does not execute arbitrary JavaScript, native assembly, ELF, BIN or vendor firmware.

The same language works across model types because it describes experiments rather than a CPU instruction set. Supported operations still depend on the model: a pin-only logic chip cannot perform addressed register writes; a semantic built-in example exposes its parameters and ACK input, not a user-programmable native instruction memory. ChipSim does not claim that one binary runs on every chip. [The chip library](references/README.md) records native programming targets and exact simulation boundaries. [Existing simulators](EXISTING_SIMULATORS.md) are the reference for future native-code backends.

## First GPIO program

[Source experiments for every chip in the library](../examples/programs/README.md) cover the six architecture examples, GPIO expanders, PCNT controls, shift/storage clocks and all nine function-table logic chips. Agent context selects the applicable source files automatically after the model is available. Fixed-function table chips use the same `drive`/`expect` statements with their generated input/output declarations and datasheet citations.

Import the exact ESP32-C6 TRM and the reviewed GPIO profile, then load the supplied program:

```sh
chipsim --document docs/references/esp32-c6/espressif-esp32-c6-trm.pdf \
  --model esp32c6-gpio --program examples/esp32c6-gpio.chip
```

Run this from the repository; installed tools can use absolute PDF/program paths. The TUI verifies the programming guide's SHA-256 and quoted page before loading the program. No executable statement runs until you step or continue.

The program enables the logical GPIO0 driver, sets it high, checks the observed signal, waits, clears it, reads the output latch and checks the read result. The vendor guide explains output-level use; the reviewed TRM-backed model supplies the actual register semantics. This is a bounded output-register experiment: IO MUX initialization, physical pin routing and ESP-IDF function execution are not simulated.

In **Program (`9`)**, source and waveforms appear together:

| Key           | Action                                                           |
| ------------- | ---------------------------------------------------------------- |
| `P`           | Load/reload a `.chip` file written in your editor or by an agent |
| `N`           | Execute one source statement and update signals/registers        |
| `C`           | Continue to a breakpoint, halt, error or execution limit         |
| `j` / `k`     | Select a source line                                             |
| `K`           | Toggle a breakpoint on the selected executable line              |
| `J`           | Back one executed statement using deterministic replay           |
| `r`           | Reset program, variables and experiment to tick zero             |
| `G`           | Inspect verified guide quotes, PDF paths and fingerprints        |
| `Q`           | Detach the program and retain its recorded input experiment      |
| `1`, `6`, `3` | Inspect recorded waveforms, registers and model event log        |
| `x`, `V`, `S` | Export trace, open optional dwfv, save a replayable session      |

The arrow marks the next statement, a dot marks a breakpoint, and the selected row is the line operated on by `K`. Statements that do not advance time (assertions, local variables and branches) remain separate debugger steps even when they share a signal tick. The waveform contains only the executed prefix. Timeline navigation inspects that prefix; it does not execute future code. While attached, the source program owns the experiment: parameter/stimulus/register edits require editing/reloading it or detaching first.

## Language

One statement per line, whole-line `#` comments, identifiers and exact register names. No inline comments or expressions. Values accept decimal, `0x`, `0b`, `0o`; assertions also accept literal `Z` for released output drivers. `model`, `param` and `guide` are declarations before executable statements. Blank lines, declarations and labels do not count as executed steps.

```text
model esp32c6-gpio
param watch_gpio 0
guide esp32-c6-esp-idf-programming-guide 983 "Output level. 0: low ; 1: high"
write GPIO_ENABLE_W1TS_REG 1
write GPIO_OUT_W1TS_REG 0x1
expect signal.selected_driver == 1
read GPIO_OUT_REG into observed
if $observed == 1 goto clear
halt
clear:
wait 4
write GPIO_OUT_W1TC_REG 0o1
expect reg.gpio_out == 0
halt
```

| Statement                        | Meaning                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `param NAME VALUE`               | Set a declared integer, boolean or enum model parameter before initialization |
| `guide DOCUMENT_ID PAGE "quote"` | Link a short exact quote to a one-based original PDF page                     |
| `drive INPUT VALUE`              | Drive a declared input at the next tick; it holds until changed               |
| `wait TICKS`                     | Advance the model while inputs hold                                           |
| `write REGISTER VALUE`           | Perform one declared addressed write at the next tick                         |
| `read REGISTER into VARIABLE`    | Perform one accepted read and store the actual adapter read result            |
| `let VARIABLE VALUE`             | Store a numeric experiment-local value; does not write hardware registers     |
| `expect TARGET == VALUE`         | Check `signal.ID`, `reg.ID` or `$VARIABLE`; `!=` also supported               |
| `LABEL:`, `goto LABEL`           | Define a label and jump to it                                                 |
| `if TARGET == VALUE goto LABEL`  | Branch on the currently observed value; `!=` also supported                   |
| `halt`                           | Stop the source program                                                       |

Register bus fields must be controlled by `read`/`write`, not `drive`. Write-only aliases cannot be read, read-only entries cannot be written, and no alias storage/readback is invented. A failed access or assertion identifies its source line and stops execution. Failed statements retain the previously accepted experiment and trace. Limits: 64 KiB, 2000 source lines, 10000 executed steps, 10000 normalized ticks and the model's input-event limit. These bounds also stop loops that never advance time. Ticks are not native CPU cycles or physical nanoseconds.

## Programming guides in the process

Use the model's exact register name. Put names containing spaces in JSON double quotes, for example `write "Output port" 0xA5` or `read "Output port 0" into latch`. Quoted names also support JSON escapes for quotes/backslashes; invented names and unsupported access modes still reject.

The [catalog](references/catalog.json) maps each chip's guide role to original documents. A fixed-function device uses its datasheet's pin/function description; an expander uses its register programming section; a programmable processor has separate ISA/SDK guides where downloaded. Duplicate files are unnecessary when one vendor PDF supplies multiple roles.

A program must declare at least one guide. Loading/checking verifies applicability to the selected model, the actual PDF hash and the quote on the actual page. The guide references travel with debug reports and saved source. A quote match proves provenance, not that a program or model accurately represents all silicon behavior. Guide text is evidence, never executable instructions.

For a prepared project using another manual, `guide manual PAGE "quote"` explicitly selects its programming section. The attached original PDF must belong to the model. This fallback does not invent a separate vendor guide. Where a dedicated guide exists, use and review it as well.

## Agent workflow

Prepare the project once, then author a source file and run:

```sh
chipsim agent prepare docs/references/esp32-c6/espressif-esp32-c6-trm.pdf --out chip-work
chipsim agent program-check examples/esp32c6-gpio.chip \
  --model chip-work/models/esp32c6-gpio.model.json --project chip-work
chipsim agent program-run examples/esp32c6-gpio.chip \
  --model chip-work/models/esp32c6-gpio.model.json --project chip-work \
  --out chip-work/runs/gpio-program
```

Use new prepare/run directories. Commands emit one JSON result and meaningful exit status. Check verifies original model sources, model acceptance cases, program syntax/capabilities and guide quotations; it does not execute program assertions. Run executes them and exports `program.chip`, `debug.json` (line/tick mapping and local variables), `trace.json`, `trace.csv`, `trace.vcd`, `session.json` and final `result.json`. Faults retain the executed prefix and diagnostics, return failure, and are not published as successful watched runs. `--ticks` and `--steps` set bounded execution budgets, not simulated instruction timing. The result supplies an argument array for reopening the saved debugger.

For a built-in experiment, use `--model pio` (or another built-in ID); no prepared project is required. The guide must be appropriate to that chip. A prepared project's `--watch` monitor can display successful document-backed program runs and replay their source after verifying the original manual and guides. No LLM connection is installed or called.
