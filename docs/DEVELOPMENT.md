# Developing ChipSim

Read `AGENTS.md` before changing simulation behavior or adding a model. The terminal workbench is the primary interface; the optional browser shares its simulation and model modules.

## Architecture

A model provides a common interface: ID, name, summary, scope, fidelity, parameters, signals, topology, source references, assumptions, `simulate(parameters, options)`, and `recipe(parameters)`. Every snapshot carries `tick`, `state`, `phase`, `signals`, `registers`, active node IDs, event text, evidence IDs, and structured changes. Built-in snapshots also retain `original` values for regression inspection. Playback selects snapshots from deterministic traces rather than mutating a running engine.

`src/models/index.js` adapts six built-in architecture modules and registers declarative models. Built-ins retain their mechanism-specific behavior; `src/core/protocol.js` shares payload normalization, edge planning, frame boundaries, ACK stimulus, and terminal outcomes. Resource constraints deliberately produce different stalls, drift, or missed deadlines.

`src/model/validate.js` validates the declarative contract. `src/model/engine.js` evaluates bounded expressions and transitions without dynamic code execution. `src/model/stimulus.js` validates timed input events for both models and callers. Imported models must pass acceptance cases before registration; attached documents verify exact evidence quotations and page numbers.

`src/model/profiles/` compiles exact reviewed datasheet versions into JSON models. Imports require the pinned PDF hash, validate cited excerpts against the extracted pages, and run acceptance cases before persistence. The Nexperia 74HC595 profile is the first automatic path for a chip beyond the six architecture examples; existing authored source-linked models take precedence. See `DOCUMENT_PROFILES.md` to extend this registry.

`src/model/tables/` reads positioned function tables and compiles exhaustive binary or bounded edge-triggered logic into the shared model language. `src/documents/layout.js` shares geometry handling between Poppler and PDF.js. `src/model/from-document.js` applies reviewed profiles first, then data-derived tables. Table layout, symbol interpretation, indexed pin mapping, model generation, and scenario/check generation are separate modules. Sequential table compilation stores clock history in declared registers and retained state in output signals; it uses the existing JSON interpreter. `src/model/table-metadata.js` validates source-table snapshots before display. See `FUNCTION_TABLES.md` for supported symbols, bounds, and rejected cases.

`src/model/templates.js` suggests conservative source excerpts and builds local scenarios using `src/model/builders/`. Counter, FIFO, and shifter rules are explicitly declared assumptions. Source matching confirms provenance, not circuit correctness. The builder validates generated definitions and checks before either interface installs them.

## Terminal interface

`src/tui/state.js` owns model selection, configuration, trace navigation, source search, and sessions. `src/tui/app.js` owns keyboard input, prompts, playback, and external-viewer handoff. `src/tui/render.js` draws terminal frames and strips control characters from untrusted content. `src/tui/workspace.js` stores copied PDFs, extracted text, and model JSON under `.chipsim/`; it uses atomic JSON replacement. Keep simulation behavior out of these modules.

Input-pin experiments use `TuiState.driveInput`: replace one pin/tick event, validate widths/direction, simulate before committing, and retain the cursor. A fault rejects the experiment without replacing the previous trace/stimulus. Shared-pin compilation resolves pin declarations in `src/model/tables/pins.js`; common controls are emitted once and remain consistent across every indexed channel.

`src/documents/extract-node.js` runs Poppler using argument arrays without a shell. It preserves one-based PDF page numbers and hashes the original bytes. `src/documents/recognize.js` uses pinned fingerprints or conservative name matches and associates authored models by source SHA-256. Recognition selects existing behavior; it does not invent a chip implementation. A newly attached source revalidates installed models.

The terminal runtime uses Node.js built-ins and has no npm runtime dependencies. Node.js 22.13+ is required. Poppler is required only for PDF extraction. Python 3 on POSIX is needed for the real terminal test. Rust and dwfv are optional external tools, with no Rust dependency in ChipSim.

```sh
npm start
npm start -- --document path/to/manual.pdf
npm start -- --model pio --snapshot --at 2 --view registers
```

`npm run dev` also launches the TUI directly. Changes take effect on restart. JSON in `models/` is loaded at launch; user models live in the selected workspace. See `docs/TUI.md` for keyboard controls and optional dwfv integration.

## Optional browser

`npm ci` installs pinned development dependencies. `npm run build` bundles the browser UI and PDF.js worker and writes `.generated/app.js` and portable `chipsim.html`. `npm run web` serves the completed build at `127.0.0.1:8000`; `PORT=8001 npm run web` changes the port. `npm run dev:web` watches dependencies and serves localhost. Restart the watcher after changing packaged JSON under `models/`.

`src/ui/` owns browser presentation. `src/documents/pdf.js` extracts PDFs with a local embedded PDF.js worker. IndexedDB stores source documents and models; a memory fallback warns when persistence is unavailable. The optional frontend supports direct-file offline use after building, and uses the same model builders and exports as the TUI.

Generated outputs, workspaces, and dependencies are Git-ignored. The static server accepts GET/HEAD only, binds to loopback, and excludes `.git`, `node_modules`, and `.env` paths. It is a local preview server, not an internet-facing application server.

## Add a model

Prefer declarative JSON for a bounded peripheral scenario; see `docs/MODEL_FORMAT.md` and `examples/timer.model.json`. Importing JSON with `d` requires no rebuild. Each model needs independently justified acceptance cases and explicit source evidence/assumptions. The guided builder provides a starting point; edit and review its assumptions before claiming it describes a particular device.

For behavior beyond the expression language, add a reviewed simulator under `src/models/`, adapt snapshots to the common interface, and register it in the catalog. Keep rendering separate from simulation. Preserve architecture-specific mechanisms and regression coverage.

## Checks

- `npm test`: numeric formats, built-in width/ACK combinations and constraints, model execution order, wrapping, provenance, builders, and terminal state/rendering.
- `npm run test:tui`: real POSIX PTY interaction, raw mode restoration, navigation, numeric inputs, export, resize, and PDF-to-model creation.
- `npm run verify`: all unit and PTY checks plus all pinned PDF fingerprints and reviewed profile checks, model coverage, example acceptance cases, and documentation existence. No browser build required.
- `npm run test:dwfv -- /path/to/dwfv`: optional real VCD parser interoperability for six built-ins, two generated scenarios, reviewed profiles, and compiled function-table models, including unknown register values.
- `npm run build && npm run verify:web`: default verification plus the portable browser bundle.
- `npm run test:ui`: Chromium controls, exports, local PDF extraction/storage, sourced model import/rejection, guided builders, sessions, mobile layout, and offline direct-file use.
- `npm run format`: Prettier for repository JavaScript, JSON, HTML, and Markdown.

Install Chromium once with `npx playwright install chromium`. Browser tests use their own contexts, not the user's browsing session. Tests store temporary terminal workspaces outside the repository.

## Review limits

Quote verification normalizes whitespace and confirms the quote exists on the cited page. Different PDF text engines can differ in hyphenation or ligatures; choose robust excerpts and check both interfaces when needed. Scanned documents require OCR outside ChipSim.

Timing is normalized, not cycle accurate. eTPU distinguishes capture arrival from shared service time; adjustable ACK capture remains independent of final CLK bookkeeping. VCD files declare a conventional time unit for viewer compatibility, and explicitly label timestamps as normalized ticks. Registers with no value yet are exported as unknown, not zero.

No LLM integration is present. Complete binary function tables can produce models from their content; they do not establish behavior beyond the table scope. Arbitrary-chip modeling still requires developer interpretation and verification. Importing an unfamiliar manual offers local source search, guided scenarios, a constrained model format, and acceptance checks; it does not reconstruct a complete chip automatically.
