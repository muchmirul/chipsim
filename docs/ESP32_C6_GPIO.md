# ESP32-C6 GPIO output experiment

The supplied ESP32-C6 TRM v1.2 now supplies two reviewed simulations: PCNT channel 0 and GPIO output registers. Both use the same unchanged PDF and run locally without an LLM.

```sh
npm start -- --document /home/dev/raspi/esp32-c6_technical_reference_manual_en.pdf
```

A fresh import opens PCNT first. Press `o`, select **ESP32-C6 · GPIO output registers**, then Enter. If the manual was imported before GPIO support was added, press `o` → **Find supported simulations in saved PDF**, review the GPIO scope, and select it. Existing models and experiments are preserved.

## Register experiments

The scenario assumes the simple GPIO output path is already configured: `GPIO_FUNCn_OUT_SEL = 128`, GPIO IO MUX routing, push-pull output, no output/enable inversion and no other controller or hold override. It exposes the two 31-bit latches through 32-bit word transactions. Addresses below are **byte offsets relative to GPIO**, not CPU addresses.

| Offset   | Register               | Mode in this adapter | Effect                                                 |
| -------- | ---------------------- | -------------------- | ------------------------------------------------------ |
| `0x0004` | `GPIO_OUT_REG`         | Read/write           | Replace output bits 0–30; reads return retained latch. |
| `0x0008` | `GPIO_OUT_W1TS_REG`    | Write action         | Written ones set output bits.                          |
| `0x000C` | `GPIO_OUT_W1TC_REG`    | Write action         | Written ones clear output bits.                        |
| `0x0020` | `GPIO_ENABLE_REG`      | Read/write           | Replace output-enable bits; one drives, zero releases. |
| `0x0024` | `GPIO_ENABLE_W1TS_REG` | Write action         | Written ones enable outputs.                           |
| `0x0028` | `GPIO_ENABLE_W1TC_REG` | Write action         | Written ones disable outputs.                          |

Set/clear writes leave bits with a zero in the written mask unchanged. They act directly on the current latch without a separate read/modify/write transaction. The model executes one completed access per request-token change after tick zero; it does not model concurrent CPUs or bus timing.

Press `u` to select an address, then Read or Write. Write inputs accept decimal, `0x`, `0b` and `0o` (for example `179`, `0xB3`, `0b10110011`, `0o263`). The access occurs at the next tick; later scheduled transactions retain their original data/address/operation. `U/R` undo/redo the inserted transaction.

`6` shows canonical latch values and bus observations. `1` shows waveforms, `3` the transaction log, and `5` the full scope and source evidence. `F` changes the display base. `p` → **Observe logical GPIO bit** selects `watch_gpio` from 0 through 30. The `selected_driver` trace is `0`, `1` or `Z` (released). The full `output_latch` and `enable_mask` words remain visible regardless of the selected bit.

Write-trigger aliases have no displayed readback value and offer only Write in the menu. Their read behavior is outside this profile. Manually scheduled reads to them, and accesses to all other offsets, produce a tool error without changing the latches or last successful read value. This is not a claim about silicon bus faults. Writes to bit 31 are discarded and canonical read bit 31 is normalized to zero in the model; the manual calls it invalid and does not guarantee a hardware read value.

## Demonstration

| Tick    | Result                                                          |
| ------- | --------------------------------------------------------------- |
| 0       | OUT and ENABLE are zero; selected driver is released.           |
| 2       | OUT becomes `0xB3` (179); outputs remain disabled.              |
| 4       | ENABLE becomes `0x0F`; driver 0 drives one.                     |
| 6 / 8   | Set bit 8 in OUT / ENABLE, preserving the other bits.           |
| 10      | Clear OUT bits 0–1; OUT is `0x1B0` (432), driver 0 drives zero. |
| 12      | Clear ENABLE bit 0; driver 0 releases, ENABLE is `0x10E` (270). |
| 14 / 16 | Read OUT / ENABLE into `read_data`.                             |
| 18      | Write zero to OUT_W1TS; no latch change.                        |
| 20      | Scenario reset restores the two zero defaults.                  |

`S` saves an experiment; `M` exports its model; `x` exports CSV/JSON/VCD; `V` opens the VCD in an installed dwfv. For a noninteractive model export, select the peripheral explicitly:

```sh
npm run document -- docs/references/espressif-esp32-c6-trm.pdf --model esp32c6-gpio --out gpio.model.json
npm run model -- simulate gpio.model.json --ticks 24 --format vcd --out gpio.vcd
```

## Source and boundaries

Chapter 7, pages 250–251 and 280, defines output routing. Pages 270–273 define the six offsets, latch defaults and mask effects. Page 244 describes package restrictions. Citations use original one-based PDF pages and are verified against the pinned document fingerprint before compilation. Sixteen embedded checks and an independent BigInt oracle cover word masks, all 31 selectable logical bits, held requests, reset and rejected accesses; terminal/browser and trace-export checks exercise the complete import workflow.

Logical GPIO numbers do not guarantee available package pins. GPIO14 is unavailable on variants without in-package flash; variants with in-package flash reserve GPIO24–30 for flash and do not expose GPIO10–11. This simulation makes no package or board connection claim.

Input paths/`GPIO_IN`, interrupts, ETM, open drain, LP GPIO, matrix/IO MUX programming, sleep/hold, pulls, contention, electrical loading, CPU execution and APB timing are excluded. The `reset` input is a scenario operation that restores the two latch defaults while keeping routing preconditions; it is not a physical reset pin or complete reset-domain sequence. Tick zero establishes request history and does not perform an access. `valid`/`error` describe the tool adapter, not hardware status bits. `read_data` holds the last successful read until reset.
