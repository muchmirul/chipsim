# Terminal workbench

The TUI is ChipSim's primary interface. `npm start` runs it directly, with no generated browser bundle. Node.js 22.13+ is required; PDF extraction additionally requires Poppler. `node scripts/chipsim.mjs --help` lists launch options.

## Working session

Choose a model with `m`, edit parameters with `p`, and press Space to run. Playback stops at a terminal outcome or trace end. `h/l` and arrows move through the trace. `w/e/b` find rising/falling/previous rising edges of the selected signal. `[ ]` find changes across the whole model. Numeric presentation cycles with uppercase `F` and preserves the cursor.

Views are:

1. **Waveforms**: signal shapes, cursor, selected value, compact register summary, and current event. `j/k` selects a signal and scrolls the visible signal list.
2. **Hardware blocks**: active resources, live node values, and connections. A resource marked ACTIVE participated at the selected tick. `j/k` scrolls the block grid when it exceeds the terminal height.
3. **Log**: all trace events, with changes-only mode on by default. `/` filters by state/event/register text; uppercase `C` toggles changes-only. Select a row and Enter seeks to its tick and opens complete step details.
4. **Sources**: the imported PDF's text by original PDF page. `h/l` changes pages, `j/k` scrolls, `/` searches, `n/N` cycles matching pages. Enter chooses a cached PDF or imports the first bundled source when no document is loaded.
5. **Model**: scope, assumptions, parameters, source fingerprints, evidence quotations, warnings, and implementation recipe. `j/k` scrolls.
6. **Registers**: every signal/register and its change at this tick. `j/k` selects, `/` filters, and `h/l` moves the timeline.
7. **Input stimulus**: explicit scheduled pin events, values, hold intervals, and events outside the current trace. `j/k` selects a row; Enter opens edit/move/remove/seek actions. `i` schedules an event at a chosen tick. `/` filters pin names or tick numbers; `F` changes numeric presentation.

Prompts accept Enter for their displayed default. Type a value to replace it; Backspace deletes, Ctrl-U clears, and Esc cancels. Boolean and enum parameters have menus. Integer parameters support decimal, hexadecimal, binary, and octal. Released output drivers display `Z` in every numeric format. Waveforms show labeled middle/dotted segments; `f` accepts `Z` for tri-state output search. Rising/falling edge jumps require numeric levels; any-change navigation includes releases and re-enables. `i` opens input-pin editing at the cursor. Select a pin, enter a decimal/hex/binary/octal value, and its outputs/logs/waveforms are recomputed while preserving the cursor. It replaces an existing event for that pin/tick and keeps other scheduled events. Values hold until the pin's next event. Invalid widths or simulation faults keep the previous trace and stimulus. `S` saves the edited stimulus with a session. Long or multiline input stimulus should be loaded from a JSON file with `a`.

## Reading waveforms and step details

Bus labels stay inside their constant-value segment. A complete shorter spelling, such as `0xB3` instead of `0x000000B3`, can appear when space is limited; it represents the same value and base. If no complete label fits, `…` marks the segment. Press `+` to zoom in, `-` to zoom out, and `=` to fit. The selected signal's exact value remains below the waveforms, and `6` lists exact values at the cursor.

When a terminal column covers multiple ticks with different values, `≋` marks that column. A short pulse or a release/re-enable cannot silently become a flat level through downsampling. This marker does not specify the number or ordering of transitions; zoom in or step to inspect them. `x` denotes unavailable data inside the trace, `Z` a released driver, and blank space lies outside the trace. The cursor does not overwrite a numeric label or hide a mixed-value marker. These are display conventions, not new simulated logic states.

Press **Enter** in Waveforms, Hardware blocks, or Registers to inspect the current step. In Log, Enter selects that row's tick and opens the same view. It pauses playback and shows the full event message, any fault/detail text, changed values at their declared widths, explicit scheduled inputs in order, and the step's source citations. Long messages, identifiers and values wrap without losing text. `j/k` or arrows scroll, PageUp/PageDown move a page, and Home/End or `0/$` jump to the beginning/end. `[` and `]` inspect the previous/next changed tick. `F` changes the numeric base. Esc, Enter or `q` closes the details without editing the experiment.

For register-interface models, details identify the mapped offset, operation, write data or accepted read result, and the model's adapter status. An ignored/rejected read does not present the previous `read_data` as a new result. Register effects remain defined by the model; the inspector does not infer them from names. At tick zero, the request level is only an initialization baseline.

Press `s` in details to choose a step citation and open its exact page in an already-loaded PDF. Missing PDFs leave the details open with an import hint; steps without individual citations say so. Model view (`5`) still supplies the overall references and assumptions. Inspection leaves parameters, stimulus, history and exported trace data unchanged; navigating explicitly moves the cursor.

## Input stimulus timeline

Open `7` to build an experiment without writing JSON. Press `a` and choose **Clear all explicit events** to start with the model's initial pin values, then `i` to choose a pin, tick, and value. Ticks and values accept decimal, `0x`, `0b`, and `0o`. Document models extend their duration when an added or moved event is later than the current end, up to tick 10000. Built-in traces follow their frame/ACK parameters; an event they do not reach stays listed as **outside current trace**. Imported JSON may also contain events beyond the chosen duration.

Enter opens actions for a selected row: seek its waveform, edit its value, move it, or remove it. Delete/Backspace removes the selected event directly. Moving or adding onto another event for the same pin/tick is rejected; edit that existing row instead. Different pins can change at the same tick and are all applied before evaluation. Imported duplicate pin/tick events keep their order and last-value behavior; earlier rows are marked **superseded at same tick**. Removing the last duplicate exposes the preceding value. Filtering never changes which original event is edited. Ctrl-U then Enter clears a filter.

`a` also restores the demonstration events or loads a JSON array/file. Clear leaves document inputs at their declared initial values; with no explicit events, the original six examples use their ACK parameters. Event values hold until the pin's next event. This is normalized stimulus, not physical setup/hold timing. The timeline lists raw pin changes, including register-interface request fields; `u` remains the convenient way to insert a complete addressed transaction while preserving later accesses.

Uppercase `U` undoes and `R` redoes stimulus changes from any view, including direct pin edits (`i`), bulk loads (`a`), and addressed accesses (`u`). Each model retains at most 20 changes in memory. Changes and history playback simulate before committing; invalid values, collisions, and arithmetic faults preserve the prior configuration, trace, and history. Undo restores inputs and any duration extension while keeping the cursor within the restored trace. New edits discard redo history. Parameter/duration edits, model replacement, or session loading clear that model's history. History itself is not saved; `S` saves the current experiment's model, parameters, stimulus, duration, cursor, and display format.

## Local source workflow

Press `4` to read a manual, then `o` for its **Simulations** menu. Installed document models and related architecture examples have separate labels; the menu shows the selected model's declared scope. `j/k` chooses an item and `h/l` scrolls the scope. Opening the already-active model keeps its cursor, parameters, stimulus and undo history. Source text shows the number of associated simulations; saved analysis metadata cannot create phantom library entries.

Choose **Find supported simulations in saved PDF** to check for newly supported behavior without locating or reimporting the external file. ChipSim rereads and fingerprints the saved PDF, verifies linked citations, and runs the available compilers/checks. The resulting menu previews each scope. Enter creates only the selected simulation, using a new model ID so existing authored models and their experiments remain intact. Esc cancels creation. A failed fingerprint or source check leaves the previous source and experiment intact. If no compiler supports the behavior, **Create a sourced scenario** opens the local builders. This is an explicit search/create action; reading sources does not generate new models.

Models with a declared register transaction interface support `u`: choose a named address and Read or Write. Write values accept decimal, `0x`, `0b`, and `0o`; widths are checked. The access replaces any register access at the next tick, advances the cursor to that result, and extends the trace by one tick when needed. Future scheduled accesses keep their address, operation, and data; request tokens are rephased so insertion cannot suppress them. Unrelated input events remain. Rejected accesses and simulation faults preserve the old trace/configuration. Read-only write behavior is defined by the model, not forced by the menu. `6` labels mapped values by address/name, and `/` can find these names. `S` saves the resulting input events.

Try `npm start -- --document docs/references/ti-pca9555.pdf`. Its default trace demonstrates GPIO latch/direction writes, interrupt persistence after a wrong-bank input read, right-bank acknowledgment, inversion, and power reset. `external0`/`external1` provide explicit input-port levels; `power_reset` is a scenario operation, not a physical reset pin. `int_driver` reports low or released (`Z`); it does not resolve an external pull-up. See `DOCUMENT_PROFILES.md` for its timing and erratum limits.

Try `npm start -- --document docs/references/ti-tca9534.pdf` for the one-port variant: `u` lists Input (0), Output (1), Polarity (2), and Configuration (3). `external0` drives explicit P0–P7 scenario inputs, and each output driver is visible separately. Its default trace leaves INT pending after an Output read at tick 10 and releases it after an Input read at tick 12. The addressed-byte scope omits physical bus signaling, persistent command-pointer history, and ACK-related interrupt races.

`d` loads a PDF, model JSON, or shared session JSON. PDFs are copied into the workspace and extracted with Poppler without a network call. Search results use one-based PDF pages, including front matter. Matching installed models are selected only after validating quotes against the loaded document. An exact match to a reviewed document profile creates and saves its model automatically if no authored model is linked to that source. `--list-profiles` lists reviewed datasheet versions; see `DOCUMENT_PROFILES.md`. Other PDFs can also create models from complete binary, supported edge-triggered, or level-sensitive retention tables; see `FUNCTION_TABLES.md`. Model view includes their source rows and instance mapping. Sequential models also expose clock-history registers, retained outputs, and an initial-output parameter. Original source symbols are preserved for review; initial states and timing abstractions are explicit assumptions.

Try `npm start -- --document docs/references/renesas-hd74hc138.pdf` for a decoder generated entirely from the function table. At tick zero, `i` drives G1=1 with G2A/G2B still zero; Y0 becomes low. Drive A=1 to select Y1, then G2A=1 to disable all eight outputs. `6` shows every output; JSON/CSV/VCD exports include all 14 binary signals. The model covers ideal table behavior, without electrical timing or physical pin-number mapping.

Try `npm start -- --document docs/references/ti-sn74ahc273-q1.pdf` for one flip-flop table instance with asynchronous clear. Model view preserves its `Q0` prior-state notation and `L, H, ↓` clock list. The pair register distinguishes steady low (0), rising (1), falling (2), and steady high (3). At tick 15, use `i` to change D to zero while CLK remains high: Q retains one from the preceding rising edge. `7` lets you schedule later falling/rising edges and observe when data is captured; `U` restores the prior experiment. The generic table does not establish eight package channels.

`c` creates a counter, FIFO, shift-transfer scenario, or custom behavior table from the current document. Fixed scenarios offer matching source excerpts and any explicit bit-width wording found. Configure the fields, cite the page/excerpt, and describe the excerpt's relevance. The rules are explicit scenario assumptions, visible in Model view and exported JSON. The builder generates acceptance cases and runs them before installing the model.

Behavior table defines input/output pin order, named states, and rows such as `idle 01 -> armed / 1`. Enter semicolon-separated rows or `@path/to/rules.txt`. Input X is a wildcard; output = explicitly retains; current state * matches every state. Complete coverage and agreeing overlaps are required; no priority, reset, or clock is inferred. Bad rows/source excerpts keep the prompt available for correction. Tick zero initializes the selected scenario; one row executes per later normalized tick. `p` configures initial state/output bits; logs identify entered rows and actual named states, and `behavior_state` exposes the state code. See `BEHAVIOR_TABLES.md` for examples, explicit clock-history modeling, bounds, and provenance limits.

Counter models include reset/enable, up/down counting, periodic toggle or halt-at-compare. FIFO models retain 1–16 words of 1–32 bits and model pointers, occupancy, overflow, underflow, and simultaneous requests. Shift-transfer models expose bit order, clock phases, start/reset, and a modeled receiver. They are configurable peripheral scenarios; they do not assert every detail is specified by the selected quote.

Use `M` to export a document model and `B` to export the current document's source bundle. Sources omit local file paths and PDF bytes from that bundle. A developer/agent can extend the model using `AGENTS.md` and `MODEL_FORMAT.md`, then reload it with `d`.

Uppercase `E` revises an entered behavior table: edit fields, review outputs at the current tick or browse full-trace differences without committing, save a compatible revision or new copy, export rows, and restore revision backups. Esc retains the draft in memory; Discard clears it. See `BEHAVIOR_TABLES.md` for compatibility, source checks, independent cases, and backup limits.

## Persistence and exports

By default `.chipsim/` lives in the launch directory:

```text
.chipsim/
  revisions/<model-id>/   # earlier model + experiment sessions
  documents/<fingerprint>.pdf       Cached original PDF
  documents/<fingerprint>.json      Text pages and provenance
  models/<model-id>.json            Validated authored/generated model
  exports/<model-id>.vcd            Trace prepared for an external viewer
```

It is Git-ignored. `--workspace PATH` chooses another directory. Terminal and browser workspaces are separate; shared model/session JSON is portable between interfaces. Session JSON includes the primary model, parameters, inputs, duration, tick, and display format; it does not include PDFs.

`x` exports the complete primary trace as CSV, JSON, or VCD. JSON includes provenance and a custom model's executable definition. Values not yet defined, such as an unarmed deadline, appear as unknown in VCD. VCD timestamps carry a nominal `1ns` scale for tool compatibility; each unit is an abstract model tick.

Draft review comparison JSON uses `format: "chipsim-trace-comparison"`, version 1. It contains the baseline session, draft model, and all state/phase/signal/register differences in a normalized-tick comparison. Unavailable/uninitialized values are `null`, distinct from numeric zero and `"Z"`. This is an inspection artifact, not a loadable session or acceptance test; identical observed traces do not prove equivalence for other experiments.

## Register-bank authoring

Press `c` and choose **Register bank** to enter explicit `NAME ADDRESS MODE RESET MASK` rows or load `@file`. Choose a 1–32-bit word width, before/after synthetic hardware-set ordering, a source page/quote/claim, and assumptions. Invalid row or quote prompts stay available for correction; Ctrl-U clears the current entry. Source checks and generated acceptance cases must pass before installation. This is a developer-authored path for unsupported register manuals, not inferred PDF semantics.

When a supported command-byte/register-map table is found, Register bank first offers its source-derived draft or manual entry. A selected draft prefills byte width, addresses, access labels, known defaults, source page and quote. Unknown resets and all masks remain `?`; replace them with reviewed scenario choices before creation. Choose **Export row draft** to edit a regular row file outside the TUI; existing files are preserved. Reopen the builder and load it with `@file`. These inventories provide structural facts, without inferring GPIO/interrupt or other peripheral side effects.

Older workspaces refresh their extracted source data from the saved PDF when you open Register bank. This happens once per extraction version, on demand. ChipSim verifies the PDF fingerprint and existing model citations before saving the new cache; it preserves authored models, parameters, stimulus, undo history and the trace cursor. It does not compile or install replacement models during refresh. If the saved PDF is missing or has changed, restore the original or import it with `d`; a failed refresh leaves the cache and experiment intact.

Use `u` for named addressed reads/writes, `i` or `7` for `set_NAME` injections, `6` for storage changes, and `S`/`M` to save experiments/export models. `reset` is a whole-bank scenario reset; read-to-clear returns the pre-clear word. Hardware set inputs remain asserted until returned to zero. See [REGISTER_BANKS.md](REGISTER_BANKS.md) for masks, ordering, limits, and the real RP2040 scratch-register example.

For the supplied ESP32-C6 manual, see [the PCNT channel-0 walkthrough](ESP32_C6_PCNT.md). Importing it opens a bounded signed pulse-count experiment; parameters configure edges, control modes and limits. The same manual also supplies [GPIO output registers](ESP32_C6_GPIO.md): use `o` to choose, then `u` for relative-offset word accesses. Write-action aliases offer only Write; no readback is invented. Older workspaces can add this profile through `o` → Find supported simulations in saved PDF.

## dwfv

Reference: https://github.com/psurply/dwfv. Reviewed revision: `fe89ba62d8ddcf95f8476d6b8a8c5714f1a64b6f` (Cargo version 0.5.0). Its upstream code is MIT licensed; no source code from it is copied into ChipSim.

The reference informed `h/j/k/l`, edge navigation, cursor positioning, zoom, and search. ChipSim implements these around its simulation state and source workspace. Press uppercase `V` to export the current trace and launch an installed `dwfv`. Quit its viewer to return to ChipSim. For a custom executable use `--dwfv /path/to/dwfv` or `CHIPSIM_DWFV`.

Upstream installation instructions include `cargo install dwfv` or cloning the repository and `cargo install --path .`. Rust is required for installing/building that optional viewer, not for ChipSim itself. Compatibility was checked against the reviewed checkout using traces from all six built-ins and 32-bit FIFO/shifter scenarios, including undefined register values. All reviewed profiles (74HC595, PCA9555, TCA9534, and ESP32-C6 PCNT/GPIO) and compiled function-table models are included in the interoperability check too.

Run `npm run test:dwfv -- /path/to/dwfv` to repeat parser checks with a chosen binary. `npm run test:tui` runs real POSIX terminal tests covering keyboard controls, export, resize, PDF-to-model creation, and terminal mode restoration. Node tests also verify rendering at 80×24 and 120×40. The app restores the cursor and previous terminal mode on normal quit, Ctrl-C, and handled termination.
