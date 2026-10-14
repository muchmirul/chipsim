# Licensing and public distribution

Original ChipSim source and documentation are [MIT licensed](../LICENSE),
copyright 2026 Muchmirul Yusa Setiaji. Specific upstream files keep their own
licenses. [Acknowledgments](../ACKNOWLEDGMENTS.md) credit the projects and
publishers behind the integrations and reference catalog.

The public source repository and npm package contain **no vendor PDFs, extracted
manual caches or document-rich screenshots**. The 34-document audit is retained
as metadata and explains why the originals must remain private inputs; it does
not assert permission to redistribute them. See [private reference setup](LOCAL_REFERENCES.md)
and the [GitHub cleanup record](licensing/CLEANUP.md).

## Scope and evidence

The [software inventory](licensing/software.json) records 38 directly integrated
or researched tools/libraries, source relationships, primary license links and
reviewed evidence hashes. The [reference inventory](licensing/reference-documents.json)
records all 34 private-original titles, publishers, revisions, URLs, SHA-256 hashes
and one-based notice pages. All original PDF hashes and three copied upstream
software files matched their recorded fingerprints during the private audit.
Main/master license links describe the review date, not future upstream releases.

External installations, configurable commands/solvers, cores, PDKs and user
projects are not bundled or licensed by ChipSim. Their transitive dependencies
and generated outputs need separate review when distributed. Identity hashes
are not license grants; source checks are not silicon certification.

## File-specific license boundaries

| Material                                                                                                                                                  | License / notice                                      | Distribution requirement                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original ChipSim code, docs and fixtures without another explicit notice                                                                                  | [MIT](../LICENSE)                                     | Keep the copyright, permission and warranty notice.                                                                                                                  |
| `examples/design/soc/picorv32.v`                                                                                                                          | ISC, retained in its unchanged header                 | Keep Claire Xenia Wolf's complete original notice. [Exact provenance](../examples/design/README.md).                                                                 |
| `examples/hdl/upstream/adder.sv` and `adder.vhdl`                                                                                                         | CC0-1.0, explicitly stated by upstream                | Keep original provenance/notices and the included [CC0 text](../LICENSES/CC0-1.0.txt). The cocotb runtime's BSD license does not override these file-specific terms. |
| Original `adder_tb.sv`, `adder_tb.vhdl`, `nand-reference.mjs`, `counter.sv`, `counter.vhdl` and four `counter-*.project.json` files under `examples/hdl/` | CC0-1.0                                               | Keep their specific dedication and included CC0 text. Other examples retain MIT.                                                                                     |
| `extensions/hdl-debug/iverilog/` and `ghdl/`, including upstream patch context                                                                            | GPL-2.0-or-later                                      | Keep [COPYING](../extensions/hdl-debug/COPYING), [NOTICE](../extensions/hdl-debug/NOTICE), source notices and build recipes.                                         |
| `extensions/chipsim.ts`, `extensions/hdl-debug/manifest.mjs`, independent Node runners/build helpers                                                      | MIT                                                   | Root license; the separate observer directories do not relicense independent files.                                                                                  |
| Private vendor PDFs, extracted text, source-derived screenshots and saved user runs                                                                       | Publisher/source-specific terms; not distributed here | Review before sharing. The repository's MIT license does not license these private inputs or their copied expression.                                                |

The npm `license: "MIT"` field describes original ChipSim code, with the
file-specific exceptions above. Keep this guide, acknowledgments, third-party
notices and all applicable license texts with distributions. The package is
still marked private to prevent an accidental npm registry publication.

## External integrations and their licenses

These are separately installed tools or hosts, except for the copied files
explicitly identified above. The implementation boundary is in
`src/design/adapters.js`, `src/design/contracts.js`, `src/hdl/run.js`,
`src/integrations/`, the TUI viewer handoff and the named helper scripts.

| Integration                                                                                                                                                                                                                                                                                        | Inspected upstream terms                                                                                           | Actual use / distribution note                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Pi](https://github.com/earendil-works/pi/blob/main/LICENSE), [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/LICENSE), [TypeBox](https://github.com/sinclairzx81/typebox/blob/master/license)                                                                            | MIT                                                                                                                | Native extension hosts and host-supplied TypeBox. ChipSim loads TypeBox inside the host; its standalone CLI has no npm runtime dependencies. No provider or host binaries are included.                                                                                                   |
| [dwfv](https://github.com/psurply/dwfv/blob/main/LICENSE)                                                                                                                                                                                                                                          | MIT                                                                                                                | Optional subprocess VCD viewer and navigation reference; no copied renderer or bundled binary. Tested reference revision is documented in [TUI](TUI.md#dwfv).                                                                                                                             |
| [Icarus Verilog v12_0](https://github.com/steveicarus/iverilog/tree/v12_0), [GHDL v4.1.0](https://github.com/ghdl/ghdl/tree/v4.1.0)                                                                                                                                                                | Modified compiler/runtime source headers declare GPL-2.0-or-later; individual libraries/exceptions remain separate | HDL subprocesses. Optional observers link into the simulators and are GPL, as are their patch contexts. This is a real derivative-work boundary.                                                                                                                                          |
| [FuseSoC](https://github.com/olofk/fusesoc/blob/main/LICENSE), [Edalize](https://github.com/olofk/edalize/blob/main/LICENSE)                                                                                                                                                                       | BSD-2-Clause                                                                                                       | Core/setup subprocess and external backend; each resolved core/IP still needs its own license.                                                                                                                                                                                            |
| [PeakRDL](https://github.com/SystemRDL/PeakRDL/blob/main/LICENSE), [regblock](https://github.com/SystemRDL/PeakRDL-regblock/blob/main/LICENSE), [cheader](https://github.com/SystemRDL/PeakRDL-cheader/blob/main/LICENSE), [ipxact](https://github.com/SystemRDL/PeakRDL-ipxact/blob/main/LICENSE) | LGPL v3                                                                                                            | External CLI/exporters. [regblock's explicit output exemption](https://peakrdl-regblock.readthedocs.io/en/latest/licensing.html) separates generated RTL from the generator. Inspect each exporter's/output's terms; do not automatically extend one exporter's exemption to all plugins. |
| [SystemRDL Compiler](https://github.com/SystemRDL/systemrdl-compiler/blob/main/LICENSE)                                                                                                                                                                                                            | MIT                                                                                                                | `scripts/design-registers.py` imports it in a separate Python process for metadata.                                                                                                                                                                                                       |
| [Verilator](https://github.com/verilator/verilator/blob/master/README.rst)                                                                                                                                                                                                                         | LGPL-3.0-only OR Artistic-2.0                                                                                      | External compiled simulation. Upstream's [output licensing explanation](https://verilator.org/guide/latest/faq.html#will-verilator-output-remain-under-my-own-license-copyright) distinguishes user HDL/C++ from changes to Verilator itself.                                             |
| [cocotb](https://github.com/cocotb/cocotb/blob/master/LICENSE)                                                                                                                                                                                                                                     | BSD-3-Clause                                                                                                       | Make/Python HDL tests; only its two separately licensed CC0 adders are copied here.                                                                                                                                                                                                       |
| [Yosys](https://github.com/YosysHQ/yosys/blob/main/COPYING), [SBY](https://github.com/YosysHQ/sby/blob/main/COPYING), [EQY](https://github.com/YosysHQ/eqy/blob/main/COPYING)                                                                                                                      | ISC                                                                                                                | External synthesis/formal/equivalence tools. SBY and EQY were checked directly; do not infer their license from related tools. Plugins and helper engines have separate terms.                                                                                                            |
| [Z3](https://github.com/Z3Prover/z3/blob/master/LICENSE.txt)                                                                                                                                                                                                                                       | MIT                                                                                                                | Default formal solver; configurable alternatives require separate review.                                                                                                                                                                                                                 |
| [OpenROAD-flow-scripts](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts/blob/8ae3ae362e2e9be94ab1d27b3dd647c8328a783f/LICENSE_BUILD_RUN_SCRIPTS)                                                                                                                                     | BSD-3-Clause for build/run scripts only                                                                            | External flow; its license explicitly excludes the tools, platforms and designs it uses. The documented later CDL/LVS deck revision is external too.                                                                                                                                      |
| [OpenROAD](https://github.com/The-OpenROAD-Project/OpenROAD/blob/master/LICENSE), [OpenROAD-MCP](https://github.com/The-OpenROAD-Project/OpenROAD-MCP/blob/main/LICENSE)                                                                                                                           | BSD-3-Clause                                                                                                       | Physical tool and finite stdio inspection server. ChipSim implements a JSON-RPC client; it does not bundle the server or MCP SDK.                                                                                                                                                         |
| [KLayout](https://www.klayout.de/license.html)                                                                                                                                                                                                                                                     | GPL-2.0-or-later, with an explicit independently licensed script/Python-client exception                           | Separate batch report reader. ChipSim's `design-klayout.py` and test script explicitly state MIT. Native extensions or bundled KLayout builds require a new review.                                                                                                                       |
| [SkyWater SKY130 PDK](https://github.com/google/skywater-pdk/blob/main/LICENSE)                                                                                                                                                                                                                    | Upstream PDK Apache-2.0; individual platform/cell/deck notices still apply                                         | External locked data, absent from the repository/package. ORFS's BSD script license is not a blanket PDK license. Other foundries/PDKs can have different access and redistribution terms.                                                                                                |
| [GCC](https://gcc.gnu.org/onlinedocs/gcc/Copying.html), [GNU Binutils](https://sourceware.org/git/?p=binutils-gdb.git;a=blob;f=COPYING3;hb=HEAD)                                                                                                                                                   | GPL-3.0-or-later for tools; relevant runtime components have separate licenses/exceptions                          | Selected compiler/objcopy subprocesses. Review linked libraries, copied startup code and [GCC Runtime Library Exception](https://www.gnu.org/licenses/gcc-exception-3.1.en.html) before distributing firmware.                                                                            |
| [Renode](https://github.com/renode/renode/blob/master/LICENSE), [Renode Verilator bridge](https://github.com/antmicro/renode-verilator-integration/blob/master/LICENSE)                                                                                                                            | MIT; Renode dependencies retain their own licenses                                                                 | Implemented software-platform subprocess adapter; any RTL bridge is project supplied. No Renode/bridge sources are bundled.                                                                                                                                                               |
| [Poppler](https://poppler.freedesktop.org/)                                                                                                                                                                                                                                                        | Core GPL v2 or GPL v3, with individual contribution/third-party notices                                            | `pdfinfo`/`pdftotext` subprocesses, not linked into ChipSim. The installed `poppler-utils` copyright was inspected as well as upstream project information.                                                                                                                               |
| [Node.js](https://github.com/nodejs/node/blob/v22.13.0/LICENSE), [Python](https://docs.python.org/3/license.html)                                                                                                                                                                                  | Node MIT plus bundled third-party notices; Python PSF and historical/third-party notices                           | External runtimes. Shipping a runtime/container later needs its own complete notice/dependency review.                                                                                                                                                                                    |
| [Prettier](https://github.com/prettier/prettier/blob/main/LICENSE)                                                                                                                                                                                                                                 | MIT plus installed package's third-party notices                                                                   | Only npm dependency, locked at 3.9.9, development only. Its installed package is not included in ChipSim's archive.                                                                                                                                                                       |
| [Pillow](https://github.com/python-pillow/Pillow/blob/main/LICENSE), [DejaVu fonts](https://github.com/dejavu-fonts/dejavu-fonts/blob/master/LICENSE)                                                                                                                                              | MIT-CMU; Bitstream Vera / public-domain DejaVu changes / Arev notices                                              | External screenshot tooling. PNGs contain rasterized glyphs; no font files or Pillow binaries are included. Vendor excerpts visible in screenshots still need review.                                                                                                                     |

The explicit observer build also uses ordinary system build utilities:
GNU Make, Autoconf, Gperf, Bison, Tar and Coreutils (GNU GPL distributions, with
component/output exceptions where stated), GCC/G++/GNAT, Python, POSIX shell,
[curl](https://curl.se/docs/copyright.html) (the curl license), and
[Flex](https://github.com/westes/flex/blob/master/COPYING) (BSD-style notice).
None is vendored. A binary/toolchain/container release must retain the actual
installed versions' full notices and dependency licenses; this source audit
does not grant a blanket redistribution license to a system installation.

[rp2040js](https://github.com/wokwi/rp2040js/blob/main/LICENSE) (MIT),
[rp2040-pio-emulator](https://github.com/NathanY3G/rp2040-pio-emulator/blob/main/LICENSE)
(Apache-2.0), and [rp2040pio](https://github.com/soundpaint/rp2040pio/blob/main/LICENSE)
(GPL v2 text) are research references only. XMOS XTC/xsim, PSoC Creator, the
Pico SDK and ESP-IDF are mentioned programming routes or documentation, not
embedded simulators/toolchains. There is no license implication from a link
alone and no assertion that proprietary vendor tools are open source.

## Observer source and binary distribution

The observer recipes download hash-pinned Icarus/GHDL archives only when explicitly
invoked. Their upstream context and observer source are GPL-2.0-or-later.
New source headers identify this scope, and the recipes add a dated ChipSim
modification notice to each edited upstream file while retaining original
copyright/license headers. The install prefix receives the GPL texts and
observer NOTICE; full patched sources, build scripts and logs remain in the
build directory.

If redistributing instrumented binaries, provide complete corresponding source
and the scripts needed to build/install those exact binaries, including upstream
sources, ChipSim patches/observer sources and any required interfaces. A private
local build directory or an upstream link alone is not a delivered source offer.
For a download release, making corresponding source available alongside binaries
is the straightforward GPL v2 section 3(a) route. A section 3(b) written offer is
an alternative with its own requirements. Preserve GHDL's existing runtime
exceptions where present; do not extend them to all newly written observer code.
See [GPL v2 sections 1–3](../extensions/hdl-debug/COPYING).

ChipSim's independent Node process reads files and invokes external programs.
That boundary does not itself replace MIT with the tool's GPL/LGPL terms. If a
future change embeds, links or copies tool/SDK code into ChipSim, reassess that
combined work rather than relying on this subprocess assessment.

## Why vendor references are external

The audit found 32 PDFs without an established general redistribution grant.
Two Raspberry Pi documents explicitly identify CC BY-ND 4.0 documentation terms
alongside product-use language that needs scoped review. Rather than assert
rights that were not established, the public distribution excludes **all 34**.
Exact publisher attributions, notice pages and assessments remain in
[reference-documents.json](licensing/reference-documents.json). The
[CC BY-ND legal code](../LICENSES/CC-BY-ND-4.0.txt) is retained as audit reference,
not as a new license on ChipSim code or a claim that a PDF is bundled.

Public citations use short factual technical terms and API/register identifiers
with page numbers and original-document hashes. Original implementations,
independent oracles, synthetic examples, functional table facts and necessary
file-format syntax remain. No bulk manual prose or image/table capture is
distributed. Source-page matches still establish textual provenance only;
original ChipSim model interpretations and their limits stay explicit.

## Public checks and private acceptance

`npm test`, `npm run verify`, and `npm run test:install` run without vendor PDFs.
Private-source cases are explicitly marked skipped; they are not reported as
verified. The public terminal check uses an original synthetic PDF and the PIO
teaching model. Full original-source checks use the complete hash-validated
private snapshot through `npm run test:references -- --verify`. See
[LOCAL_REFERENCES.md](LOCAL_REFERENCES.md) for exact setup and limitations.

`npm run test:licenses` checks inventory coverage, file-specific notices and
pinned copied-source hashes. Present private references are fingerprinted;
absent references are not verified. `npm run test:licenses -- --release` also
reports any unresolved distribution findings in
[release-findings.json](licensing/release-findings.json). Neither command is a
blanket permission grant for external tools, documents, IP or future additions.

Git/npm ignore rules keep private PDFs, extracted manual text, local workspaces
and compiled run artifacts out of distributions. The install test creates nested
sentinel artifacts, retains a normal sibling and checks the actual npm archive.
Keep private inputs outside a public clone and review saved sessions/debug runs
that may embed third-party source or text before sharing them.

## Contribution and history policy

Keep original upstream copyright/license headers when copying compatible code,
record the exact revision and source hash, and update the inventories and credits.
Do not add vendor PDFs, extracted manuals or source-rich screenshots to the
public repository. A publisher link is not permission to mirror its content.
Confirm rights to contributed original code; Git author names or coding-agent
identities do not establish ownership.

The cleanup rewrites reachable history to remove excluded material; old clones
must not be merged/pushed into it. Use a fresh public clone. GitHub may retain
unreachable cached views outside branch history; the [cleanup record](licensing/CLEANUP.md)
describes that separate platform limitation and the required post-push audit.
