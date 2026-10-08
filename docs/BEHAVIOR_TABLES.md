# Entered behavior tables

For a manual whose behavior cannot be compiled automatically, press `c` in the TUI and choose **Behavior table**. Define named binary inputs, binary outputs, states, and complete transition rows; cite the imported PDF page and an exact excerpt. ChipSim builds a source-linked JSON model and opens it in the usual waveform, blocks, log, register, and stimulus views.

These are **developer-authored rules**. The builder does not interpret PDF prose or verify that your chosen behavior matches the device. Source quotation checks establish textual provenance; generated acceptance cases check consistency with the entered rows. Scope, assumptions, and every entered row remain visible in Model view (`5`) and exported model JSON (`M`). Automatic function-table compilation remains a separate, stricter path.

## Row syntax

```text
currentState INPUTBITS -> nextState / OUTPUTBITS
```

- Input and output patterns follow the declared pin order, left to right. Pins are one bit each.
- Input characters are `0`, `1`, or `X` (don't care). Output characters are `0`, `1`, or `=` (retain that output's previous bit).
- `*` in the current-state position matches every declared state. The next state must be a declared name. Names are case-sensitive; names differing only by case cannot be declared together.
- Separate rows with semicolons in the prompt, or put one row per line in a text file and enter `@path/to/file.rules.txt`. Paths containing spaces can be quoted after `@`.
- Every state/input combination needs an explicit row. Missing combinations never become hold rules.
- Overlapping rows must give the same next state and output bits for every relevant prior output. Row order does not establish priority. Encode reset/enable conditions explicitly.

All input events at a tick apply before one row executes. **Tick zero initializes the chosen state/output scenario; rows start at tick one.** Holding inputs can advance the machine again on each later normalized tick. No clock, bus transaction, reset, package wiring, electrical timing, or power-on value is inferred from a name.

## A single NAND function from a real source

```sh
npm start -- --document docs/references/nexperia-74hc00.pdf
```

Press `c`, choose Behavior table, give it a name, and use inputs `A B`, output `Y`, and state `logic`. Enter `@examples/nand.rules.txt`, which contains:

```text
logic 0X -> logic / 1
logic X0 -> logic / 1
logic 11 -> logic / 0
```

Cite [PDF page 3](references/nexperia-74hc00.pdf#page=3) and the exact excerpt `Quad 2-input NAND gate`; explain that the page's function table supports the manually entered rows. Declare that this is one gate evaluated at normalized steps, with package replication and electrical propagation omitted. The two wildcard rows agree when both inputs are zero. The four input combinations become acceptance cases.

The default Gray-code sweep drives `00`, `01`, `11`, `10` at ticks 1–4, giving Y values `1`, `1`, `0`, `1`. This entered model applies its rows after initialization; the automatically compiled NAND model separately uses instantaneous table evaluation including tick zero. Select the model appropriate to your intended experiment and its stated scope.

## A custom control machine

Use inputs `RESET ENABLE`, output `Q`, and states `idle armed`. `examples/control.rules.txt` contains:

```text
* 1X -> idle / 0
idle 00 -> idle / =
idle 01 -> armed / 1
armed 00 -> armed / =
armed 01 -> idle / 0
```

Reset explicitly clears Q and returns to idle. With reset low, enable advances between idle/armed; disabling retains both state and Q. Every ordinary row requires RESET=0, so it does not conflict with the global reset row. This is an illustrative developer-selected machine, not a vendor chip model. Cite a relevant manual excerpt and declare what it supports and which rules you have assumed.

## Explicit clock history

A pin called `CLK` is an ordinary binary input. To model edges with this builder, enter states representing the previous clock. `examples/flip-flop.rules.txt` uses inputs `CLK D`, output `Q`, and states `low high`:

```text
low 0X -> low / =
low 10 -> high / 0
low 11 -> high / 1
high 0X -> low / =
high 1X -> high / =
```

These rows capture D only when the modeled prior clock is low and current CLK is high. Held levels and falling clocks retain Q. The [TI SN74AHC273-Q1 table on PDF page 12](references/ti-sn74ahc273-q1.pdf#page=12) supports this selected normal-operation behavior with CLR held high; asynchronous clear, package replication, and physical timing are omitted from these entered rows. Choose initial `low`/`high` to match your separately driven tick-zero CLK. Initial history is a scenario choice, never initialized implicitly from a pin name. For the automatically compiled CLR/CLK/D/Q table with clear, import the original PDF directly; see `FUNCTION_TABLES.md`.

## Revising a model in the TUI

Select an entered table and press uppercase `E`. The edit menu changes rows, pin/state declarations, name, source page, quote, claim, and assumptions. Rows still accept `@file`; export draft rows to edit them in your text editor. A draft may temporarily contain incomplete rules while you edit related fields. Review and save require complete valid rules, valid source evidence, and passing checks.

**Review draft** compares the current tick's outputs and state against the working experiment without changing the installed model. **Save revision** keeps parameters, stimulus, duration, display, and cursor when compatible. Output names/order must remain identical so retained output bits keep their meaning; existing events and initial state must remain valid. Incompatible experiments require correction or **Save as new model**, which starts a separate experiment with fresh defaults and demonstration inputs. Revisions preserve additional independent acceptance cases; a new copy starts with generated cases, leaving the original model's independent cases intact. Update claims and assumptions when changing behavior beyond what the cited source specifies.

Esc closes the edit menu or prompt while retaining its in-memory draft; reopen `E` to resume. **Discard unsaved draft** explicitly clears it. Drafts are not persisted across restarts or model replacements. The original source PDF must be attached before editing; another PDF cannot silently replace it.

Before replacing a model, ChipSim atomically saves the previous session under `.chipsim/revisions/<model-id>/<timestamp>-<uuid>.session.json`. Choose **Revision backups** in `E` to restore the model, parameters, events, duration, cursor, and display. Restoring also backs up the current experiment. Backups are local JSON and do not embed PDF bytes; keep the attached source documents. Backups accumulate until you remove unwanted files yourself. Failed validation, simulation, or model writes preserve the active model and experiment; a failed write may leave a harmless backup. Saving/restoring clears stimulus undo history for that model.

New tables include a validated portable `authoring` record. ChipSim checks that the declared draft reproduces the executable model; stale metadata cannot overwrite direct JSON edits. Older generated tables can reopen only when their complete behavior and assumptions are exactly reproducible. For other JSON models use `M` and the declarative-model workflow. Remove `authoring` before intentionally editing generated fields outside the builder; this also removes guided editing unless the resulting model remains exactly recoverable.

## Inspection, persistence, and bounds

`p` selects an initial named state and output word; the first output is bit 0 of `initialOutputs`. `behavior_state` exposes the current numeric state code, with the name/code mapping in Model view. Actual state names also appear in logs and trace states after the first step. Events identify the exact entered row. Use `i` or `7` for experiments, `U`/`R` for undo/redo, and `S` to save a portable session. `M` exports editable model JSON; models also persist in the local workspace. The optional browser can import those models and sessions and verify their source quotations against the same PDF.

Bounds are six input pins, eight output pins, eight states, 32 rows, and 64 exhaustive acceptance cases. The case count is `states × 2^(inputs + retained-output-columns)`; output columns that never retain need no prior-output dimension. Text rule files are regular files of at most 64 KiB and contain row data only; comments, expressions, embedded code, Z outputs, multi-bit pins, and undeclared symbols are unsupported. Bad rules or source quotes leave the working model intact and keep the prompt available for correction.

For multi-bit registers, arithmetic, timed protocols, analog effects, or behavior beyond these bounds, author a reviewed model using `MODEL_FORMAT.md` and `AGENTS.md`. A behavior table can cover a useful stateful mechanism; it does not reconstruct arbitrary chips or whole reference manuals automatically.
