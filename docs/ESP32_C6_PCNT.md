# ESP32-C6 pulse-count experiment

Import the supplied ESP32-C6 Technical Reference Manual v1.2 (20 March 2026) to open **ESP32-C6 · PCNT channel 0**. Its exact fingerprint is pinned in `references/manifest.json`. The complete, unchanged 1,394-page manual is included with its original notices.

```sh
npm start -- --document docs/references/espressif-esp32-c6-trm.pdf
```

The original user-supplied copy works too:

```sh
npm start -- --document /home/dev/raspi/esp32-c6_technical_reference_manual_en.pdf
```

A fresh import also installs [GPIO output registers](ESP32_C6_GPIO.md); `o` selects between them.

PCNT opens **one PCNT unit, channel 0**, with channel 1 and filtering disabled. It does not run firmware or simulate the whole SoC. Matching and source checks run locally without an LLM.

## Inspect the demonstration

Press Space to play, `h/l` to step, or `t` to jump. `1` shows waveforms, `2` shows counting blocks, `3` shows events, `4` shows sources, `5` shows scope/evidence, and `6` shows registers.

| Tick             | Result                                               |
| ---------------- | ---------------------------------------------------- |
| 1–7, odd ticks   | Rising edges count up from 1 to 4.                   |
| 9                | Reaching +5 clears the count.                        |
| 11–17, odd ticks | Control high reverses counting: −1 through −4.       |
| 19               | Reaching −5 clears the count.                        |
| 21–23            | Pause ignores pulse edges.                           |
| 25               | The next rising edge counts after pause is released. |
| 27–29            | Clear holds the count at zero.                       |
| 31–33            | New rising edges count after clear is released.      |

`pulse_count` is a raw 16-bit two's-complement word: `0xFFFF` means −1. `negative` and `magnitude` show its signed meaning. At tick 13 they are 1 and 2, while raw storage is `0xFFFE`. `F` changes display format without moving the cursor; decimal raw storage is unsigned (65534 here).

`count_up`, `count_down`, `high_limit_hit` and `low_limit_hit` are one-tick tool observations, **not PCNT interrupt or status-register bits**.

## Configure an experiment

Press `p` for pre-run parameters. Integers accept decimal, `0x`, `0b` and `0o`.

| Parameter                               | Meaning                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `positive_mode`, `negative_mode`        | Rising/falling edge: 0/3 do nothing, 1 increments, 2 decrements.       |
| `control_low_mode`, `control_high_mode` | At that control level: 0 keeps, 1 reverses, 2/3 inhibit the operation. |
| `high_limit`                            | Positive limit, 1–32767; reaching it clears the count.                 |
| `low_limit_magnitude`                   | Negative-limit magnitude, 1–32768; 5 selects −5, raw `0xFFFB`.         |

Changing `control_high_mode` from 1 to 2 makes pulses at ticks 11–19 leave the cleared count at zero. Parameter edits start a new simulation; they are not writes to a running peripheral.

Use `7` to schedule `pulse`, `control`, `pause` and `clear`. Elsewhere, `i` drives an input at the cursor. Values hold until the next event. `U/R` undo/redo stimulus edits. `S` saves the experiment, `M` exports editable model JSON, `B` exports source text, and `x` exports CSV/JSON/VCD. `V` opens VCD in installed dwfv.

## Evidence and boundaries

Chapter 31 supplies channel structure (PDF page 1012), edge/control tables (1014–1015), the signed adder (1015), single-channel examples (1016), and field definitions (1020–1023). Evidence retains original one-based PDF pages.

The counter begins cleared with chosen configuration applied. Demonstration settings are not register reset defaults. Tick zero establishes pulse history without counting. Inputs are ideal, already-stable observations; control is sampled with the edge. Pulse history advances while paused or cleared, so release cannot replay an earlier edge. Clear dominates pause/counting. Helper registers expose intermediate calculations rather than a complete physical register map.

Excluded behavior includes channel 1, other units, filtering, GPIO routing, APB synchronization/clock timing, MMIO, interrupt/watchpoint enables and latches, zero modes, other thresholds, and live limit reconfiguration. Page 1015 describes delayed application of live limit changes; this profile uses static parameters only. It cannot verify interrupt service code, filter timing or full firmware.

Checks cover sixteen embedded cases, an independent literal mode-table oracle across all edge/control encodings and both initial pulse levels, signed boundaries, original-PDF provenance, terminal import/persistence/parameter edits, browser PDF.js agreement, and trace exports.
