# AM335x / PRU

Direct R30/R31 semantic transfer example; not a full PRU ISA or AM335x emulator.

## Vendor PDFs

**Datasheet**

- [AM335x Sitara Processors Datasheet](datasheet.pdf) — SPRS717L; revised March 2020; 264 PDF pages. Document ID: `am335x-datasheet`.

**Reference manual**

- [AM335x and AMIC110 Sitara Processors Technical Reference Manual](ti-am335x-trm-spruh73q.pdf) — SPRUH73Q; revised December 2019; 5118 PDF pages. Document ID: `am335x-ti-am335x-trm-spruh73q`.

**Programming guide**

- [PRU Assembly Instruction User Guide](pru-programming-guide.pdf) — SPRUIJ2; April 2018; 50 PDF pages. Document ID: `am335x-pru-programming-guide`.

## Programming and debugging

PRU assembly; Arm firmware is a different execution target.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context am335x` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
