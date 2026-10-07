# Development

## Application structure

`index.html` is the only application source and entry point. All styling, SVG rendering, and simulation code are inline so opening it through `file://` works without a build step or module server.

| Element | Responsibility |
| --- | --- |
| `lab-defaults` | JSON configuration used when the page starts and when settings are exported. |
| `lab-core` | Architecture metadata, recipes, topology, configuration normalization, and the six behavioral models. |
| `lab-ui` | Controls, playback, hash navigation, diagrams, waveforms, bundled reference links, and HTML export. |

The core exposes `globalThis.architectureLab`. Its `simulate(id, config)` function returns a deterministic array of state snapshots. Each snapshot includes signal levels, sampled bits, decoded payload, phase, active blocks, display values, and an event explanation. The UI selects the current snapshot; playback does not run a separate hardware emulator.

Supported IDs are `pio`, `pru`, `flexio`, `udb`, `xmos`, and `etpu`. The UI adds `getState()` for inspection in the browser console.

## Change a model

1. Identify the behavior and relevant manual section in [REFERENCES.md](REFERENCES.md).
2. Separate documented hardware behavior from an explicit teaching assumption.
3. Update the corresponding `simulate*` function, recipe, architecture metadata, and topology as needed.
4. Check complete transfers, missing ACK, frame lengths, half-period limits, and the resource experiment.
5. Update the reference guide if the modeled scope changes.
6. Run `node scripts/verify.mjs` from the repository root.

Preserve the shared DATA/CLK/ACK contract unless the interface and documentation are deliberately changed together. Keep terminal results latched. Do not treat normalized ticks as vendor instruction cycles or extrapolate physical performance from the diagrams.

## Update reference PDFs

Download complete documents from the publisher. Keep their original contents and notices. Validate that a response is actually a PDF before replacing a tracked file: some download endpoints return an HTML error page or an empty response.

Record the new document revision, official URL, retrieval date, byte size, page count, and SHA-256 in `docs/references/manifest.json`. On a system with Poppler, `pdfinfo FILE.pdf` provides the page count. `sha256sum FILE.pdf` computes the checksum. Update the human-readable guide and `BUNDLED_REFERENCES` in `lab-ui` when names or page locations change.

Manifest `pdf_start_page` values and URL `#page=` fragments use one-based PDF viewer pages. Printed page numbers may differ; the guide uses section numbers where possible.

## Browser review

After UI changes, open the page and check all chip tabs, comparison mode, playback, timeline seeking, configuration changes, each constraint toggle, the source panels, and HTML export. Check a narrow window for scrolling and layout. Confirm that local PDFs open with the whole repository available offline.

The verification script parses both JavaScript blocks and checks the model/reference contracts. It does not render the page, exercise browser download behavior, or validate the models against physical hardware.
