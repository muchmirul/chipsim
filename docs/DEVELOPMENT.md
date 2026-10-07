# Developing ChipSim

Read the repository's `AGENTS.md` before changing simulation behavior or adding a model.

## Architecture

The HTML shell and UI contain no architecture-specific execution engine. A model provides a common interface: ID, name, summary, scope, fidelity, parameters, signals, topology, source references, assumptions, `simulate(parameters, options)`, and `recipe(parameters)`.

`src/models/index.js` adapts the six built-in architecture modules and registers declarative models. Built-ins retain their mechanism-specific behavior; `src/core/protocol.js` shares payload normalization, edge planning, frame boundaries, ACK stimulus, and terminal outcomes. Resource constraint modes deliberately produce different stalls, drift, or missed deadlines.

`src/model/validate.js` validates the declarative contract. `src/model/engine.js` evaluates the bounded expression language and state transitions without dynamic code execution. Imported models must pass their acceptance cases before registration. When a PDF is attached, its text is used to verify exact evidence quotations and page numbers.

Every snapshot carries `tick`, `state`, `phase`, `signals`, `registers`, active node IDs, event text, evidence IDs, and structured changes. Built-in snapshots also retain `original` values for regression inspection. Trace exporters consume this common format. The UI recomputes deterministic traces after parameters/stimulus change; playback selects snapshots rather than mutating simulator state.

`src/documents/pdf.js` runs PDF.js locally in an embedded worker. Recognition uses pinned fingerprints or conservative chip/peripheral name matches in the first 20 pages. Installed document models are associated by source SHA-256, so later PDF imports open their authored behavior directly. Recognition selects an existing model, never invents behavior. IndexedDB stores source PDFs, extracted text, and imported model JSON; a memory fallback supports environments without persistent storage and shows a warning after saving fails.

## Build and run

Node.js 22.13+ is required. `npm ci` installs pinned dependencies from the lockfile. `npm run build` bundles the UI and PDF worker and writes `.generated/app.js` and portable `chipsim.html`. No production backend or external service is needed.

`npm run dev` watches JavaScript dependencies and serves localhost. Restart it after adding or modifying packaged model JSON in `models/`. CSS and HTML shell edits are served directly; run `npm run build` to refresh their portable-file copy. `npm start` serves a completed build. `PORT=8001 npm start` changes the port.

Generated outputs and dependencies are Git-ignored. The local server accepts GET/HEAD only, binds to loopback, and excludes `.git`, `node_modules`, and `.env` paths. It is a development/static preview server, not an internet-facing application server.

## Add a model

Prefer declarative JSON for a new bounded peripheral scenario; see `docs/MODEL_FORMAT.md` and `examples/timer.model.json`. Browser imports require no rebuild. JSON placed under `models/` is included automatically on the next build. Each model needs independently justified acceptance cases and explicit source evidence/assumptions.

For behavior beyond the expression language, add a reviewed JavaScript simulator under `src/models/`, adapt its snapshots to the common interface, and register it in the catalog. Keep rendering separate from simulation. Preserve existing models and regression coverage rather than forcing all mechanisms into a shared implementation.

## Checks

- `npm test`: numeric formats, all 24 built-in width/ACK combinations, resource constraints, explicit ACK boundary stimulus, model execution order, width wrapping, terminal behavior, invalid models, provenance checks, recognition, and trace serialization.
- `npm run verify`: tests plus the eight PDF sizes/fingerprints, complete PDF markers, source coverage, example-model acceptance checks, documentation existence, and portable build references.
- `npm run test:ui`: Chromium tests for control behavior, comparison, exports, PDF extraction/search/storage, sourced model import and rejection, unknown-manual handling, session restoration, mobile layout, and direct-file offline PDF import.
- `npm run format`: Prettier for repository code, JSON, shell HTML, and Markdown.

Install the test browser once with `npx playwright install chromium`. Tests use their own browser contexts; they do not touch the user's browsing session. PDF CLI extraction is validated separately with Poppler. Large manuals are extracted page by page with visible progress and cancel support.

## Review limits

Quote verification normalizes whitespace. It confirms a quote exists on its cited page, not that the modeled inference follows from it. Extracted source bundles may come from different PDF text engines and can differ in hyphenation or ligatures; choose exact robust excerpts and check browser import too. Scanned documents require OCR outside ChipSim.

Timing is normalized; built-in deadlines and schedules preserve comparative semantic behavior rather than cycle accuracy. eTPU distinguishes capture arrival from shared service time. In the new adjustable ACK path, capture remains independent of final CLK bookkeeping, including an ACK held high at the enabled window boundary.

No LLM integration is present. Automatic generation of correct arbitrary-chip behavior remains future work; don't claim PDF upload alone achieves it. The current extension path gives a developer/agent extracted sources, a constrained model format, validation, acceptance checks, and the full workbench UI.
