# eTPU (MPC5554 as a device reference)

Match/capture channel teaching example; no eTPU microcode execution.

## Vendor PDFs

**Datasheet**

- [MPC5554 Microcontroller Data Sheet](mpc5554-datasheet.pdf) — MPC5554 Rev. 4; May 2012; 58 PDF pages. Document ID: `etpu-mpc5554-datasheet`.

**Programming guide**

- [Understanding the eTPU Channel Hardware](nxp-etpu-channel-hardware-an2933.pdf) — AN2933, Rev. 0, December 2004; 40 PDF pages. Document ID: `etpu-nxp-etpu-channel-hardware-an2933`.
- [The Essentials of Enhanced Time Processing Unit](nxp-etpu-essentials-an2353.pdf) — AN2353, Rev. 1, August 2004; 12 PDF pages. Document ID: `etpu-nxp-etpu-essentials-an2353`.
- [Programming the eTPU](programming-guide-an2848.pdf) — AN2848 Rev. 1; August 2008; 14 PDF pages. Document ID: `etpu-programming-guide`.
  Official NXP cache download; public AN2848 listed on the eTPU Archive page.

**Application notes**

- [Understanding the eTPU Channel Hardware](nxp-etpu-channel-hardware-an2933.pdf) — AN2933, Rev. 0, December 2004; 40 PDF pages. Document ID: `etpu-nxp-etpu-channel-hardware-an2933`.
- [The Essentials of Enhanced Time Processing Unit](nxp-etpu-essentials-an2353.pdf) — AN2353, Rev. 1, August 2004; 12 PDF pages. Document ID: `etpu-nxp-etpu-essentials-an2353`.
- [Programming the eTPU](programming-guide-an2848.pdf) — AN2848 Rev. 1; August 2008; 14 PDF pages. Document ID: `etpu-programming-guide`.
  Official NXP cache download; public AN2848 listed on the eTPU Archive page.

## Programming and debugging

eTPU C compiled to microengine code; host Power Architecture firmware is a separate target.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context etpu` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

## Skipped download

- The full Enhanced Time Processing Unit Reference Manual (ETPURM) is skipped at the user's request. NXP lists it as account-required on the [eTPU archive](https://www.nxp.com/products/eTPUArchive#documentation). It is not bundled.

The public application notes above support the existing teaching model; they do not replace a full reference manual.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
