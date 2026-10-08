# Reviewed document profiles

A profile makes the PDF-only workflow executable without an LLM. It is a reviewed mapping from a specific datasheet version to a declarative model. This is an extensible supported-device registry, not a general natural-language hardware compiler.

```sh
npm start -- --list-profiles
npm start -- --document docs/references/nexperia-74hc595.pdf
```

Importing a supported PDF with `d` does the same thing. The importer hashes the actual bytes, extracts pages locally, selects an exact matching profile, validates its citations, runs its acceptance cases, saves its JSON definition, and opens the resulting simulation. No model JSON import or builder interaction is required. A source-linked authored model already in the workspace takes precedence, preserving developer edits. An unrelated model with the same ID is retained; the automatic model receives a unique catalog ID.

One manual can have several reviewed peripheral profiles. `profilesForDocument()` returns all exact matches and `compileDocumentProfiles()` compiles all of them while reserving distinct model IDs. `analyzeDocument()` exposes the complete set to both importers. The singular `compileDocument()` accepts `profileId`; it rejects ambiguous selection instead of silently returning the first peripheral. Every selected profile still requires its own scope, citations and checks. ESP32-C6 supplies PCNT channel 0 and GPIO output registers as two independently scoped profiles from one manual.

In the terminal, `o` lists source-linked models and can find supported simulations again from a cached PDF. Finding only previews results; Enter creates one under an unused ID, preserving authored models. The CLI lists all results with `npm run document -- manual.pdf --json`; `--model ID --out selected.model.json` exports a specific result. Without `--model`, `--out` still requires exactly one compilable result.

## Nexperia 74HC595 / 74HCT595

The reviewed reference is Rev. 12, 20 March 2024, with the exact SHA-256 recorded in `references/manifest.json`. The shipped model covers the ideal digital shift/storage path and control pins. The default stimulus demonstrates loading `0xB3`, latching, output gating, and clearing. Custom stimulus controls DS, SHCP, STCP, MR, and OE directly; there is no hidden serial protocol generator.

`parallel_latch` reports retained storage data independently of output enable. `parallel_pins` reports that byte when `outputs_enabled` is 1 and the explicit output state `Z` when disabled. Z identifies released drivers; shared-bus resolution, external pulls, contention, and analog high impedance are outside the engine. Configurable initial values are explicit scenario choices, not guaranteed power-on state. Timing remains normalized. Previously exported model JSON keeps its authored behavior; reimporting a PDF preserves those installed models rather than silently replacing them.

Validation covers every transferred byte, function-table control combinations, held/falling clock levels, tick-zero baselines, reset priority, simultaneous edges, source rejection, PDF-only creation, and persistence. Acceptance cases and citations are exported in the model JSON. These checks establish the documented model scope; they do not certify electrical or timing accuracy.

## TI PCA9555

The pinned SCPS131J revision (March 2021; 49 PDF pages) creates a register-level model automatically. Pages 19–20 specify addresses 0–7: input ports 0/1 (read-only), output latches 0/1, polarity 0/1, and direction 0/1. Output and direction latches reset to `0xFF`, polarity to zero. Input values depend on the explicit external levels; the default driven-high input scenario is not a vendor-defined input reset byte.

Press `u` for addressed reads/writes. The model uses an abstract request toggle, one addressed byte per change after tick zero; `valid` and `error` are scenario status. Held request levels do not replay accesses. Input-port writes are ignored. Latch reads return stored data; input reads observe modeled pin levels with input-only polarity inversion. Input direction releases each individual output driver to `Z`; output direction drives its retained latch bit. Uncontended driven pins are assumed to follow their latches. External input bytes do not model analog overrides or contention.

Interrupt comparison uses non-inverted physical scenario levels and independent per-port last-read baselines, masked by input direction. Restoring those levels or reading the affected input port clears its mismatch. Reading the other bank does not. `int_driver` is `0` when pending and `Z` otherwise; no pull-up voltage is inferred. `power_reset` abstracts a completed power reset; it dominates accesses, resets latches, and establishes the current input/request baselines as an explicit scenario assumption.

The model omits I²C bit serialization, persistent register pointers, paired multi-byte alternation, ACK/NACK race windows, physical delays/supply thresholds, and other slave devices. Page 16 documents an interrupt de-assertion erratum involving another slave's read acknowledgment while the register pointer is zero. That shared-bus behavior is explicitly outside this model, so it cannot validate the published workaround. There are fifteen executable acceptance cases, independent all-byte/two-bank direction checks, and a deterministic mixed-operation oracle. Both PDF extraction engines verify the quoted pages; terminal sessions and VCD preserve the same model.

## TI TCA9534

The pinned SCPS197D revision (October 2017; complete 42-page official download with current notices/package addendum) creates a single-port register-level model. PDF page 19 defines addresses 0–3: Input (read-only), Output, Polarity Inversion, and Configuration. Page 20 defines their behavior and writable defaults: Output `0xFF`, Polarity zero, and Configuration `0xFF`. Input values depend on applied pin levels; the model's initial `external0 = 255` is a chosen driven-high experiment.

Use `npm start -- --document docs/references/ti-tca9534.pdf`, then `u` to select a register and Read or Write. The default experiment writes the latch and mixed direction, changes an external input, reads Output without acknowledging INT, reads Input to acknowledge, changes polarity, and resets. Each P0–P7 driver is individually observable as `0`, `1`, or `Z`. `int_driver` is low while an input mismatch is pending and released otherwise. Input-only polarity inversion affects returned data, while interrupts compare non-inverted pin levels. Output-configured pins follow their latches under the explicit uncontended assumption and cannot generate input interrupts.

The abstraction accepts one individually addressed byte per request-token change after tick zero. `power_reset` denotes completed POR, not a hardware reset pin; the initial/reset interrupt baseline is an explicit scenario assumption. Real persistent command pointers, slave-address pins, I²C/SMBus serialization, repeated bytes, ACK-related interrupt-loss races, supply ramps, pulls, loading, contention, and physical delays are omitted. Unmapped addresses produce tool-level errors, not simulated silicon NACKs. Page 17 supplies the interrupt/POR behavior; pages 19–20 supply the register contract. Sixteen acceptance cases, all-byte direction/inversion checks, an independent mixed-operation oracle, PDF-only terminal/browser import, and session/VCD checks cover the declared scope.

## ESP32-C6 PCNT channel 0

The user-supplied ESP32-C6 TRM v1.2 (20 March 2026) opens a reviewed single-channel PCNT model. It implements signed 16-bit pulse counting, both edge-mode encodings, control keep/reverse/inhibit, pause/clear, and static positive/negative limit clearing. Tick zero establishes pulse history. Raw words and separate sign/magnitude signals preserve negative counts in every numeric format.

The complete PDF is bundled unchanged; its fingerprint, page citations and sixteen acceptance cases gate compilation. Independent mode-table and signed-boundary oracles, both extraction engines, terminal persistence and trace exports check the scope. Channel 1, filters, interrupts/watchpoint latches, MMIO, live limit updates, clock synchronization, other units/peripherals and CPU execution are excluded. See [ESP32_C6_PCNT.md](ESP32_C6_PCNT.md) for the terminal walkthrough and assumptions.

## ESP32-C6 GPIO output registers

The same pinned TRM also compiles `esp32c6-gpio`. Chapter 7 defines OUT/ENABLE, their atomic write-one set/clear aliases, and a preconfigured simple-output path. The model stores bits 0–30, exposes both complete masks and one selectable 0/1/Z logical driver, and uses GPIO-relative offsets with completed 32-bit word transactions. Alias reads are explicitly unsupported, invalid bit 31 is normalized by the adapter, and package routing/electrical behavior are not inferred. Sixteen embedded checks, an independent all-bit BigInt oracle, both extraction engines and terminal/browser workflows cover the scope. See [ESP32_C6_GPIO.md](ESP32_C6_GPIO.md).

A fresh import installs both ESP32 profiles. `o` chooses installed simulations; its explicit Find action adds a selected profile to an older workspace without replacing authored models. Reimport keeps the active linked peripheral selected. This GPIO factory is independent of the I/O-expander core because its enable polarity, word masks, aliases and omissions differ.

## Shared reviewed GPIO behavior

`src/model/registers/gpio-expander.js` builds the digital register actions shared by PCA9555 and TCA9534. Each reviewed factory supplies complete explicit byte addresses, names, and writable reset values for one or two ports. Source evidence, device-specific limitations, stimulus, and acceptance cases remain in the individual profile. The core does not recognize PDFs or infer semantics from chip names; reuse requires reviewing the new device's register and interrupt behavior against its actual manual. Similar product names or address maps alone are insufficient.

## Add a profile

1. Choose a device and bounded scenario, acquire its official reference PDF, and review its redistribution notices. Preserve its original bytes and record SHA-256, revision, publisher, URL, pages, and supported behavior in `docs/references/manifest.json`.
2. Read relevant function tables, diagrams, timing conditions, and errata. Implement a trusted factory under `src/model/profiles/` that returns schema-version-1 JSON, following `MODEL_FORMAT.md`. Keep simulation rules out of import/rendering code.
3. Declare exact page citations, assumptions, omitted behavior, and independently derived acceptance cases. Do not invent power-on reset values or physical timing. Keep source excerpts short.
4. Register the factory and source in `src/model/profiles/index.js`. Several unique profile IDs may reference the same pinned manual for independently reviewed peripherals. `compileDocumentProfiles()` verifies every result's provenance and acceptance cases before the importer installs it. Require exact fingerprints; another revision needs its own review and entry. Use `compileDocument(document, { profileId })` when a caller requires a specific profile.
5. Add tests with the actual reference PDF and independent expected results. Exercise the complete PDF-only terminal import, persistence, and browser import if affected. Test filename/content lookalikes and corrupted citations.
6. Run `npm run verify`, then `npm run build && npm run test:ui` for importer changes. Optionally test VCD with `npm run test:dwfv -- /path/to/dwfv`. Update this guide, reference mappings, and notices.

Outside reviewed profiles, complete binary function tables can be compiled from their content; see `FUNCTION_TABLES.md`. Other unknown PDFs remain searchable and usable for guided scenario creation or authored JSON models. A keyword, filename, or matching chip name cannot silently enable a reviewed profile for an unreviewed document.
