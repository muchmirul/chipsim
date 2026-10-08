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

| Key                | Action                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| `1`–`6`, Tab       | Waveforms, hardware blocks, log, source text, model details, registers    |
| `h` / `l`, arrows  | Move one tick; move PDF page in Sources                                   |
| `j` / `k`, arrows  | Select signal, log row, or register; scroll source/model text             |
| Space, `r`         | Run/pause; reset                                                          |
| `w`, `e`, `b`      | Next rising edge, next falling edge, previous rising edge                 |
| `[`, `]`, `t`      | Previous/next model change; jump to a tick                                |
| `+`, `-`, `=`, `z` | Zoom in/out, fit the trace, center cursor                                 |
| `m`, `p`, `a`, `T` | Choose model, edit parameters, load stimulus, set document-model duration |
| `F`, `f`           | Cycle numeric display; find a selected signal value                       |
| `/`, `n`, `N`      | Search/filter; repeat signal/source search                                |
| `d`, `c`           | Import PDF/model/session; create a sourced peripheral scenario            |
| `x`, `S`, `M`, `B` | Export trace, save session, export model JSON, export source bundle       |
| `V`                | Open the current trace in installed `dwfv`                                |
| `?`, Esc, `q`      | Help, close a prompt/menu, quit                                           |

The full register view includes before/after changes. The log supports filtering, changes-only mode (`C`), and seeking with Enter. Model details show scope, assumptions, references, and implementation recipes. Source text keeps one-based PDF page numbers and supports search.

Integer inputs accept `179`, `0xB3`, `0b10110011`, or `0o263`. Plain digit strings are decimal. `F` changes presentation without changing values or moving the cursor. Built-in transfers use the low 8 or 12 payload bits; decimal `300` sends decimal `44` in an 8-bit frame.

Input events drive a signal at an absolute normalized tick and hold their value:

```json
[{ "tick": 35, "signal": "ack", "value": 1 }]
```

Use `a` to enter a single-line JSON array or load an events file. Empty stimulus uses the built-in ACK controls. Parameter editing includes resource constraints, ACK delay, and polling budget. Custom models use their declared inputs; FIFO and shifter scenarios include an initial demonstration stimulus.

## From a manual to a simulation

1. Press `d` and enter the PDF path. ChipSim extracts searchable text locally, preserves page numbers, and fingerprints the PDF.
2. The reviewed Nexperia 74HC595/74HCT595 Rev. 12 datasheet automatically creates a model with eight behavior checks. List supported automatic profiles with `npm start -- --list-profiles`. A manual with an installed matching model opens that model after source verification. Recognized vendor manuals also open their corresponding existing example.
3. For a new manual, inspect/search Sources (`4`, `/`) and press `c`. Choose **counter/timer**, **FIFO**, or **shift transfer**, then select a source excerpt.
4. Configure width, direction, depth, or compare behavior. Cite the PDF page and exact excerpt, explain its relevance, and declare additional assumptions. The generated model must pass its acceptance cases and quote checks before it is saved and opened.
5. Run it in the same waveform, register, and log interface. Press `5` to review the selected rules and `M` to export editable model JSON.

The guided builder creates **selected peripheral scenarios**. Word/width suggestions are text matches, not automatic chip interpretation. Register addresses, detailed bus semantics, clock domains, analog behavior, and unmodeled chip features are not inferred from arbitrary PDFs. All chosen scenario rules remain explicit assumptions for review. **No LLM integration is present.**

Try the automatic document path:

```sh
npm start -- --document docs/references/nexperia-74hc595.pdf
```

The 74HC595 model exposes DS, SHCP, STCP, MR, OE, Q7S, shift/storage registers, retained parallel data, and a drive-enable flag. The default stimulus shifts `0xB3`, latches it, toggles output enable, and demonstrates reset behavior. The retained data must be read with the enable flag; it is not a driven bus when disabled. See [reviewed profiles](docs/DOCUMENT_PROFILES.md) for scope and extension instructions.

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
docs/references/            Nine complete official PDFs and fingerprint manifest
AGENTS.md                   Developer and coding-agent instructions
```

These are behavioral models of selected mechanisms. Source quotes and acceptance cases help review a model; neither proves silicon accuracy. ChipSim does not consume RTL, reconstruct a complete chip automatically, or predict physical area/power. See [development notes](docs/DEVELOPMENT.md), [reference documents](docs/REFERENCES.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
