# Third-party documents

`examples/design/soc/picorv32.v` contains the unchanged PicoRV32 processor by
Claire Xenia Wolf / YosysHQ, under the ISC license retained in its file header.
It is pinned to commit `ef203c2b0a3fb793280f5114941416c425c5b461`; source and
SHA-256 are documented in `examples/design/README.md`. Its inclusion is for a
small firmware/RTL integration fixture, not a silicon qualification claim.


The PDFs in `docs/references/` are complete downloads from publisher sites and the explicitly recorded NXP Community archive. Their bytes have not been edited by ChipSim. Filenames were standardized for this repository; each manifest entry identifies the actual host and revision.

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

The chip folders also retain unchanged programming and device references: Raspberry Pi's Pico C/C++ SDK guide; TI's AM335x datasheet (SPRS717L) and PRU programming guide (SPRUIJ2); NXP's S32K1xx and MPC5554 datasheets; the S32K1xx reference manual Rev. 13 archived on NXP Community; Freescale/NXP's Programming the eTPU note AN2848 Rev. 1; Infineon's PSoC 5LP datasheet and PSoC Creator User Guide; XMOS's XU316-1024-QF60B datasheet and XTC tools guide; and Espressif's ESP32-C6 datasheet and ESP-IDF v5.2 programming guide. Each publisher's original notices remain in its PDF. These local development references carry no new redistribution grant. Revisions, download URLs, provenance and downloaded-byte hashes are recorded in `docs/references/manifest.json`; `catalog.json` records document roles and missing references.

The unchanged TI SN74LVC1G125 data sheet (SCES223U, August 2026) is retained as a local development reference for its modeled TI device. Its final-page notice restricts resource use to development of applications using the described TI products; no general redistribution permission is asserted.

The unchanged TI PCA9555 data sheet (SCPS131J, March 2021; retrieved October 2026 with current final-page notice) is likewise retained as a local development reference for the modeled TI device. Its final-page notice restricts resource use to applications using the described TI products; this local repository does not assert general redistribution permission.

The unchanged TI SN74AHC273-Q1 data sheet (SLVSJA7A, June 2026) is retained as a local development reference for its modeled table. All original notices, including the final-page restriction to development of applications using TI products, remain intact. No general redistribution permission is asserted.

The unchanged TI TCA9534 data sheet (SCPS197D, revised October 2017; complete official copy retrieved October 2026) is retained as a local development reference for the modeled TI device. Its final-page notice restricts resource use to development of applications using the described TI products. All original notices remain; no general redistribution permission is asserted.

The ESP32-C6 Technical Reference Manual v1.2 (20 March 2026) was supplied by the user and copied unchanged as a local development reference. Copyright © 2026 Espressif Systems (Shanghai) Co., Ltd.; all rights reserved. Its final-page disclaimer grants no express or implied intellectual-property license. All original notices remain; inclusion does not assert general redistribution permission or apply a repository-wide license to this PDF.

## Bundled software

`examples/hdl/upstream/adder.sv` and `adder.vhdl` are unmodified examples from [cocotb/cocotb](https://github.com/cocotb/cocotb), explicitly released as CC0-1.0 in each file. Their original notices remain. `examples/hdl/upstream/provenance.json` records the exact revision, source URLs and SHA-256 hashes. The surrounding ChipSim testbenches/reference script are also CC0-1.0. Icarus Verilog and GHDL are optional external tools and are not bundled in the npm package.

Prettier is a development dependency; its license is distributed with its installed package. ChipSim has no npm runtime dependencies. Poppler is an external PDF extraction tool and is not bundled in the npm package.

## Terminal design reference

[dwfv](https://github.com/psurply/dwfv), by Pierre Surply, is an MIT-licensed VCD waveform viewer used as a navigation reference and optional external viewer. ChipSim contains no copied dwfv source and does not bundle its binary. The independently tested revision and interoperability commands are recorded in `docs/TUI.md`.

## Renesas development reference

The unchanged HD74HC77 reference (REJ03D0552-0200, Rev. 2.00, October 2005; official copy with 2010 front matter) is retained in this local development repository with all original notices. Its notice pages require prior written consent for reproduction/duplication; inclusion does not assert general redistribution permission or grant a repository-wide license to this PDF.

The unchanged HD74HC138 reference (REJ03D0570-0300, Rev. 3.00, March 2009; official copy with 2010 front matter) is likewise retained locally for development and table-parser regression tests. All original copyright and reproduction/duplication notices remain; inclusion does not assert general redistribution permission.

## Optional instrumented HDL simulator builds

`extensions/hdl-debug/iverilog/` and `extensions/hdl-debug/ghdl/` contain
GPL-2.0-or-later observer code and exact-context patch recipes for
[Icarus Verilog v12_0](https://github.com/steveicarus/iverilog/tree/v12_0) and
[GHDL v4.1.0](https://github.com/ghdl/ghdl/tree/v4.1.0). Upstream context remains
under its original GPL terms. The GNU GPL version 2 text is included at
[extensions/hdl-debug/COPYING](extensions/hdl-debug/COPYING). This directory's
license does not apply a new license to vendor PDFs or unrelated ChipSim files.

The npm package ships these observer sources/recipes, not upstream simulator
binaries or complete upstream source trees. An explicitly invoked build downloads
pinned, hash-checked archives, retains the patched source/build trees and logs,
and copies upstream license texts into the installation prefix. See the
[recipe provenance](extensions/hdl-debug/README.md) and [build instructions](docs/HDL_DEBUG.md).
The original paired `examples/hdl/counter.sv` and `counter.vhdl` test designs and
fault manifests are CC0-1.0, as stated in their source headers.
