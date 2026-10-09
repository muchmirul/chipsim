# PCA9555

Two-bank completed-byte GPIO/interrupt model; no physical I2C serialization.

## Vendor PDFs

**Datasheet**

- [PCA9555 Remote 16-bit I2C and SMBus I/O Expander with Interrupt Output and Configuration Registers](ti-pca9555.pdf) — SCPS131J, revised March 2021; 49 PDF pages. Document ID: `pca9555-ti-pca9555`.

**Reference manual**

- [PCA9555 Remote 16-bit I2C and SMBus I/O Expander with Interrupt Output and Configuration Registers](ti-pca9555.pdf) — SCPS131J, revised March 2021; 49 PDF pages. Document ID: `pca9555-ti-pca9555`.

**Programming guide**

- [PCA9555 Remote 16-bit I2C and SMBus I/O Expander with Interrupt Output and Configuration Registers](ti-pca9555.pdf) — SCPS131J, revised March 2021; 49 PDF pages. Document ID: `pca9555-ti-pca9555`.

## Programming and debugging

No CPU. Program its register interface using host transactions.

Use a [ChipSim experiment](../../PROGRAMMING.md) to drive modeled inputs, perform declared register transactions and check observable signals. Cite a programming-guide document above using its document ID, one-based PDF page and a short exact quote. Use `chipsim agent context pca9555` to obtain current model capabilities and commands. Native instruction execution requires a separate backend.

The downloaded PDFs are preserved byte-for-byte. SHA-256, byte counts, source URLs, retrieval dates and provenance are recorded in [manifest.json](../manifest.json). Vendor copyright and usage notices remain inside each PDF.
