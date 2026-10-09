# RP2040 / PIO

One original semantic PIO transfer example; no custom native instruction loader yet.

## Vendor PDFs

**Datasheet**

- [RP2040 Datasheet](rp2040-datasheet.pdf) — Build 2025-02-20; 3184e62-clean; 642 PDF pages. Document ID: `rp2040-rp2040-datasheet`.

**Reference manual**

- [RP2040 Datasheet](rp2040-datasheet.pdf) — Build 2025-02-20; 3184e62-clean; 642 PDF pages. Document ID: `rp2040-rp2040-datasheet`.

**Programming guide**

- [Raspberry Pi Pico C/C++ SDK](pico-c-sdk.pdf) — Build 2026-09-10; ea68919-clean; 828 PDF pages. Document ID: `rp2040-pico-c-sdk`.

## Programming and debugging

PIO assembly; Arm Thumb firmware requires a separate CPU backend.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context rp2040` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
