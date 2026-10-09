# Function-table compilation

ChipSim can derive combinational and supported edge-triggered logic from a new PDF's published function table locally, without a model provider or a chip-specific fingerprint rule. Geometry identifies columns; explicit table symbols define behavior. This covers complete binary mappings, binary-input tables with defined high-impedance outputs, complete level-sensitive retention tables, and bounded sequential tables with documented clock-edge semantics. Arbitrary prose, general stateful devices, analog behavior, and entire reference manuals remain outside automatic interpretation.

```sh
npm start -- --document docs/references/74hc00/nexperia-74hc00.pdf
npm start -- --document docs/references/74hc86/nexperia-74hc86.pdf
npm start -- --document docs/references/74hc157/nexperia-74hc157.pdf
npm start -- --document docs/references/hd74hc138/renesas-hd74hc138.pdf
npm start -- --document docs/references/74hc377/nexperia-74hc377.pdf
npm start -- --document docs/references/74hc273/nexperia-74hc273.pdf
npm start -- --document docs/references/sn74lvc1g125/ti-sn74lvc1g125.pdf
npm start -- --document docs/references/sn74ahc273-q1/ti-sn74ahc273-q1.pdf
npm run document -- path/to/manual.pdf --json
npm run document -- path/to/manual.pdf --out generated.model.json
```

These documents are regression references. Their behavior is read from their rows; it is not selected by their filename, part number, or fingerprint. Consistent numbered pin lists establish all four channels for the NAND/XOR/multiplexer sources and all eight for the Nexperia sequential sources. Common control pins are shared across channels, while data inputs and outputs remain separate. Generic unindexed headings describe one table instance; package replication is not inferred.

## What happens on import

1. Import bytes and compute SHA-256. A source-linked authored model takes precedence; a reviewed profile handles its exact supported revision.
2. Otherwise find function/truth-table captions and preserve positioned text on those pages. The terminal uses Poppler word coordinates; the optional browser uses PDF.js text coordinates. Old cached documents receive fresh page geometry on reimport.
3. Read explicit input/output headers and signal labels. Tables can have a separate signal-header row or inline headers such as `Input A`, `Input B`, `Output Y`.
4. Read each row without filling blank cells. Explicit `Operating modes` description columns are excluded by position; their text is never interpreted as logic. H/L require local HIGH/LOW definitions. X is an input wildcard only when defined as don't-care. Literal 0/1 are binary values. Combinational output Z requires an explicit high-impedance definition. Numbered header annotations can refer to complete, adjacent symbol definitions below the rows. A numbered definition may wrap onto at most three following lines with matching content indentation and gaps of at most 16 PDF points; the complete joined note must consist of supported definitions. Missing definitions, incompatible wraps, and timing/prose qualifications require review.
5. Expand every binary input combination (and previous-clock/output combinations for sequential tables). Reject gaps and disagreeing overlaps. Agreeing wildcard overlaps are valid.
6. Generate bounded expressions, independent instances, exhaustive acceptance cases, a demonstration input sweep, and a source-table snapshot. Validate the definition and evidence, run checks, save it, and open the trace.

All compilable tables become separate library models; `m` selects among them in the TUI. The source table is visible in Model view (`5`) and in the browser's Sources tab. `M` exports the editable model JSON. `B` exports source text, geometry, and import diagnostics for a developer or coding agent.

## Supported bounds and omissions

Combinational tables have up to six input columns, 24 output columns, and 32 source rows. Models have at most 32 instantiated signals. A six-input combinational table generates 64 acceptance cases. Its data is evaluated at tick zero and at later input steps with ideal instantaneous settling. The default sweep dwells for two normalized ticks and gives independent channels different patterns.

Undefined arrows, unsupported hold/state notation, Z without an explicit definition, unspecified outputs, ambiguous headings, conflicting pin ranges, incomplete rows, and merged/blank logic cells require review. Missing values are not copied from preceding rows. An unsupported table leaves the PDF available for search and guided modeling; diagnostics explain the reason. Both interfaces scan geometry on at most 32 function-table/pin-description candidate pages per import and report this bound when reached. Built-in architecture manuals retain their existing example workflow.

Tables may mix shared input controls with indexed data signals. A shared control must have a positioned pin description that unambiguously declares one numbered input pin. Supported roles are `Symbol`, `Pin`, `Description`, or `NAME`, `NO.`, `TYPE`, `DESCRIPTION` with a complete local `Signal Types: I = Input, O = Output...` definition and type `I`. Shared outputs, conflicting pin numbers, missing roles, and bidirectional pins require review. Common controls are defined and driven once, while each indexed channel evaluates its own data against those controls. Generated checks keep controls consistent across channels and rotate only private inputs.

Press `i` in the TUI to drive an input pin at the current tick without writing JSON. Later scheduled input events are retained.

Generic prefix/suffix `n`-indexed signal names (such as `nA` or `Dn`) are expanded only from consistent documented numbered pin lists or ranges. Without those lists, one table instance is modeled and package replication remains outside scope. No electrical thresholds, delay, supply behavior, hazards, or other document features are inferred.

## Centered and hierarchical column groups

Group headings may be centered over their columns instead of aligned to the first column. ChipSim enumerates contiguous, nonempty column partitions and requires exactly one partition whose group centers match the signal spans within two PDF points. Supported explicit roles are Inputs/Outputs, qualified Enable Inputs/Select Inputs/Outputs, and Inputs above Enable/Select with Outputs on the adjacent row (at most 16 points apart). Hierarchical enable/select spans must match uniquely inside the parent input span. Unknown group qualifiers, missing name rows, or ambiguous/misaligned partitions require review. Existing left-aligned and inline heading forms remain supported.

A tightly adjacent numeric suffix (at most 0.75 points from the preceding header text) can join a signal name, such as G + 2A or Y + 0. Separate data cells never use this joining rule. Distant suffixes, duplicate names, and absent names are rejected. The exact next section heading `Pin Arrangement` can end complete local symbol definitions; extra legend prose is still rejected.

The HD74HC138 reference on PDF page 4 demonstrates hierarchical groups and subscripts. Importing it creates a 14-signal table-level model with six binary inputs and eight outputs, with 64 exhaustive acceptance cases. Drive G1 high while G2A/G2B are low to enable; C/B/A selects Y0–Y7, with A the least significant select bit. The selected output is low and the others high; disabling sets all eight high. This logic is read from the rows, not from a device-specific rule. Physical pins, analog behavior, delays and unmodeled features remain outside scope. Both extraction engines, independent input sequences, source mutations, negative layouts and the real TUI are verified against the complete original PDF.

## High-impedance combinational outputs

A table with binary inputs can produce 0, 1, or Z when its local legend explicitly defines Z as a high-impedance state. Complete binary-input coverage and agreeing overlaps still apply; X outputs or Z inputs require review. Generated output signals declare `triState: true` only on columns that can release. Missing/merged cells are not filled, even for known part numbers.

The TI SN74LVC1G125 source demonstrates three complete rows and numbered symbol-definition footnotes on PDF page 11. Its behavior is derived from those rows, not from its part number or fingerprint. Press `i` to change enable/data levels; press `f` and enter `Z` to seek the next release. Waveforms show a labeled middle/dotted or dashed segment; exports preserve the string `Z` (VCD `z`).

Z represents this output driver being released. It is not zero, retained data, an unknown level, or a resolved shared-bus voltage. External pulls, floating-node voltage, contention, mixed-state bus vectors, and electrical loads are not modeled. Inputs stay explicitly driven binary values. Sequential tables with Z rows still require review.

## Edge-triggered sequential tables

Sequential tables must identify one clock column using `↑` or `↓`, explicitly define the arrow as a LOW-to-HIGH/HIGH-to-LOW transition, and have a matching positioned pin description declaring an edge-triggered clock input. An exact source quotation establishes the edge-triggered contract. Levels H/L and don't-care X require definitions as for binary tables. Lowercase h/l require explicit HIGH/LOW set-up-level definitions. Literal output `no change` retains the prior output.

Sequential input/output definitions can be separate (`L = input low`, `H = output high`), provided each role has both levels defined. Literal `Q0`, including tightly adjacent PDF subscript text, is also supported only for one output column named `Q` and an explicit local `Q0 = previous state` definition. Other symbolic references, complements, undefined Q0, and qualified retention require review; no missing cell is filled.

A clock cell can list two to four distinct alternatives separated by commas, such as `L, H, ↓`, only when every output in that row explicitly retains. Within these lists, L/0 means steady low, H/1 means steady high, and arrows mean transitions. `L, H, ↓` therefore excludes a rising edge even though its current level is high. Standalone level cells retain their ordinary current-level meaning. Lists on other inputs, duplicate alternatives, undefined symbols, or non-retaining rows reject compilation.

The compiler evaluates every previous-clock, current-input, and retained-output combination. Missing **active** clock transitions reject compilation; conflicting updates and overlaps that disagree for any retained state also reject. Outside documented active edges, patterns omitted from the table retain outputs under the documented edge-triggered contract. Asynchronous level rows still take effect immediately and can dominate a coincident clock edge when the rows specify that behavior.

Generated models use declared clock-history/edge registers and output signals as storage. Tick zero establishes the supplied clock level without manufacturing an edge; asynchronous rows can act then. `initialOutputs` configures retained output bits in instance order, with the first output column of the first instance in the least significant bit. These are explicit scenario values, not guaranteed silicon power-on state. Undriven input pins default to ideal digital zero as a scenario choice.

Models with clock lists also expose a two-bit clock-pair register: 0 = steady low, 1 = rising, 2 = falling, 3 = steady high. It records the previous/current pair before updating clock history, so source-row logs continue to distinguish an edge from a held level. Tick zero initializes the pair as steady at the supplied level.

Sequential tables have at most two output columns, eight source rows, and 64 combinations across inputs + previous clock + previous outputs (`2^(inputs + outputs + 1)`). Instantiated model limits still apply. Every combination becomes an executable acceptance case. Original arrows, lowercase qualifiers, and `no change` cells remain in the source snapshot and both interfaces.

Physical set-up/hold constraints, recovery/removal times, metastability, voltage thresholds, and propagation delays are omitted. Lowercase levels are evaluated as ideal values present at the edge; all input events in a normalized tick precede evaluation together. The demonstration prepares data one abstract tick before toggling the clock; that spacing does not prove physical timing compliance.

The 74HC377 and 74HC273 PDFs are regression sources for enable/hold and asynchronous-reset behavior. Their rows and pin lists supply the generated logic; neither part number nor fingerprint selects the behavior. `p` edits initial retained bits; `i` drives clock/control/data pins. General counters, bus/register side effects, unsupported retention/clock semantics, unsupported state symbols, or ambiguous complementary-output headers still require reviewed models.

The TI SN74AHC273-Q1 reference uses `L, H, ↓` and explicitly defined Q0 on PDF page 12, with its typed rising-edge clock declaration on PDF page 3. It compiles one generic CLR/CLK/D/Q instance. Neither the generic table headings nor the package diagram establish a supported mapping to eight indexed channels, so package replication is omitted. Both PDF extraction engines are checked against this original source, along with independent four-step input sequences, reset priority, and steady-high data changes.

## Level-sensitive retention tables

Complete binary tables with explicit `No change` outputs can compile without clock edges. Literal H/L or 0/1 rows update immediately; `No change` retains that output's prior bit. Every current-input/prior-output combination must be covered, including held states that reveal disagreeing wildcard overlaps. Missing rows never become hold behavior. Tables require an explicitly covered condition that holds all outputs, used to establish each prior state in acceptance checks.

Bounds are two output columns, eight source rows, and 64 input/state combinations (`2^(inputs + outputs)`). Inputs support defined H/L, 0/1, and defined don't-care/irrelevant X; outputs support binary levels and case-insensitive literal `No change`. Edge arrows, lower-case setup qualifiers, symbolic prior-state references, Z, and unspecified outputs require other supported semantics or review. Complete adjacent definitions such as `H: High level`, `L: Low level`, `X: Irrelevant` are supported; qualified or continued legend prose is rejected.

The Renesas HD74HC77 reference supplies a table on PDF page 3 (printed page 1). Its generic `Data`, `Enable G`, and `Q` headings describe one table instance. `Enable G` becomes `EnableG` in model identifiers only when geometry identifies the two adjacent words as one heading. Package replication and grouped-enable wiring in its pin diagram are not inferred. This model demonstrates the table's latch behavior, rather than the whole four-latch package.

```sh
npm start -- --document docs/references/hd74hc77/renesas-hd74hc77.pdf
```

`p` configures initial retained bits; `i` drives data or enable. Tick zero applies the level rows immediately. The default Gray-code sweep changes one input at a time in the first table instance so you can see data following an open enable and holding behind a closed enable. Other indexed instances use offset data patterns. Initial bits and normalized timing are explicit scenario choices; simultaneous enable/data events cannot prove physical setup/hold compliance. Source symbols remain visible in Model view, exported JSON, and browser Sources.

## Extending the compiler

`src/documents/layout.js` normalizes positioned rows. `src/model/tables/layout.js` reads positioned headers/cells; `centered-headers.js` resolves unique centered/hierarchical partitions and adjacent header subscripts; `layout-notes.js` joins bounded footnote wraps; `legends.js` validates complete definitions. `read.js` dispatches symbol interpretation; `sequential-read.js` validates sequential clock/state coverage; `clock-patterns.js` defines clock pairs and pin-edge matching. `pins.js` resolves indexed instances and validates shared pin declarations; `typed-pins.js` reads typed pin roles. `build.js` and `sequential-build.js` convert validated tables to the existing model language; `sequential-scenarios.js` produces input sweeps and acceptance cases; `src/model/from-document.js` coordinates profiles and tables for both interfaces. Keep parsing, model generation, and rendering separate.

A new syntax must have real document examples and independent expected behavior. Include negative cases for ambiguous layouts and unsupported semantics. Do not silently infer merged cells, overwrite authored models, or claim whole-chip coverage from a small function table. Review the exported source snapshot and executable rules when adapting a generated model.
