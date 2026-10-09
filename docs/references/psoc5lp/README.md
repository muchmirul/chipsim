# PSoC 5LP / UDB

Composed UDB teaching network; no fitter, routing compiler or Cortex-M3 firmware execution.

## Vendor PDFs

**Datasheet**

- [PSoC 5LP CY8C58LP Family Datasheet](datasheet.pdf) — 001-84932 Rev. *O; 11 December 2024; 140 PDF pages. Document ID: `psoc5lp-datasheet`.

**Reference manual**

- [PSoC 5LP Architecture TRM](infineon-psoc5lp-architecture-trm.pdf) — 001-78426 Rev. *G; 428 PDF pages. Document ID: `psoc5lp-infineon-psoc5lp-architecture-trm`.

**Programming guide**

- [PSoC Creator User Guide](creator-programming-guide.pdf) — 001-93417 Rev. *N; 587 PDF pages. Document ID: `psoc5lp-creator-programming-guide`.

## Programming and debugging

PSoC Creator hardware/datapath configuration plus Cortex-M3 firmware.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context psoc5lp` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
