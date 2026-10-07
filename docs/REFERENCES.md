# Simulation references

This directory documents the official sources for the current six behavioral models. All eight PDFs are bundled in full and unchanged. The source mappings explain what each reference supports; the custom protocol and normalized timing remain ChipSim teaching assumptions.

Document revisions below come from document text, rather than PDF modification timestamps. PDF links use one-based viewer page numbers, which may differ from printed page labels. Retrieved on **2026-10-07**.

## RP2040 Datasheet

- **Model:** `pio`
- **Version:** Build 2025-02-20; 3184e62-clean
- **Publisher:** Raspberry Pi
- **File:** [rp2040-datasheet.pdf](references/rp2040-datasheet.pdf#page=312) (642 pages)
- **Official download:** [RP2040 Datasheet](https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf)
- **Read:** Chapter 3, especially 3.1-3.2 and 3.4-3.5.

**Supports:** Instruction memory, state machines, FIFOs, shifts, pin control, and instruction behavior.

**Model scope:** The model combines multiple instructions into semantic actions. FIFO delay, bounded polling, and normalized timing are model choices; WAIT alone is not a timeout.

## AM335x and AMIC110 Sitara Processors Technical Reference Manual

- **Model:** `pru`
- **Version:** SPRUH73Q; revised December 2019
- **Publisher:** Texas Instruments
- **File:** [ti-am335x-trm-spruh73q.pdf](references/ti-am335x-trm-spruh73q.pdf#page=208) (5,118 pages)
- **Official download:** [AM335x and AMIC110 Sitara Processors Technical Reference Manual](https://www.ti.com/lit/ug/spruh73q/spruh73q.pdf)
- **Read:** 4.4.1 PRU Cores; 4.4.1.2; Table 4-21.

**Supports:** PRU execution and the direct R30/R31 I/O paths.

**Model scope:** Only direct-output mode is modeled. Four ticks of unavailable firmware represent a teaching experiment; detailed instruction timing, bus arbitration, and optional shift-output hardware are outside scope.

## Using FlexIO to emulate communications and timing peripherals

- **Model:** `flexio`
- **Version:** AN12174, Rev. 0, June 2018
- **Publisher:** NXP
- **File:** [nxp-flexio-an12174.pdf](references/nxp-flexio-an12174.pdf#page=3) (46 pages)
- **Official download:** [Using FlexIO to emulate communications and timing peripherals](https://www.nxp.com/docs/en/application-note/AN12174.pdf)
- **Read:** 2 Overview of the FlexIO module; 4.1.1 transmit configuration.

**Supports:** Shifter/timer structure, triggers, and transfer configuration.

**Model scope:** The example uses a representative S32K144 resource budget. Register encodings, buffer aliases, and automatic framing are abstracted; custom ACK handling is host software.

## PSoC 5LP Architecture TRM

- **Model:** `udb`
- **Version:** 001-78426 Rev. *G
- **Publisher:** Cypress / Infineon
- **File:** [infineon-psoc5lp-architecture-trm.pdf](references/infineon-psoc5lp-architecture-trm.pdf#page=165) (428 pages)
- **Official download:** [PSoC 5LP Architecture TRM](https://www.infineon.com/assets/row/public/documents/30/57/infineon-psoc5lp-architecture-trm-additionaltechnicalinformation-en.pdf)
- **Read:** 21 Universal Digital Blocks; 22 UDB Array and Digital System Interconnect.

**Supports:** PLDs, datapaths, configuration stores, and routing.

**Model scope:** The design is a composed UDB network, not a claim that the complete link fits one UDB. Fitting, propagation delay, and exact clock distribution are abstracted.

## The XMOS XS3 Architecture

- **Model:** `xmos`
- **Version:** XM-014007-PS v2.1.0, 2025-03-06
- **Publisher:** XMOS
- **File:** [xmos-xs3-architecture.pdf](references/xmos-xs3-architecture.pdf#page=18) (343 pages)
- **Official download:** [The XMOS XS3 Architecture](https://www.xmos.com/documentation/XM-014007-PS/pdf/XM-014007-PS-xs3-arch-inst-2.1.0.pdf)
- **Read:** 3 Concurrent Threads; 5 Instruction Issue and Execution; 10 Resources and the Thread Scheduler; 14 Timers; 15 Ports, Input and Output; 17 Events.

**Supports:** Execution sharing, resource-driven scheduling, timed ports, timers, and event handling.

**Model scope:** The model allows one pending unbuffered timed write. Displayed CLK is a data bit, distinct from the underlying port clock. Time domains and counter wrap are abstracted.

## AN03001: XCORE Clocked Input and Output

- **Model:** `xmos`
- **Version:** XM-015254-AN v1.0.0, 2025-03-11
- **Publisher:** XMOS
- **File:** [xmos-clocked-io-an03001.pdf](references/xmos-clocked-io-an03001.pdf#page=6) (9 pages)
- **Official download:** [AN03001: XCORE Clocked Input and Output](https://www.xmos.com/documentation/XM-015254-AN/pdf/AN03001_v1.0.0.pdf)
- **Read:** 1 Generating a Clock Signal; 3 Performing I/O on Specific Clock Edges; 5 Summary of Clocked Port Behavior.

**Supports:** Port clock configuration and I/O timing conditions.

**Model scope:** This supports the port timing explanation; it is not the executable implementation of ChipSim's DATA/CLK/ACK recipe.

## Understanding the eTPU Channel Hardware

- **Model:** `etpu`
- **Version:** AN2933, Rev. 0, December 2004
- **Publisher:** Freescale / NXP
- **File:** [nxp-etpu-channel-hardware-an2933.pdf](references/nxp-etpu-channel-hardware-an2933.pdf#page=3) (40 pages)
- **Official download:** [Understanding the eTPU Channel Hardware](https://www.nxp.com/docs/en/user-guide/AN2933.pdf)
- **Read:** 2 Architecture of the eTPU Channel; 5.1-5.3.

**Supports:** Match/capture action units, pin actions, recognition control, event latches, and servicing.

**Model scope:** CLK rearming is modeled with two slots. Separate DATA-channel preparation is assumed timely. A missed required CLK target ends the demonstration rather than predicting every later hardware effect.

## The Essentials of Enhanced Time Processing Unit

- **Model:** `etpu`
- **Version:** AN2353, Rev. 1, August 2004
- **Publisher:** Freescale / NXP
- **File:** [nxp-etpu-essentials-an2353.pdf](references/nxp-etpu-essentials-an2353.pdf#page=3) (12 pages)
- **Official download:** [The Essentials of Enhanced Time Processing Unit](https://www.nxp.com/docs/en/user-guide/AN2353.pdf)
- **Read:** 3 Channel Hardware; 4 Memory; 5 The Microengine.

**Supports:** Shared microengine, memory, channels, and hardware-assisted timing.

**Model scope:** ACK capture is evaluated by its timestamp, with a model-defined two-tick service delay. These timing constants are teaching assumptions, not device latency specifications.

## File integrity

Exact sizes and SHA-256 checksums are recorded in [manifest.json](references/manifest.json). Run `node scripts/verify.mjs` from the repository root to check the local copies. The bundled PDFs are reference material; collecting them does not certify that every behavior in the simulation matches hardware.
