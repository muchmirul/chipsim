# Guide-backed source experiments

These `.chip` files drive the existing ChipSim models and include verified vendor-guide page citations. They can be stepped, continued, paused at source breakpoints and replayed backward while viewing signals. Their comments state the modeled scope; the six architecture examples configure an existing teaching transfer rather than load native CPU instructions.

| Model         | Source                                         | What it checks                                                     |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| PIO           | [pio-transfer.chip](pio-transfer.chip)         | Payload, four/eight LSB-first samples and ACK                      |
| PRU           | [pru-transfer.chip](pru-transfer.chip)         | Same explicit transfer experiment through PRU's existing mechanism |
| FlexIO        | [flexio-transfer.chip](flexio-transfer.chip)   | Existing shifter/timer configuration and decoded payload           |
| UDB           | [udb-transfer.chip](udb-transfer.chip)         | Existing composed hardware scenario and decoded payload            |
| XMOS          | [xmos-transfer.chip](xmos-transfer.chip)       | Existing timed-port scenario and decoded payload                   |
| eTPU          | [etpu-transfer.chip](etpu-transfer.chip)       | Existing match/capture scenario and decoded payload                |
| TCA9534       | [tca9534-output.chip](tca9534-output.chip)     | Latch, direction, released/driven outputs and accepted read        |
| PCA9555       | [pca9555-output.chip](pca9555-output.chip)     | Port-0 latch, direction, outputs and accepted read                 |
| ESP32-C6 PCNT | [esp32c6-pcnt.chip](esp32c6-pcnt.chip)         | Rising counts, control reversal, pause and clear                   |
| 74HC595       | [hc595-shift.chip](hc595-shift.chip)           | Eight shifted bits, storage clock, output enable and release       |
| 74HC00        | [hc00-nand.chip](hc00-nand.chip)               | NAND input combinations and gate independence                      |
| 74HC86        | [hc86-xor.chip](hc86-xor.chip)                 | XOR input combinations and gate independence                       |
| 74HC157       | [hc157-select.chip](hc157-select.chip)         | Shared selection/enable and separate mux data paths                |
| 74HC377       | [hc377-enable.chip](hc377-enable.chip)         | Rising-edge capture and disabled retention                         |
| 74HC273       | [hc273-reset.chip](hc273-reset.chip)           | Capture, falling-edge retention and asynchronous reset             |
| SN74LVC1G125  | [lvc1g125-release.chip](lvc1g125-release.chip) | Data, release, disabled input changes and re-enable                |
| HD74HC77      | [hc77-retain.chip](hc77-retain.chip)           | One generic latch's transparency and retention                     |
| SN74AHC273-Q1 | [ahc273-clear.chip](ahc273-clear.chip)         | One generic flip-flop's capture, retention and clear               |
| HD74HC138     | [hc138-decode.chip](hc138-decode.chip)         | Active-low decoding, selection and disable/re-enable               |

The [GPIO source](../esp32c6-gpio.chip) checks ESP32-C6 output enable/set/clear/read. The machine-readable [catalog](catalog.json) is used by agent context to select applicable examples. New prepared projects copy the relevant sources into `examples/`; refreshed context also supplies installed absolute paths for older projects.

For a built-in example, run from the checkout:

```sh
chipsim agent program-check examples/programs/pio-transfer.chip --model pio
chipsim agent program-run examples/programs/pio-transfer.chip --model pio --out pio-first
chipsim --model pio-first/session.json --view program
```

For a document model, prepare its exact functional reference and use the returned model path. For example:

```sh
chipsim agent prepare docs/references/tca9534/ti-tca9534.pdf --out tca-work
chipsim agent context tca-work --model tca9534
chipsim agent program-check examples/programs/tca9534-output.chip --model tca-work/models/tca9534.model.json --project tca-work
chipsim agent program-run examples/programs/tca9534-output.chip --model tca-work/models/tca9534.model.json --project tca-work --out tca-work/runs/first
chipsim --document tca-work/manual.pdf --model tca-work/runs/first/session.json --view program
```

Every output directory must be new. In Program (`9`), `N` steps, `C` continues, `K` toggles a breakpoint at the selected line, `J` replays one step backward and `G` shows guide evidence. See [the language and debugging guide](../../docs/PROGRAMMING.md).

Function-table examples name the model generated from the exact pinned PDF revision. Prepare that PDF first; current context supplies its generated model ID, declared pins and applicable example. For example:

```sh
chipsim agent prepare docs/references/74hc00/nexperia-74hc00.pdf --out nand-work
chipsim agent context nand-work
chipsim --document nand-work/manual.pdf --program nand-work/examples/hc00-nand.chip --view program
```

The library supplies 20 source experiments across its 19 chip/family folders, including the separate GPIO example. These programs exercise the stated model scope. Generic latch/flip-flop tables do not imply package replication, and normalized clocks do not simulate setup/hold violations or analog timing.
