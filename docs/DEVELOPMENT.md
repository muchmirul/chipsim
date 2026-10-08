# Developing ChipSim

Read `AGENTS.md` before changing simulation behavior or adding a model. The terminal workbench is the primary interface; the optional browser shares its simulation and model modules.

## Architecture

A model provides a common interface: ID, name, summary, scope, fidelity, parameters, signals, topology, source references, assumptions, `simulate(parameters, options)`, and `recipe(parameters)`. Every snapshot carries `tick`, `state`, `phase`, `signals`, `registers`, active node IDs, event text, evidence IDs, and structured changes. Built-in snapshots also retain `original` values for regression inspection. Playback selects snapshots from deterministic traces rather than mutating a running engine.

`src/models/index.js` adapts six built-in architecture modules and registers declarative models. Built-ins retain their mechanism-specific behavior; `src/core/protocol.js` shares payload normalization, edge planning, frame boundaries, ACK stimulus, and terminal outcomes. Resource constraints deliberately produce different stalls, drift, or missed deadlines.

`src/model/validate.js` validates the declarative contract. `src/model/engine.js` evaluates bounded expressions and transitions without dynamic code execution. `src/model/stimulus.js` validates timed input events for both models and callers. Imported models must pass acceptance cases before registration; attached documents verify exact evidence quotations and page numbers.

`src/model/profiles/` compiles exact reviewed datasheet versions into JSON models. Imports require the pinned PDF hash, validate cited excerpts against the extracted pages, and run acceptance cases before persistence. The Nexperia 74HC595 profile is the first automatic path for a chip beyond the six architecture examples; existing authored source-linked models take precedence. See `DOCUMENT_PROFILES.md` to extend this registry.

`src/model/registers/gpio-expander.js` generates shared GPIO actions for the independently reviewed PCA9555 and TCA9534 profiles. Factories provide every byte address, label, and writable reset value; source-specific evidence and scope stay in the wrappers. It supports one or two eight-bit ports with per-bit direction, input-only inversion, latch readback, physical-level interrupt baselines, and released drivers. It is a trusted model construction helper, not a PDF classifier. Keep the independent one-/two-port byte and mixed-operation oracles when changing it.

`src/model/tables/` reads positioned function tables and compiles exhaustive binary or bounded edge-triggered logic into the shared model language. `src/documents/layout.js` shares geometry handling between Poppler and PDF.js. `src/model/from-document.js` applies reviewed profiles first, then data-derived tables. Table layout, symbol interpretation, indexed pin mapping, model generation, and scenario/check generation are separate modules. Sequential table compilation stores clock history in declared registers and retained state in output signals; it uses the existing JSON interpreter. `src/model/table-metadata.js` validates source-table snapshots before display. See `FUNCTION_TABLES.md` for supported symbols, bounds, and rejected cases.

`centered-headers.js` enumerates bounded contiguous header partitions, requiring a unique centered match for explicit input/output roles and hierarchical enable/select subgroups. It joins tightly adjacent numeric header suffixes without merging data cells. Preserve negative missing/ambiguous-header cases and both extraction-engine checks. The HD74HC138 original PDF supplies a complete six-input/eight-output regression oracle.

`layout-notes.js` joins bounded, matching-indentation numbered footnotes before validating the entire definition. `typed-pins.js` reads positioned NAME/NO./TYPE/DESCRIPTION roles with a complete local input-role legend. `clock-patterns.js` defines steady/transition clock masks and documented edge matching. Sequential list rows explicitly retain all outputs and store the clock pair before history changes; tightly positioned Q0 needs a local previous-state definition and one Q column. Neither helper supplies missing cells or infers package replication. Keep these syntactic rules independent of part names and fingerprints, with real PDFs, negative ambiguity cases, both extraction engines, and independent sequential oracles as regression evidence.

`src/model/templates.js` suggests conservative source excerpts and builds local scenarios using `src/model/builders/`. Counter, FIFO, and shifter rules are explicitly declared assumptions. Source matching confirms provenance, not circuit correctness. The builder validates generated definitions and checks before either interface installs them.

`src/model/register-tables/read.js` extracts bounded structural byte-register inventories from positioned headers and rows, independently of device names or fingerprints. It preserves unknown defaults, leaves all operation masks unresolved, and never installs a model. `from-document.js` exposes these as `registerTables` separately from executable models. Poppler and PDF.js scan up to 32 register-table pages in addition to the function-table budget. The terminal uses fresh inventories to prefill source-linked authoring; the optional browser renders escaped facts and exports the same unresolved templates. See `REGISTER_BANKS.md` for supported layouts and review requirements.

`src/model/register-bank/read.js` validates explicit address/mode/reset/mask rows; `build.js` produces uniform-width register actions with named access logs and optional validated transaction metadata. Balanced expression trees support the full 16-word bound without raising interpreter limits. `src/tui/register-bank-editor.js` owns its guided prompts. `src/tui/authoring.js` shares bounded regular-file loading, retry prompts, and unique catalog IDs with the behavior-table editor. Hardware-set events and their before/after bus ordering are explicit developer choices; no register semantics are inferred from names or PDF prose. See `REGISTER_BANKS.md`.

`src/model/builders/sourced.js` supplies the shared quotation/provenance/acceptance gate for developer-authored builders. `src/model/behavior-table/read.js` validates entered state/input/output rules and exhaustive agreeing coverage; `build.js` compiles them to the existing JSON language with named states and visible state codes. These rules are entered data, never an automatic PDF interpretation. Only retained output columns add a prior-state dimension. `src/tui/behavior-table-editor.js` owns prompts and bounded local rule-file loading; parsing/model behavior stay outside the terminal controller. Rule/source errors restore the authoring prompt before committing any model. The optional browser imports generated JSON using the same validator/engine, without adding a provider or separate interpreter.

`src/model/tables/retained-read.js` exhausts level-sensitive input/prior-output cases with explicit no-change semantics and requires complete agreeing rows. `retained-build.js` generates bounded actions, initial-state parameters, a Gray-code demonstration, acceptance cases, and source metadata. It shares the JSON engine, indexed-pin resolver, importer, rendering, and exports; it never invents a clock edge or package wiring. Unnumbered table IDs use their ordinal on the page so Poppler and PDF.js produce the same identity despite differing line counts. Multi-word headings must be adjacent within one source text item or a narrow word-spacing gap; separated column labels cannot be merged to hide a missing cell.

`src/core/logic.js` defines released-driver state Z, guarded truth evaluation, and VCD bit encoding. Only explicitly declared tri-state output signals can store Z; input stimulus and internal registers remain numeric. The interpreter must reject Z in numeric/boolean operations and conditions rather than relying on JavaScript coercion. Combinational table compilation supports explicitly defined Z outputs; sequential Z tables are still outside automatic scope. `src/ui/values.js` shares escaped browser values and `src/ui/logic-wave.js` draws release segments without numeric waveform coordinates for Z.

`behavior-table/behavior.js` is the pure table-to-model generator. `authoring.js` stores a portable bounded draft and compares its regenerated behavior against imported JSON, independent of object key order. `builders/assumptions.js` shares scenario/provenance wording. Optional authoring records never execute code; mismatches reject import. Legacy recovery requires exact regeneration, not a model name match. Extra independent cases remain part of revisions.

## Terminal interface

`src/tui/state.js` owns model selection, configuration, trace navigation, source search, and sessions. `src/tui/app.js` owns keyboard input, prompts, playback, and external-viewer handoff. `src/tui/render.js` draws terminal frames and strips control characters from untrusted content. `src/tui/workspace.js` stores copied PDFs, extracted text, and model JSON under `.chipsim/`; it uses atomic JSON replacement. Keep simulation behavior out of these modules.

`src/tui/source-simulations.js` owns the source-specific chooser and explicit find/create workflow. Read-only choices derive from installed models, not cached analysis IDs. Finding forces a fresh local extraction/hash check before previewing compiler results; creating one reserves a new ID and uses the normal source/check gate. Preserve active experiments on preview/cancel and existing models on creation. Menu items can provide a `detail` string, with bounded `h/l` scrolling for scope. Related built-in examples must remain distinguishable from document models.

`src/documents/cache.js` versions extracted source data and merges fresh extraction with stable document identity. Both extractors stamp the version. Old caches refresh on demand when opening the terminal register-bank builder or browser document dialog, using the workspace PDF or IndexedDB bytes. Verify the unchanged SHA-256 and all linked model citations before persisting; preserve models and experiments without rebuilding or reinstalling them. Replace stale analysis and scan-limit metadata rather than spreading the old record over new data. Refresh never installs newly compiled behavior. Bump the extraction version when newly retained source data needs a cache upgrade; avoid extracting all manuals during startup.

`src/core/trace-diff.js` compares bounded contiguous normalized traces by state, phase, signals, and registers, preserving released/zero/unavailable distinctions and ignoring presentation/log wording. `src/tui/trace-review.js` owns the read-only difference menus and portable comparison export. It captures the baseline session and proposed definition without seeking the working trace or installing a model. Equivalence is limited to the compared experiment.

Behavior-table revisions use `TuiState.previewRevision` to validate/check/simulate without mutation. Saves preserve compatible experiments, back up the prior session, atomically write the model, then commit state. Session loading likewise preflights parameters, inputs, and duration before installation; valid faulting traces remain loadable for inspection. Restore backs up the current session first. Failed writes leave the working model intact, although an already-written backup can remain. Edit drafts and file prompts stay in `behavior-table-editor.js`; no source inference occurs there.

Input-pin experiments use `TuiState.driveInput`: replace one pin/tick event, validate widths/direction, simulate before committing, and retain the cursor. A fault rejects the experiment without replacing the previous trace/stimulus. Shared-pin compilation resolves pin declarations in `src/model/tables/pins.js`; common controls are emitted once and remain consistent across every indexed channel.

`src/tui/stimulus.js` owns atomic event experiments, exact raw-event indices, and bounded model-local input/duration history. `stimulus-editor.js` owns terminal prompts and menus for scheduling and editing. Neither interprets datasheet semantics. The Stimulus view filters display rows while preserving original event indices, marks superseded same-pin/tick rows and unreachable events, and formats complete 32-bit values at the recommended terminal sizes. `views.js` supplies one catalog to the renderer, keyboard navigation, and snapshot CLI. Bulk input imports and history playback share the same simulate-before-commit path as direct pin edits. Addressed accesses record their whole transaction only after the existing acceptance/status checks succeed.

Addressed experiments use optional validated `registerInterface`/`registerMap` metadata (`src/model/register-interface.js`). `src/model/register-access.js` inserts a next-tick access and restores future accesses' original bus fields while rephasing request tokens. `TuiState.accessRegister` simulates before committing and rejects faults or unaccepted/error results atomically. Reads, writes, ignored read-only writes, reset priority, and interrupts remain model actions, not implicit adapter behavior. The reviewed PCA9555 and TCA9534 factories demonstrate this contract; see `MODEL_FORMAT.md` and `DOCUMENT_PROFILES.md`.

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
- `npm run test:dwfv -- /path/to/dwfv`: optional real VCD parser interoperability for six built-ins, two generated scenarios, entered register banks, reviewed profiles, and compiled function-table models, including unknown register values.
- `npm run build && npm run verify:web`: default verification plus the portable browser bundle.
- `npm run test:ui`: Chromium controls, exports, local PDF extraction/storage, sourced model import/rejection, guided builders, sessions, mobile layout, and offline direct-file use.
- `npm run format`: Prettier for repository JavaScript, JSON, HTML, and Markdown.

Install Chromium once with `npx playwright install chromium`. Browser tests use their own contexts, not the user's browsing session. Tests store temporary terminal workspaces outside the repository.

## Review limits

Quote verification normalizes whitespace and confirms the quote exists on the cited page. Different PDF text engines can differ in hyphenation or ligatures; choose robust excerpts and check both interfaces when needed. Scanned documents require OCR outside ChipSim.

Timing is normalized, not cycle accurate. eTPU distinguishes capture arrival from shared service time; adjustable ACK capture remains independent of final CLK bookkeeping. VCD files declare a conventional time unit for viewer compatibility, and explicitly label timestamps as normalized ticks. Registers with no value yet are exported as unknown, not zero.

No LLM integration is present. Complete binary function tables can produce models from their content; they do not establish behavior beyond the table scope. Arbitrary-chip modeling still requires developer interpretation and verification. Importing an unfamiliar manual offers local source search, guided scenarios, a constrained model format, and acceptance checks; it does not reconstruct a complete chip automatically.
