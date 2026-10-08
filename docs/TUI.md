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

Prompts accept Enter for their displayed default. Type a value to replace it; Backspace deletes, Ctrl-U clears, and Esc cancels. Boolean and enum parameters have menus. Integer parameters support decimal, hexadecimal, binary, and octal. `i` opens input-pin editing at the cursor. Select a pin, enter a decimal/hex/binary/octal value, and its outputs/logs/waveforms are recomputed while preserving the cursor. It replaces an existing event for that pin/tick and keeps other scheduled events. Values hold until the pin's next event. Invalid widths or simulation faults keep the previous trace and stimulus. `S` saves the edited stimulus with a session. Long or multiline input stimulus should be loaded from a JSON file with `a`.

## Local source workflow

`d` loads a PDF, model JSON, or shared session JSON. PDFs are copied into the workspace and extracted with Poppler without a network call. Search results use one-based PDF pages, including front matter. Matching installed models are selected only after validating quotes against the loaded document. An exact match to a reviewed document profile creates and saves its model automatically if no authored model is linked to that source. `--list-profiles` lists reviewed datasheet versions; see `DOCUMENT_PROFILES.md`. Other PDFs can also create models from complete binary or supported edge-triggered function tables; see `FUNCTION_TABLES.md`. Model view includes their source rows and instance mapping. Sequential models also expose clock-history registers, retained outputs, and an initial-output parameter. Original source symbols are preserved for review; initial states and timing abstractions are explicit assumptions.

`c` creates a counter, FIFO, or shift-transfer scenario from the current document. It offers matching source excerpts and any explicit bit-width wording found. Configure its fields, cite the page/excerpt, and describe the excerpt's relevance. The rules are explicit scenario assumptions, visible in Model view and exported JSON. The builder generates acceptance cases and runs them before installing the model.

Counter models include reset/enable, up/down counting, periodic toggle or halt-at-compare. FIFO models retain 1–16 words of 1–32 bits and model pointers, occupancy, overflow, underflow, and simultaneous requests. Shift-transfer models expose bit order, clock phases, start/reset, and a modeled receiver. They are configurable peripheral scenarios; they do not assert every detail is specified by the selected quote.

Use `M` to export a document model and `B` to export the current document's source bundle. Sources omit local file paths and PDF bytes from that bundle. A developer/agent can extend the model using `AGENTS.md` and `MODEL_FORMAT.md`, then reload it with `d`.

## Persistence and exports

By default `.chipsim/` lives in the launch directory:

```text
.chipsim/
  documents/<fingerprint>.pdf       Cached original PDF
  documents/<fingerprint>.json      Text pages and provenance
  models/<model-id>.json            Validated authored/generated model
  exports/<model-id>.vcd            Trace prepared for an external viewer
```

It is Git-ignored. `--workspace PATH` chooses another directory. Terminal and browser workspaces are separate; shared model/session JSON is portable between interfaces. Session JSON includes the primary model, parameters, inputs, duration, tick, and display format; it does not include PDFs.

`x` exports the complete primary trace as CSV, JSON, or VCD. JSON includes provenance and a custom model's executable definition. Values not yet defined, such as an unarmed deadline, appear as unknown in VCD. VCD timestamps carry a nominal `1ns` scale for tool compatibility; each unit is an abstract model tick.

## dwfv

Reference: https://github.com/psurply/dwfv. Reviewed revision: `fe89ba62d8ddcf95f8476d6b8a8c5714f1a64b6f` (Cargo version 0.5.0). Its upstream code is MIT licensed; no source code from it is copied into ChipSim.

The reference informed `h/j/k/l`, edge navigation, cursor positioning, zoom, and search. ChipSim implements these around its simulation state and source workspace. Press uppercase `V` to export the current trace and launch an installed `dwfv`. Quit its viewer to return to ChipSim. For a custom executable use `--dwfv /path/to/dwfv` or `CHIPSIM_DWFV`.

Upstream installation instructions include `cargo install dwfv` or cloning the repository and `cargo install --path .`. Rust is required for installing/building that optional viewer, not for ChipSim itself. Compatibility was checked against the reviewed checkout using traces from all six built-ins and 32-bit FIFO/shifter scenarios, including undefined register values. The reviewed 74HC595 profile and all compiled function-table models are included in the interoperability check too.

Run `npm run test:dwfv -- /path/to/dwfv` to repeat parser checks with a chosen binary. `npm run test:tui` runs real POSIX terminal tests covering keyboard controls, export, resize, PDF-to-model creation, and terminal mode restoration. Node tests also verify rendering at 80×24 and 120×40. The app restores the cursor and previous terminal mode on normal quit, Ctrl-C, and handled termination.
