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

The unchanged TI PCA9555 data sheet (SCPS131J, March 2021; retrieved October 2026 with current final-page notice) is likewise retained as a local development reference for the modeled TI device. Its final-page notice restricts resource use to applications using the described TI products; this local repository does not assert general redistribution permission.

The unchanged TI SN74AHC273-Q1 data sheet (SLVSJA7A, June 2026) is retained as a local development reference for its modeled table. All original notices, including the final-page restriction to development of applications using TI products, remain intact. No general redistribution permission is asserted.

## Bundled software

The browser app and portable HTML bundle Mozilla PDF.js (`pdfjs-dist`), including its PDF worker, under Apache License 2.0. The complete license is retained in [docs/licenses/pdfjs-LICENSE.txt](docs/licenses/pdfjs-LICENSE.txt). PDF.js copyright and license comments remain in the generated bundle.

Build and test tools (esbuild, Prettier, and Playwright) are development dependencies; their licenses are distributed with their installed packages. They are not model providers or runtime services.

## Terminal design reference

[dwfv](https://github.com/psurply/dwfv), by Pierre Surply, is an MIT-licensed VCD waveform viewer used as a navigation reference and optional external viewer. ChipSim contains no copied dwfv source and does not bundle its binary. The independently tested revision and interoperability commands are recorded in `docs/TUI.md`.

## Renesas development reference

The unchanged HD74HC77 reference (REJ03D0552-0200, Rev. 2.00, October 2005; official copy with 2010 front matter) is retained in this local development repository with all original notices. Its notice pages require prior written consent for reproduction/duplication; inclusion does not assert general redistribution permission or grant a repository-wide license to this PDF.

The unchanged HD74HC138 reference (REJ03D0570-0300, Rev. 3.00, March 2009; official copy with 2010 front matter) is likewise retained locally for development and table-parser regression tests. All original copyright and reproduction/duplication notices remain; inclusion does not assert general redistribution permission.
