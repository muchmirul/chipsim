# Terminal workbench

The TUI is ChipSim's primary interface. `npm start` runs it directly, with no generated browser bundle. Node.js 22.13+ is required; PDF extraction additionally requires Poppler. `node scripts/chipsim.mjs --help` lists launch options.

## Working session

Choose a model with `m`, edit parameters with `p`, and press Space to run. Playback stops at a terminal outcome or trace end. `h/l` and arrows move through the trace. `w/e/b` find rising/falling/previous rising edges of the selected signal. `[ ]` find changes across the whole model. Numeric presentation cycles with uppercase `F` and preserves the cursor.

Views are:

1. **Waveforms**: signal shapes, cursor, selected value, compact register summary, and current event. `j/k` selects a signal and scrolls the visible signal list.
2. **Hardware blocks**: active resources, live node values, and connections. A resource marked ACTIVE participated at the selected tick. `j/k` scrolls the block grid when it exceeds the terminal height.
3. **Log**: all trace events, with changes-only mode on by default. `/` filters by state/event/register text; uppercase `C` toggles changes-only. Select a row and Enter seeks to its tick.
4. **Sources**: the imported PDF's text by original PDF page. `h/l` changes pages, `j/k` scrolls, `/` searches, `n/N` cycles matching pages. Enter chooses a cached PDF or imports the first bundled source when no document is loaded.
5. **Model**: scope, assumptions, parameters, source fingerprints, evidence quotations, warnings, and implementation recipe. `j/k` scrolls.
6. **Registers**: every signal/register and its change at this tick. `j/k` selects, `/` filters, and `h/l` moves the timeline.
7. **Input stimulus**: explicit scheduled pin events, values, hold intervals, and events outside the current trace. `j/k` selects a row; Enter opens edit/move/remove/seek actions. `i` schedules an event at a chosen tick. `/` filters pin names or tick numbers; `F` changes numeric presentation.

Prompts accept Enter for their displayed default. Type a value to replace it; Backspace deletes, Ctrl-U clears, and Esc cancels. Boolean and enum parameters have menus. Integer parameters support decimal, hexadecimal, binary, and octal. Released output drivers display `Z` in every numeric format. Waveforms show labeled middle/dotted segments; `f` accepts `Z` for tri-state output search. Rising/falling edge jumps require numeric levels; any-change navigation includes releases and re-enables. `i` opens input-pin editing at the cursor. Select a pin, enter a decimal/hex/binary/octal value, and its outputs/logs/waveforms are recomputed while preserving the cursor. It replaces an existing event for that pin/tick and keeps other scheduled events. Values hold until the pin's next event. Invalid widths or simulation faults keep the previous trace and stimulus. `S` saves the edited stimulus with a session. Long or multiline input stimulus should be loaded from a JSON file with `a`.

## Input stimulus timeline

Open `7` to build an experiment without writing JSON. Press `a` and choose **Clear all explicit events** to start with the model's initial pin values, then `i` to choose a pin, tick, and value. Ticks and values accept decimal, `0x`, `0b`, and `0o`. Document models extend their duration when an added or moved event is later than the current end, up to tick 10000. Built-in traces follow their frame/ACK parameters; an event they do not reach stays listed as **outside current trace**. Imported JSON may also contain events beyond the chosen duration.

Enter opens actions for a selected row: seek its waveform, edit its value, move it, or remove it. Delete/Backspace removes the selected event directly. Moving or adding onto another event for the same pin/tick is rejected; edit that existing row instead. Different pins can change at the same tick and are all applied before evaluation. Imported duplicate pin/tick events keep their order and last-value behavior; earlier rows are marked **superseded at same tick**. Removing the last duplicate exposes the preceding value. Filtering never changes which original event is edited. Ctrl-U then Enter clears a filter.

`a` also restores the demonstration events or loads a JSON array/file. Clear leaves document inputs at their declared initial values; with no explicit events, the original six examples use their ACK parameters. Event values hold until the pin's next event. This is normalized stimulus, not physical setup/hold timing. The timeline lists raw pin changes, including register-interface request fields; `u` remains the convenient way to insert a complete addressed transaction while preserving later accesses.

Uppercase `U` undoes and `R` redoes stimulus changes from any view, including direct pin edits (`i`), bulk loads (`a`), and addressed accesses (`u`). Each model retains at most 20 changes in memory. Changes and history playback simulate before committing; invalid values, collisions, and arithmetic faults preserve the prior configuration, trace, and history. Undo restores inputs and any duration extension while keeping the cursor within the restored trace. New edits discard redo history. Parameter/duration edits, model replacement, or session loading clear that model's history. History itself is not saved; `S` saves the current experiment's model, parameters, stimulus, duration, cursor, and display format.

## Local source workflow

Models with a declared register transaction interface support `u`: choose a named address and Read or Write. Write values accept decimal, `0x`, `0b`, and `0o`; widths are checked. The access replaces any register access at the next tick, advances the cursor to that result, and extends the trace by one tick when needed. Future scheduled accesses keep their address, operation, and data; request tokens are rephased so insertion cannot suppress them. Unrelated input events remain. Rejected accesses and simulation faults preserve the old trace/configuration. Read-only write behavior is defined by the model, not forced by the menu. `6` labels mapped values by address/name, and `/` can find these names. `S` saves the resulting input events.

Try `npm start -- --document docs/references/ti-pca9555.pdf`. Its default trace demonstrates GPIO latch/direction writes, interrupt persistence after a wrong-bank input read, right-bank acknowledgment, inversion, and power reset. `external0`/`external1` provide explicit input-port levels; `power_reset` is a scenario operation, not a physical reset pin. `int_driver` reports low or released (`Z`); it does not resolve an external pull-up. See `DOCUMENT_PROFILES.md` for its timing and erratum limits.

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

## dwfv

Reference: https://github.com/psurply/dwfv. Reviewed revision: `fe89ba62d8ddcf95f8476d6b8a8c5714f1a64b6f` (Cargo version 0.5.0). Its upstream code is MIT licensed; no source code from it is copied into ChipSim.

The reference informed `h/j/k/l`, edge navigation, cursor positioning, zoom, and search. ChipSim implements these around its simulation state and source workspace. Press uppercase `V` to export the current trace and launch an installed `dwfv`. Quit its viewer to return to ChipSim. For a custom executable use `--dwfv /path/to/dwfv` or `CHIPSIM_DWFV`.

Upstream installation instructions include `cargo install dwfv` or cloning the repository and `cargo install --path .`. Rust is required for installing/building that optional viewer, not for ChipSim itself. Compatibility was checked against the reviewed checkout using traces from all six built-ins and 32-bit FIFO/shifter scenarios, including undefined register values. The reviewed 74HC595 profile and all compiled function-table models are included in the interoperability check too.

Run `npm run test:dwfv -- /path/to/dwfv` to repeat parser checks with a chosen binary. `npm run test:tui` runs real POSIX terminal tests covering keyboard controls, export, resize, PDF-to-model creation, and terminal mode restoration. Node tests also verify rendering at 80×24 and 120×40. The app restores the cursor and previous terminal mode on normal quit, Ctrl-C, and handled termination.
