# TCA9534

One-bank completed-byte GPIO/interrupt model; no physical I2C serialization.

## Vendor PDFs

**Datasheet**

- [TCA9534 Low Voltage 8-Bit I2C and SMBUS Low-Power I/O Expander with Interrupt Output and Configuration Registers](ti-tca9534.pdf) — SCPS197D, revised October 2017; complete official download with 2026 notices/package addendum; 42 PDF pages. Document ID: `tca9534-ti-tca9534`.

**Reference manual**

- [TCA9534 Low Voltage 8-Bit I2C and SMBUS Low-Power I/O Expander with Interrupt Output and Configuration Registers](ti-tca9534.pdf) — SCPS197D, revised October 2017; complete official download with 2026 notices/package addendum; 42 PDF pages. Document ID: `tca9534-ti-tca9534`.

**Programming guide**

- [TCA9534 Low Voltage 8-Bit I2C and SMBUS Low-Power I/O Expander with Interrupt Output and Configuration Registers](ti-tca9534.pdf) — SCPS197D, revised October 2017; complete official download with 2026 notices/package addendum; 42 PDF pages. Document ID: `tca9534-ti-tca9534`.

## Programming and debugging

No CPU. Program its register interface using host transactions.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context tca9534` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
