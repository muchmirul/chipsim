# Working on ChipSim

ChipSim is a local hardware behavior workbench. Keep the six supplied architecture examples usable, and make new document-backed models use the same inspection, waveform, and trace interface.

## Read first

- `README.md`: user workflow, setup, and current limits.
- `docs/FUNCTION_TABLES.md`: local data-derived combinational/sequential logic compilation and limits.
- `docs/DOCUMENT_PROFILES.md`: reviewed automatic datasheet compilation and extension requirements.
- `docs/TUI.md`: primary terminal interface, keys, source workflow, and dwfv interoperability.
- `docs/MODEL_FORMAT.md`: the declarative model contract and execution order.
- `docs/DEVELOPMENT.md`: source layout, build, verification, and extension points.
- `docs/REFERENCES.md`: pinned vendor PDFs and model scope.

Do not edit `chipsim.html` or `.generated/`; these are build outputs. Edit `src/`, the HTML shell, and model JSON. Do not reintroduce a monolithic simulation script.

## Commands

Use Node.js 22.13 or newer:

```sh
npm ci
npm start
npm test
npm run verify
```

`npm start` and `npm run dev` launch the TUI. The default verification checks all engine/builder/terminal unit tests, real PTY interaction, and pinned vendor sources and reviewed document profiles. PDF import requires Poppler's `pdfinfo` and `pdftotext`; the PTY test requires Python 3 on POSIX.

For terminal changes, inspect the affected view at 80×24 and 120×40, and run `npm run test:tui`. For browser changes, also run:

```sh
npm run build
npm run verify:web
npx playwright install chromium
npm run test:ui
```

The optional browser server is `npm run web` at `127.0.0.1:8000`; `npm run dev:web` watches and rebuilds it. Restart the watcher after changing packaged model JSON. Keep simulations, parameters, stimulus, source verification, and export formats shared between interfaces.

## Creating a simulation from a manual

1. Define a useful, bounded peripheral scenario: e.g. FIFO transfer, counter match, interrupt acknowledgment. A PDF is a source, not an executable hardware model.
2. Extract the supplied manual using `B` in the TUI, the browser's **Export sources for agent**, or `npm run extract -- manual.pdf manual.sources.json`. The CLI requires Poppler's `pdfinfo` and `pdftotext`. Preserve the PDF SHA-256 and **one-based PDF page numbers**, including front matter.
3. Read the relevant sections, reset values, register widths, ordering rules, peripheral diagrams, and errata if supplied. Use exact short quotes and cite their PDF page. Do not fabricate sources, bit fields, addresses, internal structures, timings, or reset behavior.
4. Author a schema-version-1 JSON model following `docs/MODEL_FORMAT.md`. Use `examples/timer.model.json` as a syntax example. Its timer rules are explicitly illustrative; do not copy its assumptions as vendor facts.
5. Declare what is modeled, what is omitted, and which behavior is an assumption. Distinguish vendor-specified behavior from a developer-selected test scenario. Keep normalized ticks separate from physical cycles.
6. Add executable acceptance cases covering reset, normal operation, boundaries, and at least one relevant failure or disabled condition. Derive expected results independently from the documented behavior. Width wrapping, input ordering, terminal latching, and deadlines need specific expectations where relevant.
7. Validate against the actual source bundle:

   ```sh
   npm run model -- validate path/to/chip.model.json --sources manual.sources.json
   npm run model -- simulate path/to/chip.model.json --ticks 100 --format json --out trace.json
   ```

8. Import the PDF and model JSON with `d` in the TUI (and in the browser if browser behavior changed). Confirm that source verification succeeds, inspect transitions and register changes, and export a trace. A quote match proves textual provenance; it does not prove the interpretation or silicon accuracy.
9. For a checked-in model, put JSON under `models/`, rerun the build, and add focused tests. Check redistribution terms before checking in a new vendor PDF. Add reference provenance to the manifest and notices when appropriate; preserve existing PDF bytes and hashes.

If a manual does not specify enough behavior, report the gap and offer an explicit configurable assumption. Do not claim that an invented model was generated accurately from the datasheet.

## Architecture and invariants

- `src/models/builtins/` holds the six original mechanisms; shared protocol behavior is in `src/core/`.
- `src/tui/` owns terminal state, controller, rendering, and workspace persistence. Keep ANSI/control characters from imported text out of rendered terminal output; restore raw mode and the cursor on exit or external-viewer handoff.
- `src/model/profiles/` holds reviewed datasheet compilers. Require an exact pinned PDF fingerprint, real-page quote validation, independently justified behavior checks, and explicit limitations. A chip name or matching excerpt alone is insufficient to auto-compile an unreviewed revision. Never overwrite an authored model already linked to the source.
- `src/model/tables/` derives combinational and supported edge-triggered logic from positioned function tables. Require explicit column roles, defined symbols, exhaustive binary coverage, agreeing overlaps, and independent regression oracles. Shared controls must be single declared input pins; keep one signal/event per shared pin and preserve independent indexed data paths. Sequential compilation requires explicitly defined clock arrows, a matching edge-triggered clock-pin description, exhaustive previous-clock/input/retained-state checks, and an explicit initial-state scenario. Tick zero must not invent an edge; asynchronous table rows can act immediately. Combinational Z outputs require explicit local high-impedance definitions and exhaustive binary-input coverage. Numbered header footnotes must have complete local symbol definitions; timing/prose qualifications require review. Reject undefined active edges, conflicting rows, missing/merged cells, and unsupported state/tri-state semantics; never fill them by guesswork. `src/model/from-document.js` applies the shared interpretation policy.
- `src/model/templates.js` and `src/model/builders/` provide guided, sourced peripheral scenarios. Their generated rules are explicit assumptions, not inferred vendor behavior.
- `src/model/validate.js` is the authoritative model validator. `src/model/engine.js` interprets bounded expressions and state transitions. Imported models are data: never execute embedded JavaScript, `eval`, or dynamic functions.
- Only declared `triState: true` output signals can hold literal `"Z"`. It denotes a released driver, not an external bus voltage. Keep inputs and registers numeric. Never coerce Z through arithmetic, bitwise operations, conditions, numeric formatting, or VCD encoding; equality/inequality can compare it explicitly. Do not infer pull-ups, floating-node voltage, or contention. CSV/JSON/VCD and both waveform renderers must preserve Z.
- Input events drive **input** signals only, before a model step, and hold values until changed. Actions can write declared registers and output signals only.
- Actions execute in order; values wrap at their declared width. At most one transition is taken per tick. Terminal states latch, while externally driven signals remain observable.
- Built-in DATA transfers are LSB-first, with 8 or 12 bits. CLK rising edges sample DATA. Payload inputs accept decimal and `0x`, `0b`, `0o`; plain digit strings are decimal. A display change must preserve numerical values and playback position.
- Preserve architecture-specific constraints. PRU polling, PIO FIFO stalls, UDB logic, FlexIO host branching, XMOS pending writes, and eTPU capture/service behavior must not collapse into identical mechanisms.
- CSV, JSON, and VCD describe the same trace. JSON includes model provenance and parameters; VCD time units are normalized ticks, not a claim of nanosecond timing.
- No LLM integration is requested for this stage. Document bytes and text stay local. Do not introduce model providers, API keys, uploads, telemetry, or background network calls.
- Escape all document/model text before HTML rendering. Validate geometry and references before rendering imported models. Do not trust document metadata or imported JSON.

## Finishing changes

Run the checks appropriate to what changed. Keep `README.md` and model documentation aligned with actual behavior. Report what works, what was tested, and material remaining limits. Describe automatic simulation only for the actually compiled scope: a reviewed profile, a validated supported function table, or an authored model linked to that PDF. Never describe arbitrary unfamiliar PDF import as automatic chip simulation unless the implementation actually models that chip behavior and has been verified.
