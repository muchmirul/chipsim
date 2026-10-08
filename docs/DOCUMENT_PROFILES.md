# Reviewed document profiles

A profile makes the PDF-only workflow executable without an LLM. It is a reviewed mapping from a specific datasheet version to a declarative model. This is an extensible supported-device registry, not a general natural-language hardware compiler.

```sh
npm start -- --list-profiles
npm start -- --document docs/references/nexperia-74hc595.pdf
```

Importing a supported PDF with `d` does the same thing. The importer hashes the actual bytes, extracts pages locally, selects an exact matching profile, validates its citations, runs its acceptance cases, saves its JSON definition, and opens the resulting simulation. No model JSON import or builder interaction is required. A source-linked authored model already in the workspace takes precedence, preserving developer edits. An unrelated model with the same ID is retained; the automatic model receives a unique catalog ID.

## Current device: Nexperia 74HC595 / 74HCT595

The reviewed reference is Rev. 12, 20 March 2024, with the exact SHA-256 recorded in `references/manifest.json`. The shipped model covers the ideal digital shift/storage path and control pins. The default stimulus demonstrates loading `0xB3`, latching, output gating, and clearing. Custom stimulus controls DS, SHCP, STCP, MR, and OE directly; there is no hidden serial protocol generator.

`parallel_latch` reports retained storage data independently of output enable. `parallel_pins` reports that byte when `outputs_enabled` is 1 and the explicit output state `Z` when disabled. Z identifies released drivers; shared-bus resolution, external pulls, contention, and analog high impedance are outside the engine. Configurable initial values are explicit scenario choices, not guaranteed power-on state. Timing remains normalized. Previously exported model JSON keeps its authored behavior; reimporting a PDF preserves those installed models rather than silently replacing them.

Validation covers every transferred byte, function-table control combinations, held/falling clock levels, tick-zero baselines, reset priority, simultaneous edges, source rejection, PDF-only creation, and persistence. Acceptance cases and citations are exported in the model JSON. These checks establish the documented model scope; they do not certify electrical or timing accuracy.

## Add a profile

1. Choose a device and bounded scenario, acquire its official reference PDF, and review its redistribution notices. Preserve its original bytes and record SHA-256, revision, publisher, URL, pages, and supported behavior in `docs/references/manifest.json`.
2. Read relevant function tables, diagrams, timing conditions, and errata. Implement a trusted factory under `src/model/profiles/` that returns schema-version-1 JSON, following `MODEL_FORMAT.md`. Keep simulation rules out of import/rendering code.
3. Declare exact page citations, assumptions, omitted behavior, and independently derived acceptance cases. Do not invent power-on reset values or physical timing. Keep source excerpts short.
4. Register the factory and source in `src/model/profiles/index.js`. The shared `compileDocument()` verifies provenance and acceptance cases before either interface installs the result. Require exact fingerprints; another revision needs its own review and entry.
5. Add tests with the actual reference PDF and independent expected results. Exercise the complete PDF-only terminal import, persistence, and browser import if affected. Test filename/content lookalikes and corrupted citations.
6. Run `npm run verify`, then `npm run build && npm run test:ui` for importer changes. Optionally test VCD with `npm run test:dwfv -- /path/to/dwfv`. Update this guide, reference mappings, and notices.

Outside reviewed profiles, complete binary function tables can be compiled from their content; see `FUNCTION_TABLES.md`. Other unknown PDFs remain searchable and usable for guided scenario creation or authored JSON models. A keyword, filename, or matching chip name cannot silently enable a reviewed profile for an unreviewed document.
