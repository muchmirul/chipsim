# ChipSim

ChipSim is a **terminal workbench** for understanding chip behavior through waveforms, hardware blocks, registers, and execution traces. It includes RP2040 PIO, TI PRU, NXP FlexIO, PSoC UDB, XMOS xCORE, and NXP eTPU examples, and supports adding document-backed models.

## Start the TUI

Use Node.js 22.13 or newer:

```sh
cd /home/dev/chipsim
npm start
```

The terminal app uses Node's built-in modules; it needs no browser, model service, or Rust installation. PDF import uses Poppler's `pdfinfo` and `pdftotext`. A terminal of at least **80 columns × 24 rows** is recommended. Press **`?`** for help and **`q`** to quit.

Open a manual or model directly:

```sh
npm start -- --document path/to/manual.pdf
npm start -- --model examples/timer.model.json
npm start -- --model pio --params parameters.json --inputs events.json
```

The local workspace defaults to `.chipsim/` in the current directory. PDFs, extracted text, and imported models persist there; it is Git-ignored. Use `--workspace /path/to/workspace` to choose another location. Saved sessions and model JSON can also be loaded with `d`.

## Main controls

| Key                | Action                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| `1`–`7`, Tab       | Waveforms, blocks, log, sources, model, registers, input stimulus        |
| `h` / `l`, arrows  | Move one tick; move PDF page in Sources                                  |
| `j` / `k`, arrows  | Select signal, log row, or register; scroll blocks/source/model text     |
| Space, `r`         | Run/pause; reset                                                         |
| `w`, `e`, `b`      | Next rising edge, next falling edge, previous rising edge                |
| `[`, `]`, `t`      | Previous/next model change; jump to a tick                               |
| `+`, `-`, `=`, `z` | Zoom in/out, fit the trace, center cursor                                |
| `m`, `p`, `a`, `T` | Choose model, parameters, stimulus actions/JSON, document-model duration |
| `i`                | Drive an input pin at the cursor                                         |
| `u`                | Read/write an addressed register at the next tick                        |
| `U`, `R`           | Undo/redo an input or register experiment                                |
| `F`, `f`           | Cycle numeric display; find a selected signal value                      |
| `/`, `n`, `N`      | Search/filter; repeat signal/source search                               |
| `d`, `c`           | Import PDF/model/session; create a sourced peripheral scenario           |
| `x`, `S`, `M`, `B` | Export trace, save session, export model JSON, export source bundle      |
| `V`                | Open the current trace in installed `dwfv`                               |
| `?`, Esc, `q`      | Help, close a prompt/menu, quit                                          |

The full register view includes before/after changes. The log supports filtering, changes-only mode (`C`), and seeking with Enter. Model details show scope, assumptions, references, and implementation recipes. Source text keeps one-based PDF page numbers and supports search.

Integer inputs accept `179`, `0xB3`, `0b10110011`, or `0o263`. Plain digit strings are decimal. `F` changes presentation without changing values or moving the cursor. Built-in transfers use the low 8 or 12 payload bits; decimal `300` sends decimal `44` in an 8-bit frame.

Input events drive a signal at an absolute normalized tick and hold their value:

```json
[{ "tick": 35, "signal": "ack", "value": 1 }]
```

Press `i` to select an input pin and set its value at the cursor. This replaces that pin's event at the current tick, keeps the cursor, and preserves later scheduled events. Values hold until the next event for that pin. Output pins cannot be driven. Use `a` to enter a single-line JSON array or load an events file. Empty stimulus uses the built-in ACK controls. Parameter editing includes resource constraints, ACK delay, and polling budget. Custom models use their declared inputs; FIFO and shifter scenarios include an initial demonstration stimulus.

Press `7` for the input stimulus timeline. `i` schedules a pin/value at a chosen tick; Enter opens actions to edit, move, remove, or inspect a selected event. `a` clears events, restores demonstration events, or loads JSON. `U` and `R` undo/redo experiments, including addressed accesses. The trace recomputes before accepting changes; invalid values and simulation faults preserve the working experiment. `S` saves the result. See [timeline behavior](docs/TUI.md#input-stimulus-timeline).

Press uppercase `E` on an entered behavior-table model to edit its rules and citations, review current-tick changes, save a compatible revision, or create a separate model. Revision backups preserve the earlier model and experiment for restoration.

## From a manual to a simulation

1. Press `d` and enter the PDF path. ChipSim extracts searchable text locally, preserves page numbers, and fingerprints the PDF.
2. Complete combinational tables (including explicitly defined `Z` outputs) or supported edge-triggered and level-sensitive retention tables can create models directly from their rows and pin lists; see [function-table compilation](docs/FUNCTION_TABLES.md). Reviewed profiles cover Nexperia 74HC595/74HCT595 Rev. 12 and TI PCA9555 SCPS131J. List supported automatic profiles with `npm start -- --list-profiles`. A manual with an installed matching model opens that model after source verification. Recognized vendor manuals also open their corresponding existing example.
3. For a new manual, inspect/search Sources (`4`, `/`) and press `c`. Choose **counter/timer**, **FIFO**, **shift transfer**, or a custom **behavior table**. Cite a relevant source excerpt.
4. Configure width, direction, depth, compare behavior, or custom state/input/output rows. Cite the PDF page and exact excerpt, explain its relevance, and declare additional assumptions. The generated model must pass its acceptance cases and quote checks before it is saved and opened.
5. Run it in the same waveform, register, and log interface. Press `5` to review the selected rules and `M` to export editable model JSON.

The guided builder creates **selected peripheral scenarios**. Word/width suggestions are text matches, not automatic chip interpretation. Register addresses, detailed bus semantics, clock domains, analog behavior, and unmodeled chip features are not inferred from arbitrary PDFs. All chosen scenario rules remain explicit assumptions for review. **No LLM integration is present.**

For custom logic/state machines, Behavior table accepts rows such as `idle 01 -> armed / 1` and explicit hold outputs (`=`), with input wildcards (`X`). Enter rows in the TUI or load `@path/to/rules.txt`. Missing combinations and conflicting overlaps reject creation; models retain their source quotations and entered rules. See [behavior-table authoring](docs/BEHAVIOR_TABLES.md) for real-source examples, clock history, and limits. This is a developer-authored path for unsupported manuals.

Try the automatic document paths:

```sh
npm start -- --document docs/references/nexperia-74hc595.pdf
npm start -- --document docs/references/ti-pca9555.pdf
npm start -- --document docs/references/nexperia-74hc00.pdf
npm start -- --document docs/references/nexperia-74hc86.pdf
npm start -- --document docs/references/nexperia-74hc157.pdf
npm start -- --document docs/references/nexperia-74hc377.pdf
npm start -- --document docs/references/nexperia-74hc273.pdf
npm start -- --document docs/references/ti-sn74lvc1g125.pdf
npm start -- --document docs/references/renesas-hd74hc77.pdf
npm start -- --document docs/references/ti-sn74ahc273-q1.pdf
```

Sequential tables expose retained outputs and clock-history registers. `p` configures the initial output bits, which are scenario values rather than guaranteed power-on state; `i` drives clock, control, or data inputs. The original table arrows and lowercase set-up symbols remain visible in Model view. Physical set-up/hold timing is omitted; see [function-table scope](docs/FUNCTION_TABLES.md).

The 74HC595 model exposes DS, SHCP, STCP, MR, OE, Q7S, shift/storage registers, retained parallel data, and a drive-enable flag. The default stimulus shifts `0xB3`, latches it, toggles output enable, and demonstrates reset behavior. `parallel_pins` shows the stored byte when enabled and `Z` when released; `parallel_latch` always shows retained data. See [reviewed profiles](docs/DOCUMENT_PROFILES.md) for scope and extension instructions.

The PCA9555 model exposes eight addressed GPIO registers, two external input bytes, sixteen individual output drivers, input inversion, and an open-drain interrupt driver. Press `u`, select a register, then Read or Write. Accesses execute at the next tick and seek to the result; `6` shows named register addresses and `3` shows the event and changes. `i` changes external inputs. Later scheduled register accesses retain their address, operation, and data. Save experiments with `S`. This is a byte-transaction model: physical I²C, paired multi-byte transfers, and the documented shared-bus interrupt erratum are outside scope.

The HD74HC77 PDF creates one latch table instance automatically. Its output follows data while enabled and retains its prior bit while disabled; the default sweep demonstrates both. `p` sets the initial scenario bit and `i` changes data/enable. Package replication and grouped-enable wiring from its pin diagram remain outside this model. See [function-table scope](docs/FUNCTION_TABLES.md).

The SN74AHC273-Q1 PDF creates one flip-flop table instance from its rows, wrapped symbol definitions, and typed clock-pin description. Its `L, H, ↓` clock cell means steady low, steady high, or a falling edge; `Q0` explicitly means retain the prior output. A rising edge captures data, and clear takes effect immediately. Model view keeps that source notation visible. The generic D/Q headings do not establish eight independent package channels; package replication and physical timing are omitted.

`Z` means an output driver is released. Waveforms, registers, logs, and CSV/JSON/VCD preserve it; `f` can find the next `Z` on a tri-state output. Numeric formats do not turn it into zero, and binary edge jumps skip transitions involving `Z`. This does not resolve shared buses, external pull-ups, floating-node voltage, or contention. Inputs remain explicitly driven integer levels.

For behavior beyond these builders, export the sources with `B`, then use [AGENTS.md](AGENTS.md) and [docs/MODEL_FORMAT.md](docs/MODEL_FORMAT.md) to author a custom JSON model. Import it with `d`. Missing PDFs produce unverified-source warnings; a mismatching attached page/quote rejects the model.

PDFs are limited to 80 MiB and must have searchable text; scanned PDFs need OCR first. Keep exported models/source bundles when moving between machines. The TUI workspace and browser storage are separate.

## DWFV reference and interoperability

[dwfv](https://github.com/psurply/dwfv) informed the vi-style navigation and waveform controls. ChipSim implements its own terminal interface around the simulation engine; it also exports standard VCD for dwfv. No dwfv source code is bundled.

To use its viewer, install it using the upstream instructions, then press `V`. A custom build can be selected with:

```sh
npm start -- --dwfv /path/to/dwfv
```

VCD's nominal `1ns` unit represents **one normalized model tick**, not physical nanosecond timing. Unarmed registers export as unknown values. See [docs/TUI.md](docs/TUI.md) for controls, workspace behavior, and the verified upstream revision.

## Developer commands

```sh
npm ci
npm test
npm run test:tui
npm run verify
npm run document -- path/to/manual.pdf --json
npm run document -- path/to/manual.pdf --out generated.model.json
npm run extract -- path/to/manual.pdf manual.sources.json
npm run model -- validate examples/timer.model.json --sources manual.sources.json
npm run model -- simulate examples/timer.model.json --ticks 40 --format vcd --out timer.vcd
```

Use `--params parameters.json` and `--inputs events.json` for command-line simulation. The model language is bounded JSON data and cannot execute JavaScript. Put validated JSON under `models/` to include it in the terminal catalog.

A noninteractive terminal frame is useful in scripts:

```sh
npm start -- --snapshot --model pio --at 2 --view registers --columns 120 --rows 40
```

The optional browser frontend remains available with `npm run build` followed by `npm run web`; `npm run dev:web` watches its JavaScript. `npm start` always launches the TUI. Browser checks use `npm run test:ui`; install their test browser with `npx playwright install chromium`.

## Repository

```text
src/tui/                    Terminal state, controls, rendering, disk workspace
src/core/                   Numeric formats and shared transfer protocol
src/models/                 Six architecture modules and model catalog
src/model/                  Declarative interpreter, validator, scenario builders
src/documents/              Local PDF extraction, recognition, search, storage
src/trace/                  CSV, JSON, and VCD exports
src/ui/                     Optional browser frontend
models/, examples/          Packaged/importable model JSON
scripts/                    TUI entry, model CLI, extraction, build, checks
test/                      Engine, terminal, and browser tests
docs/references/            Eighteen complete official PDFs and fingerprint manifest
AGENTS.md                   Developer and coding-agent instructions
```

These are behavioral models of selected mechanisms. Source quotes and acceptance cases help review a model; neither proves silicon accuracy. ChipSim does not consume RTL, reconstruct a complete chip automatically, or predict physical area/power. See [development notes](docs/DEVELOPMENT.md), [reference documents](docs/REFERENCES.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
