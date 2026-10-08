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

This is a local install, not an npm registry release. No GitHub remote is
configured yet. A user-writable prefix avoids administrator installation:

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

```sh
chipsim agent prepare /path/to/manual.pdf --out ./chip-work
chipsim agent search ./chip-work "GPIO_OUT_REG" --limit 5
chipsim agent page ./chip-work 271
```

Preparation creates this folder, without replacing any existing directory:

```text
chip-work/
  AGENTS.md                 Instructions for an external coding agent
  chipsim.project.json      PDF/cache fingerprints and format version
  manual.pdf                Unchanged source bytes
  sources.json              Extracted text and selected table geometry
  pages/00001.txt …         One file per one-based PDF page, usable with rg
  analysis.json             Supported model list, structural rows, diagnostics
  docs/                     Model contract and this workflow
  examples/                 Syntax example with its original source/assumptions
  models/                   Valid compiled models, if supported; author here
```

Read `analysis.json` before creating a model. An exact reviewed profile or a
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
