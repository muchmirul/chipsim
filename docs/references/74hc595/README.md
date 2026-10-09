# 74HC595 / 74HCT595

Reviewed shift/storage-register profile; no analog/timing model.

## Vendor PDFs

**Datasheet**

- [74HC595; 74HCT595 product data sheet](nexperia-74hc595.pdf) — Rev. 12, 20 March 2024; 21 PDF pages. Document ID: `74hc595-nexperia-74hc595`.

**Reference manual**

- [74HC595; 74HCT595 product data sheet](nexperia-74hc595.pdf) — Rev. 12, 20 March 2024; 21 PDF pages. Document ID: `74hc595-nexperia-74hc595`.

**Programming guide**

- [74HC595; 74HCT595 product data sheet](nexperia-74hc595.pdf) — Rev. 12, 20 March 2024; 21 PDF pages. Document ID: `74hc595-nexperia-74hc595`.

## Programming and debugging

No CPU or firmware. Supply data, shift/storage clocks, reset and output enable.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context 74hc595` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
