# XMOS xCORE / XS3

One timed-port teaching scenario; no XE executable loading or native ISA backend.

## Vendor PDFs

**Datasheet**

- [xcore.ai Datasheet XU316-1024-QF60B](xu316-1024-qf60b-datasheet.pdf) — XM-014429-PC v2.0.0; 13 January 2025; 86 PDF pages. Document ID: `xcore-xs3-datasheet`.
  Official current documentation PDF endpoint. This exact package remains a context reference for the semantic timed-port example.

**Reference manual**

- [The XMOS XS3 Architecture](xmos-xs3-architecture.pdf) — XM-014007-PS v2.1.0, 2025-03-06; 343 PDF pages. Document ID: `xcore-xs3-xmos-xs3-architecture`.

**Programming guide**

- [XMOS XTC Tools Guide 15.3](xtc-programming-guide.pdf) — XM-014363-PC v15.3; 29 April 2026; 193 PDF pages. Document ID: `xcore-xs3-xtc-programming-guide`.
- [AN03001: XCORE Clocked Input and Output](xmos-clocked-io-an03001.pdf) — XM-015254-AN v1.0.0, 2025-03-11; 9 PDF pages. Document ID: `xcore-xs3-xmos-clocked-io-an03001`.

**Application notes**

- [AN03001: XCORE Clocked Input and Output](xmos-clocked-io-an03001.pdf) — XM-015254-AN v1.0.0, 2025-03-11; 9 PDF pages. Document ID: `xcore-xs3-xmos-clocked-io-an03001`.

## Programming and debugging

xC/C/C++ compiled for the XS3 ISA; xsim is the vendor simulator.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context xcore-xs3` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
