# ChipSim

ChipSim is a local workbench for understanding chip behavior through architecture diagrams, waveforms, registers, and execution traces. It includes six behavioral examples: **RP2040 PIO, TI PRU, NXP FlexIO, PSoC UDB, XMOS xCORE, and NXP eTPU**, plus a format for adding document-backed simulations.

## Start

Use Node.js 22.13 or newer:

```sh
cd /home/dev/chipsim
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:8000**. Alternatively, open the generated **`chipsim.html`** directly in a modern browser. The portable file includes the app and PDF worker; no CDN, account, or model service is needed. Keep `docs/references/` beside it to open the bundled reference PDFs. Vendor PDF links are also recorded in the reference documentation.

For development, use `npm run dev`. It rebuilds JavaScript on changes and serves the app. Rebuild or restart after changing packaged model JSON. If opening `index.html` directly, run the build first so its generated script exists.

## Use the workbench

1. Select a model, set its parameters, and choose **Run**, **Step**, or **Next event**. Drag the tick slider to inspect any point. Space toggles playback; arrow keys step when focus is outside a control.
2. Inspect the active hardware blocks, signal values, and registers. Highlighted register rows changed during that tick. The waveform shows the full trace with a cursor at the selected tick.
3. Open **Trace & log** for state changes, events, and before/after values. Filter by event or register name, show changes only, or click a row to seek to it. The log shows history through the current tick, with the latest 500 matching rows displayed.
4. Export the full primary-model trace as **CSV**, **JSON**, or **VCD**. JSON includes parameters, stimulus, sources, and assumptions. VCD can be loaded in waveform viewers; its nominal `1ns` unit represents one normalized model tick and is not silicon timing.
5. Use **Save session** / **Open saved session** to preserve the primary model, parameters, stimulus, display format, and cursor. A custom primary model is included in the session JSON; PDF bytes are not included.

Integer inputs accept `179`, `0xB3`, `0b10110011`, or `0o263`. Plain numbers are decimal. **Display as** changes register and payload presentation without changing their values or moving the cursor. Built-in transfers use the low 8 or 12 payload bits; for example, decimal `300` sends decimal `44` in an 8-bit frame.

**Advanced controls** exposes resource constraints, ACK delay and polling budget, and timed input events. Events are absolute normalized ticks and hold their signal value:

```json
[{ "tick": 35, "signal": "ack", "value": 1 }]
```

An empty event list uses the built-in ACK controls. A nonempty list takes over ACK stimulus. For document models, use their declared input signal names and choose a duration of 1–10,000 ticks. **Compare** shares parameters and stimulus between the six built-in examples; other models use their own saved settings or defaults. Exports cover the primary model.

## Add a datasheet or reference manual

Click **Add datasheet**, or drop a searchable PDF into the app. ChipSim extracts its text and preserves page numbers and a SHA-256 fingerprint. The workspace supports search, opening the original PDF at a page, and exporting source text for a developer or coding agent.

A manual with an installed document-backed model opens that model after source verification. A recognized vendor manual also opens its corresponding **existing example**. It does not infer every feature of that chip. An unfamiliar manual opens a source workspace; creating its executable behavior still requires a developer or coding agent to author a model. **There is no LLM integration or automatic interpretation of arbitrary datasheets in this version.**

To add a new simulation:

1. Import the manual and select **Export sources for agent**.
2. Give the source bundle, [AGENTS.md](AGENTS.md), and [model format](docs/MODEL_FORMAT.md) to the developer or agent implementing the peripheral scenario.
3. Create model JSON with parameters, signals, registers, hardware nodes, state transitions, assumptions, exact page citations, and acceptance checks.
4. Import it with **Import model**. ChipSim validates its structure, runs its acceptance checks, and checks quoted evidence against attached PDF text. Missing PDFs produce an explicit unverified-source warning; a mismatching attached quote rejects the model.
5. Inspect and simulate it through the same workbench as the supplied examples.

Try importing [examples/timer.model.json](examples/timer.model.json). It demonstrates counter, compare, enable, and reset behavior. Its scenario is explicitly illustrative. Import the bundled NXP FlexIO application note as well to verify its source quote. To include a model in every build, put its JSON under `models/` and rebuild.

PDFs and imported models persist in this browser's IndexedDB. Different browsers/origins have separate workspaces. Private browsing, browser cleanup, or storage limits can erase it; keep exported source bundles and model files. There is no document sync or backend. Image-only PDFs need OCR before import. Imports are limited to 80 MiB per PDF and 2 MiB per model JSON.

## Command-line workflow

PDF extraction requires Poppler (`pdfinfo`, `pdftotext`):

```sh
npm run extract -- path/to/manual.pdf manual.sources.json
npm run model -- validate examples/timer.model.json --sources manual.sources.json
npm run model -- simulate examples/timer.model.json --ticks 40 --format vcd --out timer.vcd
```

Simulation also accepts `--params parameters.json` and `--inputs events.json`. Numeric values in these JSON files use ordinary JSON numbers. Model JSON has a bounded expression language; it cannot run JavaScript.

## Repository

```text
index.html                  HTML shell
src/
  core/                     Numeric formats and shared transfer protocol
  models/builtins/           Six architecture implementations
  models/                   Catalog and implementation recipes
  model/                    Declarative model validator and interpreter
  documents/                PDF extraction, recognition, search, local storage
  trace/                    CSV, JSON, and VCD exports
  ui/                       Workbench controls, diagrams, waveforms, logs, CSS
models/                     Optional packaged model JSON
examples/                   Importable timer model example
scripts/                    Build, local server, extraction, model CLI, verifier
test/                       Engine regressions and browser workflow checks
docs/references/            Eight complete official vendor PDFs and manifest
docs/                       Model format, development guide, reference index
AGENTS.md                   Instructions for developers and coding agents
chipsim.html                Generated portable app, ignored by Git
```

## Verification and scope

```sh
npm test
npm run build
npm run verify
npx playwright install chromium
npm run test:ui
```

These are behavioral models of selected mechanisms and scenarios. One tick is a semantic model step. Source quotes and passing acceptance cases help review a model; neither proves hardware accuracy. This workbench does not consume RTL, implement a complete CPU, predict physical area/power, or replace device validation.

Read [development notes](docs/DEVELOPMENT.md), [reference documents](docs/REFERENCES.md), and [third-party notices](THIRD_PARTY_NOTICES.md) for implementation and vendor-document provenance.
