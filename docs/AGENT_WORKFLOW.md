# ChipSim as a coding-agent tool

The coding agent reads a manual and authors a bounded behavioral model. ChipSim
extracts sources, verifies quotations, executes acceptance cases, and produces
waveforms and register traces. The same model opens in the TUI. No model provider,
API key, MCP server, or embedded LLM is needed by ChipSim.

## Install

Use Node.js 22.13+ and Poppler (`pdfinfo`, `pdftotext`). From a local checkout:

```sh
npm install --global --ignore-scripts /absolute/path/to/chipsim
chipsim agent doctor
chipsim agent help
```

Clone the source from [GitHub](https://github.com/muchmirul/chipsim) and install
from that checkout; this is not an npm registry release. A user-writable prefix
avoids administrator installation:

```sh
npm install --global --prefix "$HOME/.local" --ignore-scripts /absolute/path/to/chipsim
export PATH="$HOME/.local/bin:$PATH"
```

For a portable package, run `npm pack --ignore-scripts --pack-destination /path/to/output`
in the repository and install the resulting `.tgz` with the same npm options.
The package includes the reference PDFs, source modules, models, and documentation;
it has no npm runtime dependencies or lifecycle install scripts. Keep vendor
notices with the PDFs. Packaging does not grant additional redistribution rights.

Without installing, use `node /absolute/path/to/chipsim/scripts/chipsim.mjs agent …`
or `npm run --silent agent -- …` from the repository. Ordinary `npm run` adds npm
headers; use `--silent` when parsing stdout as JSON.

## Prepare, author, inspect

Before writing a program, ask ChipSim for the actual chip/model capabilities:

```sh
chipsim agent context esp32-c6
chipsim agent context pio
chipsim agent context ./chip-work --model esp32c6-gpio
```

`context` accepts a catalog chip ID, a built-in/profile model ID, or an existing
prepared project directory. `--project PATH` can bind an explicit chip ID to a
project; mismatched PDF fingerprints are rejected. `--model` selects a model ID
or model file in the project. For project targets, the command freshly checks
the pinned PDF, current model schema/quotations and executable acceptance cases.
Models with invalid sources or failing cases are excluded with diagnostics.
It does not trust a stale context snapshot. `program-check` still verifies the
chosen program and model again before execution.

Its `programmingContext` gives the chip's native programming target, the formats
ChipSim actually accepts, model scope and assumptions, exact input/output and
parameter declarations, register access modes, guide document IDs/PDF paths,
missing documents, debugging controls and check/run argument arrays. Unknown
manuals remain unidentified; a filename cannot establish an ISA. Multiple
peripherals require an explicit scope choice, not an assumed full-chip model.

Current executable source is the `.chip` experiment language. Context explicitly
reports native C/C++, assembly, ELF/BIN and other firmware backends as unavailable.
An agent must identify that gap when native code is requested, rather than
silently substituting an experiment. See [PROGRAMMING.md](PROGRAMMING.md).

```sh
chipsim agent prepare /path/to/manual.pdf --out ./chip-work
chipsim agent search ./chip-work "GPIO_OUT_REG" --limit 5
chipsim agent page ./chip-work 271
```

Preparation creates this folder, without replacing any existing directory:

```text
chip-work/
  AGENTS.md                 Instructions for an external coding agent
  PROGRAMMING_CONTEXT.md    Chip-specific programming decisions and workflow
  programming-context.json Current-at-prepare capabilities and source pointers
  chipsim.project.json      PDF/cache fingerprints and format version
  manual.pdf                Unchanged source bytes
  sources.json              Extracted text and selected table geometry
  pages/00001.txt …         One file per one-based PDF page, usable with rg
  analysis.json             Supported model list, structural rows, diagnostics
  docs/                     Model contract and this workflow
  examples/                 Syntax example with its original source/assumptions
  models/                   Valid compiled models, if supported; author here
  programs/                 Source experiments written by a person or agent
```

Read the programming context and `analysis.json` before creating a model. An exact reviewed profile or a
supported complete function table can yield a model immediately. For example,
the bundled ESP32-C6 TRM v1.2 yields `esp32c6-pcnt` and `esp32c6-gpio`. Unknown
manuals still produce searchable projects, but may contain no executable models.
Structural register inventories do not imply register side effects or timing.

Start the chosen coding agent **in `chip-work`**, or explicitly point it at that
folder's `AGENTS.md`. Give it a task such as:

> Read AGENTS.md. Use ChipSim to model the documented GPIO output behavior in
> this manual. Review any existing model first. Cite source pages, declare
> omissions and assumptions, add independent acceptance cases, validate against
> the PDF, and return trace artifacts and a TUI session.

For unsupported behavior, the agent authors `models/your.model.json` using
`docs/MODEL_FORMAT.md`. It should inspect diagrams in the original PDF when text
does not establish wiring or behavior. ChipSim does not invent an executable
starter model from an arbitrary document.

Then validate and run (this example uses the supported ESP32-C6 GPIO model):

```sh
chipsim agent check ./chip-work/models/esp32c6-gpio.model.json --project ./chip-work
chipsim agent run ./chip-work/models/esp32c6-gpio.model.json --project ./chip-work --out ./chip-work/runs/first --ticks 40
chipsim --document ./chip-work/manual.pdf --model ./chip-work/runs/first/session.json
```

`run` writes `trace.json`, `trace.csv`, `trace.vcd`, `session.json`, and `result.json`.
Its response is a summary, not the entire trace. `tui` and `snapshot` are argument
arrays for interactive opening and a noninteractive frame. For example:

```sh
chipsim --document ./chip-work/manual.pdf --model ./chip-work/runs/first/session.json --snapshot --view registers --at 10 --columns 120 --rows 40
```

The TUI creates its own persistent workspace (`.chipsim/` by default); use
`--workspace` to choose a location. A session contains the model, normalized
parameters, input events, duration and cursor, but not the PDF. Attach the PDF
when opening to verify source quotations. All time is normalized model ticks.

Pass `--params parameters.json` for parameter overrides and `--inputs events.json`
for stimulus. JSON numbers use decimal syntax; the TUI accepts decimal, hex,
binary and octal entry. Integer CLI options such as `--ticks` also accept explicit
`0x`, `0b`, and `0o` prefixes. Changing a display base never changes the experiment.

## Live monitoring

Run `chipsim --watch ./chip-work` in a separate terminal before or while the
agent works. It opens Activity (`8`) and observes the prepared project every
500 ms. You can choose the initial view with `--view wave`, `--view registers`,
or `--view activity`. `--snapshot` performs one observation and exits; it does
not keep watching. The tool never launches or connects to a model provider.

`prepare` records completion; `search` and `page` record requested sources and
returned page numbers/ranges; `check` and `run` record start, source verification,
acceptance progress, completion and failures. The monitor also notices JSON
model creations, changes and removals under `models/`. Edits are shown as awaiting
check/run, and do not install an unvalidated model. Commands run outside ChipSim,
direct PDF/editor reads, and the agent's private reasoning are not captured.
Use an explicit note for other work:

```sh
chipsim agent note ./chip-work "Reviewing the reset and output-enable rules"
chipsim agent activity ./chip-work --limit 20
```

`note` accepts 1–2000 characters. `activity` returns the last 50 events by
default, up to 200 with `--limit`. Both follow the normal JSON/exit-code protocol.
The latest 500 command events are retained in
`.chipsim-agent/activity/<timestamp>-<uuid>.json` within the prepared project.
Individual files are published atomically so concurrent commands cannot
interleave records. `.chipsim-agent/latest-run.json` retains the latest
successful run independently of event retention. Model-edit observations and
watch errors are local to the open monitor. Logging problems appear as optional
`activityWarnings` without changing the command's simulation/check outcome.

A run is published after its artifacts and final `result.json` have been
written. The monitor verifies result/session fingerprints, artifact presence,
project PDF/cache fingerprints, freshly extracted PDF quotations, schema, acceptance cases and the
simulated session before replacing its trace. Run outputs can be outside the
project if they were published by the agent CLI. Older projects are supported:
completed successful `runs/*/result.json` files can be discovered without a
journal; these older sessions have no recorded publication fingerprint.

Reload preserves the active view, selected signal by ID (or the first signal if
absent), display base, zoom and cursor. The cursor is clamped to shorter traces.
The new run supplies model, parameters, stimulus and duration. It is not merged
with local edits. Press `W` to pause reload before editing; activity remains
live, and resuming loads the newest valid completed run. Reload waits while a
prompt, menu, help, step-details overlay, local operation or external dwfv viewer
is active. It does not modify model files in the project or persist watched
models to the TUI workspace. Failed, partial, changed or invalid runs leave the
working simulation intact. Fault traces remain available for manual `d` import.

In Activity, `j/k` browses events and stops following; `G` follows the newest
event; `/` filters event text; `h/l` scrolls complete selected-event details.
Other views show a one-line activity summary. `q` stops polling and restores the
terminal. Watch mode accepts neither `--params`, `--inputs` nor `--ticks`;
configure the experiment with `agent run`. This is monitoring discrete model
experiments, not streaming measurements from physical hardware.

## Machine interface

Every `chipsim agent` command emits exactly one JSON object to stdout, including
failures. The envelope contains `format: "chipsim-agent-result"`, `version: 1`,
`command`, and `ok`. It never requires a TTY, prompts, emits ANSI, or starts an
agent/provider. Exit codes are **0** for success, **1** for model/source/file/
dependency/simulation failures, and **2** for invalid command arguments. Errors
include `diagnostics` with a code, message and optional details. `check` returns
named pass/fail acceptance results. Failed checks cannot produce a successful run.

`search` uses case-insensitive AND matching of whitespace-separated terms within
each page. It returns at most 10 page excerpts by default (maximum 50), each at
most 600 characters. Use `--offset` and `--limit`; `nextOffset: null` means the last
batch. `page` returns 8000 characters by default (maximum 16000); its offset and
nextOffset use JavaScript string character offsets. Page numbers include front
matter and can differ from printed page labels. Search and page reads use the
fingerprinted cache; they check that both PDF and cache bytes remain unchanged.

`check` and `run` re-extract the actual saved PDF rather than trusting editable
cache text. All declared sources must match that single manual. Schema, actual
page quotations and acceptance cases must pass. Missing PDFs are errors here;
the older interactive import path permits unverified-source warnings. A quote
match verifies textual provenance, not the interpretation or silicon fidelity.

`prepare` and `run` require a new output directory, even if an existing directory
is empty. Ordinary failures remove only the newly created output. Interrupted
preparation may leave a partial directory without a manifest: choose a new path
or inspect/remove that partial output. Simulation faults return `ok: false` and
exit 1 while retaining the fault trace/session for debugging. Partial parameter
overrides are normalized to the complete effective configuration in all exports.

PDFs must contain searchable text and be at most 80 MiB; scanned pages need OCR.
Model, parameter and stimulus JSON files are capped at 3 MiB. Engine limits and
unsupported semantics remain those in `MODEL_FORMAT.md`. Current projects hold
one manual; multi-manual model checking is outside this command's scope.

## Agent compatibility

The interface requires filesystem access and a way to execute a local process.
It does not depend on an agent-specific extension API. Checking an agent's tool
interface establishes how it can invoke ChipSim; it does not establish the
quality of models authored by that agent.

| Agent               | Invocation route                                        | Instructions                                                |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Codex               | Its command execution tool runs `chipsim agent …`       | Read the prepared folder's `AGENTS.md`                      |
| Pi                  | Built-in `bash` tool runs the same command              | Start in the prepared folder or explicitly read `AGENTS.md` |
| prime-agent         | `ipython` calls `subprocess.run` with an argument array | Read the prepared folder's `AGENTS.md`                      |
| Other coding agents | Any shell/process tool with Node and Poppler available  | Read `AGENTS.md` and `chipsim agent help`                   |

For a Python-based tool:

```python
import json, subprocess
result = subprocess.run(
    ["chipsim", "agent", "check", "models/your.model.json", "--project", "."],
    capture_output=True, text=True, check=False,
)
report = json.loads(result.stdout)
assert result.returncode == 0 and report["ok"], report
```

Compatibility review (2026-10-08) used local help/version output from Codex CLI
0.160.1, Pi 1.1.0, and prime-agent 0.9.8. Codex supports project instructions as
documented in [AGENTS.md guidance](https://developers.openai.com/codex/guides/agents-md/).
Pi documents its command-line and tool interface in the
[upstream documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs).
prime-agent's [upstream README](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/README.md)
describes its Python tool; the local installed help also confirms it.
The installation smoke test executes the packed tool through Node and Python
subprocesses outside the checkout, including failed commands and TUI snapshots.
No separate authenticated agent/model session is launched as part of these tests.
Agent permissions and provider data handling remain controlled by that agent;
ChipSim itself makes no background network calls or uploads.

Run `npm run test:install` to repeat the isolated, offline package-install test.

For HDL experiments, use `chipsim hdl doctor|import|run|compare` and [HDL.md](HDL.md). This separate process interface accepts source/testbench manifests and explicit comparison maps, keeps one versioned JSON result with meaningful exit status, and exports waveform artifacts without requiring a PDF. Source fingerprints identify the HDL files and simulator backend; they do not establish vendor documentation fidelity. Waveform import is data-only and never executes HDL.
