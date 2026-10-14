# Third-party notices

Original ChipSim code is [MIT licensed](LICENSE). These specific upstream
materials retain their own terms. See [Acknowledgments](ACKNOWLEDGMENTS.md), the
[licensing guide](docs/LICENSING.md), [software inventory](docs/licensing/software.json)
and [reference audit](docs/licensing/reference-documents.json).

## Bundled upstream software

`examples/design/soc/picorv32.v` is the unchanged PicoRV32 processor by Claire
Xenia Wolf / YosysHQ under ISC. Its full copyright, permission and warranty
notice remains in its file header. The pinned revision, source URL and SHA-256
are recorded in [the fixture guide](examples/design/README.md).

`examples/hdl/upstream/adder.sv` and `adder.vhdl` are unchanged examples from
[cocotb](https://github.com/cocotb/cocotb), expressly CC0-1.0 in their own headers.
[Pinned provenance](examples/hdl/upstream/provenance.json) records their source
revision, URLs and byte hashes. The [CC0 text](LICENSES/CC0-1.0.txt) accompanies
them. Original ChipSim CC0 examples are listed individually in the licensing
guide; this does not place unrelated source under CC0.

`extensions/hdl-debug/iverilog/` and `ghdl/` contain GPL-2.0-or-later observers
and exact-context patches for Icarus Verilog v12_0 and GHDL v4.1.0. Keep
[COPYING](extensions/hdl-debug/COPYING) and [NOTICE](extensions/hdl-debug/NOTICE).
Original upstream headers remain in patched sources, and changed files receive
dated ChipSim modification notices. No complete upstream tree or simulator
binary is bundled. Redistributing instrumented binaries requires delivery of
corresponding patched sources/build scripts under the GPL requirements.

## External integrations and reference projects

Pi, prime-agent, TypeBox, dwfv, Icarus/GHDL, FuseSoC/Edalize, PeakRDL and its
exporters, SystemRDL Compiler, Verilator/cocotb, Yosys/SBY/EQY, Z3, ORFS/OpenROAD,
OpenROAD-MCP, KLayout, SKY130, GCC/Binutils and Renode remain separate tools,
hosts or data installations. The [software inventory](docs/licensing/software.json)
and [licensing guide](docs/LICENSING.md) identify each actual boundary, primary
license evidence, exceptions and distribution obligations. Research-only PIO
simulators are credited separately from implemented backends.

Poppler and Node/Python are external runtime/helper tools. Prettier is the sole
npm dependency, for development only. Pillow and DejaVu Sans Mono generate the
original PIO screenshots; library/font binaries are not bundled. Installed tools
and their own dependencies retain their license notices.

## Publisher reference metadata

The catalog credits Raspberry Pi (including retained Arm/Synopsys attribution),
Texas Instruments, Nexperia, Renesas Electronics, Cypress / Infineon, Freescale /
NXP, Espressif and XMOS. Their trademarks and publisher rights remain theirs.
No vendor PDFs, extracted manuals or vendor-document screenshot captures are
distributed here. Metadata preserves titles, revisions, publisher URLs, exact
fingerprints and notice pages for private source verification.

The underlying document audit found 32 references without an established
general redistribution grant and two with conditional documentation terms.
Excluding those bytes does not relicense them or grant permission to share
private copies or source-derived exports. The [CC BY-ND text](LICENSES/CC-BY-ND-4.0.txt)
is included only as audit reference. See [private input setup](docs/LOCAL_REFERENCES.md).

Inclusion, citation or interoperability does not imply upstream/vendor endorsement.
