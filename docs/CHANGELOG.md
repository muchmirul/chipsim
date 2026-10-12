# ChipSim behavior changes

This log explains changes that affect users or coding agents: the problem, the
new behavior, how to use it, and the boundaries to preserve when extending it.
The topic guides describe the current interface. This log starts with the
changes below; it is not a reconstructed history of earlier features.

## 2026-10-12 — Native Pi and prime-agent extension

### Named tools over the existing local protocol

**Context:** Coding agents previously needed to construct shell commands for
each operation. The user requested direct control from Pi and prime-agent
across projects. **Use/behavior:** Install this checkout with `pi install PATH`
and `prime-agent package install PATH`; the shared `pi.extensions` manifest
registers 17 tools for context, PDF preparation/evidence, checks, simulation,
program execution, activity, HDL and terminal snapshots. Native integration
avoids another server/transport while preserving the versioned CLI boundary.
**Limits/preservation:** File tools still author models/programs. No embedded
provider, native-firmware backend, automatic model interpretation or dependency
installer is added. Existing source hashes, quote/schema/acceptance gates,
new-directory protection, run exports and activity remain authoritative.
Each call uses its current cwd, argument arrays, bounded output/time and owned
process cancellation; failures retain structured CLI diagnostics/artifact paths.
**Implementation/checks:** `extensions/chipsim.ts`, `src/integrations/` and
the package manifest; regression checks cover CLI mapping drift, concurrent cwd,
literal text, real PDFs, source corruption, protected destinations, successful
PIO execution, HDL mismatch, cancellation, limits and outside-checkout install.
Prepared projects copy the new guide and help exposes its current path.
See [Agent extensions](AGENT_EXTENSIONS.md).

### Agent terminal handoff

**Context:** Agents need to show the actual simulation interface after producing
artifacts. **Use/behavior:** `/chipsim [PROJECT]` opens default/watch mode;
`--session FILE`, `--model ID|FILE` and `--vcd FILE` select a saved experiment
or waveform. In Pi/in-process hosts, `q` returns to the same agent.
Prime-agent 0.9.8's default daemon lacks client-terminal/custom-UI access:
the command instead provides a safely quoted separate-terminal launch command;
all simulation tools work in the daemon. **Limits/preservation:** This is a
user slash command in a real interactive terminal. Print/RPC callers use the
snapshot tool. The command waits for idle, releases/restores the host TUI even
on child failure, and does not create a browser frontend or shared model state.
**Implementation/checks:** Shared slash handler with Pi mode/Prime hasUI
compatibility; unit failure restoration/daemon fallback and real ChipSim PTY
handoff through a host lifecycle harness at 80×24/120×40.
Native loader checks run without model requests. Installation is an explicit
host package operation; extension loading/tool calls never edit host settings.

## 2026-10-12 — TUI-only workbench

### One interactive interface

**Context:** A separate browser workbench and HTML walkthrough created confusion
about where to use new simulation features. ChipSim now focuses on terminal use.
**Behavior:** `npm start`, `npm run dev` and `npm run tui` open the same TUI.
The browser frontend, local web server, HTML shell and portable/generated
bundles are removed. Use Space for playback, `g` for state graphs, `v` for bit
flow, and `Y`/`D` for experiment comparison. There is no separate demo playback
button. **Agent use and limits:** Demonstrate actual recorded experiments in the
terminal. The engine, `.chip` debugger, model/agent/HDL headless commands,
JSON/CSV/VCD exports, existing `.chipsim/` workspaces and saved sessions remain
available. Headless commands support reproducible TUI experiments; they do not
provide another interactive frontend. **Implementation/checks:** Removed
`src/ui/`, the web scripts, HTML entry points and browser download helper. Unit and real PTY checks retain
the terminal graph, bit-flow, comparison and source-program workflows at 80×24
and 120×40. See [TUI](TUI.md) and [visual inspection](VISUALIZATION.md).

### Local PDF extraction and persistence

**Context:** PDF.js and IndexedDB existed for the removed browser interface.
**Behavior:** The Poppler extractor and terminal workspace own PDF import,
source verification, table geometry and persistence. Browser-only extraction
and storage modules and the bundled PDF.js license are removed with that
dependency. **Agent use and limits:** Use `d` in the TUI or the headless prepare
and extraction commands; original PDF fingerprints, citations and acceptance
cases still gate model creation. Existing terminal caches and model/session
formats are unchanged; terminal sessions do not embed PDFs. **Implementation/checks:**
`extract-node.js`, `layout.js` and `workspace.js` retain original-PDF, table,
cache-refresh, source-verification, session and terminal import coverage. Only
browser rendering assertions and browser-only tests were removed.

### Contributor, package and agent instructions

**Context:** Web build commands, dependencies and copied guides implied that
contributors should maintain a second frontend. **Behavior:** Removed `build`,
`web`, `dev:web`, `test:ui` and `verify:web`, plus Playwright, esbuild and PDF.js
dependencies/configuration. `npm run verify` checks engine, source and terminal
behavior directly. Prettier remains the only npm development dependency;
there are no npm runtime dependencies. **Agent use and limits:** Current topic
guides and newly prepared projects specify terminal demonstrations and the
TUI-only boundary. Existing prepared projects retain their documentation
snapshot; consult current installed guides for newer behavior.
**Implementation/checks:** `test/tui-only.test.js` rejects web entry points,
toolchains and browser runtime APIs in shipped source. `test-install.mjs`
checks the packed distribution for removed web assets and verifies offline
installation, headless commands, copied documentation and terminal snapshots.
See [Development](DEVELOPMENT.md) and [agent workflow](AGENT_WORKFLOW.md).

Earlier entries describe the interfaces available when those changes were
introduced. Their browser usage and browser-test references are historical;
the current topic guides describe the supported TUI-only workflow.

## 2026-10-09 — Trace-backed visualization and experiment comparison

### Exact transition and assignment observations

**Context:** End-of-tick values cannot explain transient sequential reads or
distinguish explicit self-transitions from retention. **Behavior:** Declarative
simulation records transition indices and completed assignments with stage,
width, before/after and evaluated read values, including same-value writes and
lazy selected branches. JSON exports retain these additive observations.
**Limits:** Only 64 assignments per tick are recorded, while the full count and
execution are preserved. Faults retain the successful prefix, not a fabricated
completed failing write. **Implementation/checks:** `src/model/engine.js` and
`test/visualization.test.js` cover priority, sequential intermediates, lazy
evaluation, self-entry, bounded recording and faults. See [Model format](MODEL_FORMAT.md).

### Directed state graph

**Context:** The event log lacked a node-and-arrow view of possible branches.
**Use/behavior:** `g` or browser States shows the current state, declared paths,
unvisited branches, retention loops and observed transitions. Focus a state and
inspect priority, conditions, transition actions and evidence; select an
observed tick to seek. Browser terminal states have double borders.
**Limits/preservation:** Built-ins describe teaching phases, document models
describe declared rules, and old ambiguous observations do not identify an
edge. HDL signals declare no FSM. Browsing preserves execution and settings.
**Implementation/checks:** `state-graph.js`, terminal/browser visual renderers,
unit, browser and real PTY cases verify branches, readable scrolling through all
64 states, self/hold distinction, current
cursor and safe imported labels. See [Visualization](VISUALIZATION.md).

### Captured bits and actual assignment flow

**Context:** Waveforms alone made it hard to connect serial bits to receiver
state or model reads to writes. **Use/behavior:** `v` or browser Bit flow shows
LSB-first sender/receiver cells, samples, decoded word and DATA/CLK/ACK for all
six examples, or executed ordered assignments for document models. Browser bit
animation follows actual captures of zero, one and repeated values and honors
reduced motion. **Limits:** The receiver is a teaching fixture, timing is
cosmetic, and assignment arrows are evaluated reads rather than physical wiring.
Old traces fall back to observed changes. Tick zero invents no capture; PIO
load stalls invent no launch. **Implementation/checks:** `flow.js`, both visual
renderers and unit/browser/PTY tests cover every example, zero/one, declared
widths, unavailable/Z and ordered reads. See [Visualization](VISUALIZATION.md).

### Frozen reference across experiment edits

**Context:** Existing draft review required identical settings and could not
compare two deliberate stimulus/parameter experiments. **Use/behavior:** `Y`
captures a reference and `D` opens comparison; browser Comparison provides
capture/clear controls. Copies of model data, trace and settings survive live
edits, model changes and session loads. The report separates configuration and
width changes from exact observable differences. **Limits:** References are
in memory; ordinary session saves do not include them. Exact field names imply
no mapping; a match covers one experiment. Draft-review and HDL constraints
remain intact. **Implementation/checks:** `experiments.js`, TUI state and browser
controller; regression tests mutate trace, declaration and parameter data after
capture and exercise success versus timeout. See [Visualization](VISUALIZATION.md).

### Reference loading preserves the working experiment

**Context:** Reviewing a saved run should not replace the active model or
debugger. **Use/behavior:** Enter in terminal Comparison or browser Load reference
accepts a saved session or normalized JSON trace up to 32 MiB. Validation and
comparison preflight precede committing the reference. Sessions replay in
isolation; imported traces are labeled recorded and execute no model definition.
**Limits/preservation:** Rejection retains both reference and active state.
Only the terminal replays program sessions with guide checks; browser users
load the program's exported `trace.json`. Bounds/width checks do not authenticate
recorded observations. **Implementation/checks:** `recordedExperiment`,
`TuiState.loadComparisonFile` and browser handlers, with invalid-session,
malformed-trace and state-preservation regressions. See [Visualization](VISUALIZATION.md).

### Common comparison timeline and unavailable coverage

**Context:** Clamping a shorter experiment to its last sample creates misleading
later comparisons. **Use/behavior:** Comparison extends its cursor to the longer
trace, renders both on one tick axis and marks missing observations unavailable.
`[`/`]` and browser buttons seek differences. Terminal comparison playback can
pass a current terminal outcome to inspect the other trace. Leaving comparison
clamps the cursor to live coverage; saved current cursors stay inside it.
**Limits:** Normalized ticks remain semantic, with no HDL-time conversion.
**Implementation/checks:** Both controllers, comparison renderers and logic-wave
unavailable rendering; unit/browser/PTY checks cover early ends and navigation.
See [TUI](TUI.md) and [Visualization](VISUALIZATION.md).

### Portable comparison report

**Context:** Agents need the settings behind a claimed divergence. **Use/behavior:**
Terminal Comparison → Export and browser Export comparison write a version-1
`chipsim-experiment-comparison` report with sessions, origin labels, all observed
differences and configuration changes. **Limits/preservation:** `null` is
unavailable, distinct from zero/Z; exporting changes no experiment. It is not a
loadable session or acceptance case. Keep recorded reference artifacts alongside
reports. **Implementation/checks:** `comparisonJSON`, visual panel/browser
handlers and export assertions in unit, browser and real PTY tests.

### CLI view alignment and discoverable agent guidance

**Context:** Direct CLI view assignment bypassed Log/graph focus alignment and
agents lacked guidance for new displays. **Use/behavior:** `--view states|flow|compare`
joins existing views, and `setView` aligns selection to `--at`. Numeric views stay
unchanged; letter views appear in Tab, help and their footer. `prepare` copies
`VISUALIZATION.md`, linked from README, workflow and project instructions.
**Limits:** Prepared docs describe the preparing version; existing projects are
not silently updated. **Implementation/checks:** CLI/view catalog, agent project
copy list and packaging/prepared-project assertions; real PTY starts at wait/32
at both recommended sizes. See [Development](DEVELOPMENT.md).

## 2026-10-09 — Program signals and model references

### Initial signal values before execution

**Context:** Loading a `.chip` program creates one initial snapshot at tick zero.
The waveform cursor could obscure that single sample, making the signal pane
look empty even though the model had initial values.

**Behavior:** Program (`9`) and Waveforms (`1`) now display the actual initial
signal values while an attached program has only that snapshot. The pane says
`no waveform history yet` and points to `N` (step) and `C` (continue) in Program.
For the supplied PIO transfer, the initial values are DATA `0x1`, CLK `0x0`, and
ACK `0x0`. Once execution advances time, the usual waveform display returns.
Resetting the program restores the initial display.

**Agent use and limits:** A visible initial value is an observation at tick zero,
not proof that a source statement executed. An assertion can execute without
advancing time. Loading/resetting source still executes no statements. A program
that halts or faults before time advances shows `program halted` or `program
stopped` instead of suggesting that history is still being generated. These are
behavioral model ticks, not CPU instructions or physical clock timing.

**Implementation and checks:** `waveform()` in `src/tui/render.js` handles the
single-snapshot display. `test/program-workspace.test.js` covers both views at
80×24 and 120×40, stepping an assertion versus a wait, reset, halt and fault.
`scripts/test-program-pty.py` exercises the keyboard workflow in a real terminal.
See [Programming](PROGRAMMING.md) and [TUI](TUI.md).

### References follow the active model

**Context:** A workspace containing only an ESP32 manual could show that manual
after opening an RP2040 PIO program. Startup selected the latest cached PDF, and
model changes could retain an unrelated reference when no match existed.

**Behavior:** Startup, model selection, program loading and successful session
restore now select a cached document only when its SHA-256 matches a declared
source of the active model. When no source matches, Sources (`4`) shows that the
model's reference is not loaded and lists its declared sources. Cached documents
remain available. Selection uses the first matching source in model declaration
order. The opening page is its first applicable evidence page, otherwise its
declared PDF start page, otherwise page 1; missing cached pages fall back to 1.
Changing the selected document clears the previous document's search and scroll.

**Agent use and limits:** Use the model's declared source fingerprint to decide
whether a document supports it. A filename, chip name or cached-document order
does not establish that relationship. A rejected session does not change the
current reference or experiment. This change concerns TUI reference selection;
it does not establish additional modeled hardware behavior.

**Implementation and checks:** `TuiState.selectModelDocument()` centralizes the
selection rule. `test/program-workspace.test.js` covers startup, model changes,
program loading, valid/invalid session restore and stale search cleanup.
`test/document-cache.test.js` selects its authored model before inspecting that
model's cache. See [TUI source workflow](TUI.md).

### Load a bundled reference without restarting the experiment

**Context:** The Sources import action previously used the general PDF import
workflow. That workflow can select or install models, which is inappropriate
when the user only wants a running program's reference. An unrelated cached PDF
also prevented the missing bundled reference from being offered.

**Behavior:** For a built-in model with no active document, press `4`, then Enter
to extract and cache its first bundled reference under `docs/references/`. This
works even when other PDFs are cached. The import checks the expected SHA-256
and revalidates linked authored-model citations before saving. A fingerprint or
citation failure leaves the existing source and experiment intact.

**Agent use and limits:** This action attaches evidence; it preserves the model,
parameters, inputs, trace, history, program/debugger position, breakpoints,
timeline cursor, selected signal and zoom. It neither executes the program nor
installs newly discovered models. For an authored model or another manual, use
the documented `d` import workflow. The import is local and requires Poppler.

**Implementation and checks:** `TuiState.loadModelSource()` implements the
reference-only operation; `TerminalApp.sourcesMenu()` invokes it. The workspace
regressions check preservation of an in-progress program and rejection of a
changed fingerprint. The real PTY test opens PIO in an ESP32-only workspace,
imports the RP2040 reference, and checks that the program remains unexecuted.
See [TUI](TUI.md) for general PDF import and source inspection.

### Explicit browsing identifies unrelated PDFs

**Context:** Browsing cached manuals is useful, but an unrelated PDF must not
appear to be evidence for the active model.

**Behavior:** A matching PDF is labeled `Reference for <model>`. An explicitly
chosen unrelated PDF is labeled `Browsing another PDF · model: <model>`. With a
document open, Enter in Sources opens the cached-PDF chooser. Loading a program,
selecting a model or restoring a session applies the matching-reference rule
again.

**Agent use and limits:** Reading another manual does not change the model or
establish provenance. Inspect Model (`5`) for the declared scope and evidence.
`sources()` in `src/tui/render.js` renders these labels;
`test/program-workspace.test.js` checks deliberate browsing and program reload.

### Change context travels with agent projects

**Context:** A feature description alone can leave an agent guessing why a
behavior changed or which assumptions must survive later edits.

**Behavior:** Repository `AGENTS.md` now requires a documented entry for each
added feature or behavior change. Entries explain context, trigger/usage,
observable behavior, limits, implementation pointers and regression coverage.
The README and agent workflow link this log. Newly prepared projects receive
`docs/CHANGELOG.md` and its terminal/development guides, and their `AGENTS.md`
points agents to the log.

**Agent use and limits:** Prepared documentation is a snapshot from the version
that created the project. Existing projects are not rewritten automatically.
Consult the installed checkout's documentation for newer changes, and refresh
actual model capabilities with `chipsim agent context . --model MODEL_ID`.
That command refreshes capability discovery, not copied documentation.
See [Development](DEVELOPMENT.md) for the contribution documentation contract.
`src/agent/project.js` copies the log; prepare and install checks verify it is
available in prepared projects and the installed package.
