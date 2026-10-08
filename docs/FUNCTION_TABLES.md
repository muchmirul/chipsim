# Function-table compilation

ChipSim can derive combinational logic from a new PDF's published function table locally, without a model provider or a chip-specific fingerprint rule. Geometry identifies columns; explicit table symbols define behavior. This currently covers complete binary tables, not arbitrary prose, sequential circuits, analog behavior, or entire reference manuals.

```sh
npm start -- --document docs/references/nexperia-74hc00.pdf
npm start -- --document docs/references/nexperia-74hc86.pdf
npm run document -- path/to/manual.pdf --json
npm run document -- path/to/manual.pdf --out generated.model.json
```

The first two documents are regression references. Their NAND/XOR behavior is read from their rows; it is not selected by their filename, part number, or fingerprint. The imported models include all four indexed gates because consistent numbered pin lists establish those instances.

## What happens on import

1. Import bytes and compute SHA-256. A source-linked authored model takes precedence; a reviewed profile handles its exact supported revision.
2. Otherwise find function/truth-table captions and preserve positioned text on those pages. The terminal uses Poppler word coordinates; the optional browser uses PDF.js text coordinates. Old cached documents receive fresh page geometry on reimport.
3. Read explicit input/output headers and signal labels. Tables can have a separate signal-header row or inline headers such as `Input A`, `Input B`, `Output Y`.
4. Read each row without filling blank cells. H/L require the page's HIGH/LOW legend. X is an input wildcard only when defined as don't-care. Literal 0/1 are binary values.
5. Expand every binary input combination. Reject gaps and disagreeing overlaps. Agreeing wildcard overlaps are valid.
6. Generate bounded expressions, independent instances, exhaustive acceptance cases, a demonstration input sweep, and a source-table snapshot. Validate the definition and evidence, run checks, save it, and open the trace.

All compilable tables become separate library models; `m` selects among them in the TUI. The source table is visible in Model view (`5`) and in the browser's Sources tab. `M` exports the editable model JSON. `B` exports source text, geometry, and import diagnostics for a developer or coding agent.

## Supported bounds and omissions

Tables have up to six input columns, 24 output columns, and 32 source rows. Models have at most 32 instantiated signals. A six-input table generates 64 acceptance cases. Data is evaluated at tick zero and at later input steps with ideal instantaneous settling. The default sweep dwells for two normalized ticks and gives independent channels different patterns.

Edge arrows, hold states, Z outputs, unspecified outputs, ambiguous headings, conflicting pin ranges, incomplete rows, and merged/blank cells require review. Missing values are not copied from preceding rows. An unsupported table leaves the PDF available for search and guided modeling; diagnostics explain the reason. Both interfaces scan geometry on at most 32 candidate pages per import and reports this bound when reached. Built-in architecture manuals retain their existing example workflow.

Generic `n`-indexed signal names are expanded only from consistent documented numbered pin lists or ranges. Without those lists, one table instance is modeled and package replication remains outside scope. No electrical thresholds, delay, supply behavior, hazards, or other document features are inferred.

## Extending the compiler

`src/documents/layout.js` normalizes positioned rows. `src/model/tables/read.js` owns table syntax, symbol interpretation, coverage, and overlap checks. `src/model/tables/build.js` converts a validated table to the existing model language; `src/model/from-document.js` coordinates profiles and tables for both interfaces. Keep parsing, model generation, and rendering separate.

A new syntax must have real document examples and independent expected behavior. Include negative cases for ambiguous layouts and unsupported semantics. Do not silently infer merged cells, overwrite authored models, or claim whole-chip coverage from a small function table. Review the exported source snapshot and executable rules when adapting a generated model.
