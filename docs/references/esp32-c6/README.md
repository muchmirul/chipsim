# ESP32-C6

GPIO output/enable word transactions and one static PCNT channel. No firmware, IO MUX, wireless stack or full SoC.

## Vendor PDFs

**Datasheet**

- [ESP32-C6 Series Datasheet](datasheet.pdf) — v1.5; 31 March 2026; 86 PDF pages. Document ID: `esp32-c6-datasheet`.

**Reference manual**

- [ESP32-C6 Technical Reference Manual](espressif-esp32-c6-trm.pdf) — Version 1.2, 20 March 2026; 1394 PDF pages. Document ID: `esp32-c6-espressif-esp32-c6-trm`.

**Programming guide**

- [ESP-IDF Programming Guide 5.2 ESP32-C6](esp-idf-programming-guide.pdf) — ESP-IDF v5.2; 15 February 2024; 2929 PDF pages. Document ID: `esp32-c6-esp-idf-programming-guide`.

## Programming and debugging

RISC-V C/C++ or assembly requires a CPU backend; ChipSim experiments use modeled registers and pins.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context esp32-c6` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
