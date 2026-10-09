# S32K144 / FlexIO

Shifter/timer teaching scenario; arbitrary FlexIO register configurations are not yet executable.

## Vendor PDFs

**Datasheet**

- [S32K1xx Data Sheet](datasheet.pdf) — Rev. 15; 5 March 2026; 108 PDF pages. Document ID: `s32k144-datasheet`.

**Reference manual**

- [S32K1xx Series Reference Manual](reference-manual-rev13.pdf) — S32K1XXRM Rev. 13; April 2020 (archived vendor-community copy); 2179 PDF pages. Document ID: `s32k144-reference-manual`.
  Public archive on NXP Community. Rev. 14.2 is listed as account-required by the current NXP product page. No new behavior is compiled from this revision.

**Programming guide**

- [Using FlexIO to emulate communications and timing peripherals](nxp-flexio-an12174.pdf) — AN12174, Rev. 0, June 2018; 46 PDF pages. Document ID: `s32k144-nxp-flexio-an12174`.

**Application notes**

- [Using FlexIO to emulate communications and timing peripherals](nxp-flexio-an12174.pdf) — AN12174, Rev. 0, June 2018; 46 PDF pages. Document ID: `s32k144-nxp-flexio-an12174`.

## Programming and debugging

C/C++ host firmware configures FlexIO registers; FlexIO itself has no CPU instruction stream.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context s32k144` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
