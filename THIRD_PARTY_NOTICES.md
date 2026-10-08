# Third-party documents

The PDFs in `docs/references/` are complete copies obtained from the official publisher URLs recorded in `manifest.json`. Their contents have not been edited. Filenames were standardized for this repository.

| Documents                                                                                                      | Publisher / attribution                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 74HC00 / 74HCT00, 74HC86 / 74HCT86, 74HC157 / 74HCT157, 74HC377 / 74HCT377, and 74HC273 / 74HCT273 data sheets | Nexperia B.V.; unchanged references used for function-table compiler regression tests.                                        |
| 74HC595 / 74HCT595 product data sheet                                                                          | Nexperia B.V.; original copyright and legal notices remain in the unchanged PDF.                                              |
| RP2040 Datasheet                                                                                               | Raspberry Pi Ltd; includes additional Arm and Synopsys notices. The PDF identifies its documentation license as CC BY-ND 4.0. |
| AM335x and AMIC110 technical reference manual, SPRUH73Q                                                        | Texas Instruments Incorporated.                                                                                               |
| FlexIO application note AN12174                                                                                | NXP Semiconductors.                                                                                                           |
| PSoC 5LP architecture TRM, 001-78426                                                                           | Cypress Semiconductor / Infineon Technologies.                                                                                |
| XS3 architecture, XM-014007-PS; AN03001, XM-015254-AN                                                          | XMOS Ltd.                                                                                                                     |
| eTPU notes AN2933 and AN2353                                                                                   | Freescale Semiconductor; distributed by NXP Semiconductors.                                                                   |

Original copyright, trademark, license, and usage notices remain inside each document. Inclusion in ChipSim does not change those terms or imply vendor endorsement. No repository-wide license is applied to these third-party PDFs.

The unchanged TI SN74LVC1G125 data sheet (SCES223U, August 2026) is retained as a local development reference for its modeled TI device. Its final-page notice restricts resource use to development of applications using the described TI products; no general redistribution permission is asserted.

## Bundled software

The browser app and portable HTML bundle Mozilla PDF.js (`pdfjs-dist`), including its PDF worker, under Apache License 2.0. The complete license is retained in [docs/licenses/pdfjs-LICENSE.txt](docs/licenses/pdfjs-LICENSE.txt). PDF.js copyright and license comments remain in the generated bundle.

Build and test tools (esbuild, Prettier, and Playwright) are development dependencies; their licenses are distributed with their installed packages. They are not model providers or runtime services.

## Terminal design reference

[dwfv](https://github.com/psurply/dwfv), by Pierre Surply, is an MIT-licensed VCD waveform viewer used as a navigation reference and optional external viewer. ChipSim contains no copied dwfv source and does not bundle its binary. The independently tested revision and interoperability commands are recorded in `docs/TUI.md`.
