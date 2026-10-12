# Visual inspection of experiments

ChipSim computes a trace, then renders the recorded snapshot at the playback
cursor. Moving the cursor does not execute CPU instructions or establish
physical timing. All views share that cursor.

| View            | Question answered                                              | Terminal      | Browser    |
| --------------- | -------------------------------------------------------------- | ------------- | ---------- |
| Waveforms       | When did a pin change?                                         | `1`           | Signals    |
| Hardware blocks | Which modeled resources participated?                          | `2`           | Inspect    |
| Registers       | What values were retained?                                     | `6`           | Inspect    |
| State graph     | What paths are possible and which was taken?                   | `g`           | States     |
| Bit flow        | Which bit was captured or which assignment read/wrote a value? | `v`           | Bit flow   |
| Comparison      | Where do two experiments disagree?                             | `Y`, then `D` | Comparison |

## State graph

The directed finite-state-machine diagram uses nodes for states and arrows for
transitions. The browser renders the full graph, with double borders for
terminal states. Browser graphs scroll in both directions, keeping node text
readable up to the 64-state model bound. The terminal renders the focused state,
incoming/outgoing branches and retention loops; `j/k` focuses another state and
Enter lists full rules and observed ticks. A focused state can differ from the
current state.

Document models show every declared state and ordered transition, including
unvisited branches, actual condition expressions, priority, transition actions
and evidence IDs. The first true condition wins. Explicit self-transitions run
their actions and state entry and reset `stateAge`; dashed retention loops mean
no transition. Terminal states latch while input events remain observable.

Built-in nodes summarize teaching-scenario phases, not an extracted vendor FSM
or complete instruction-level program. PIO includes its FIFO load stall; XMOS
and eTPU retain their distinct fault paths. eTPU guards describe capture/service
behavior rather than immediate polling. Observed counts cover the entire trace;
highlighting describes the cursor tick. In the browser, click a node (or use
Enter/Space), inspect its rules, then **First observed** to seek that transition.
Terminal rule selection also seeks its first observed tick.

New declarative traces record exact `{from,to,index}` transition metadata. Old
observations cannot establish which same-target rule fired, or whether a
same-state observation was an explicit self-transition; those edges are not
guessed. Recorded HDL signals do not declare an FSM. Browsing a `.chip` trace
does not execute future statements: use `N`/`C` in Program first.

## Bit flow

The six supplied examples show the masked 8/12-bit payload LSB first (bit 0 on
the left), current DATA/CLK/ACK, receiver samples and decoded word. Dots mark
uncaptured bits. A capture follows the recorded sample-count increase, including
a zero or repeated bit. Tick zero invents no edge; a PIO load stall claims no
bit launch. The receiver belongs to the teaching experiment, not inferred chip
wiring. Browser animation moves the captured bit once when the cursor changes
to its capture tick, honors reduced motion and has cosmetic speed. The terminal
shows a capture arrow and bit highlighting.

Document models show executed assignments in order: stage, target width,
before/after values and field values actually read during evaluation. Sequential
writes expose intermediate values, not merely end-of-tick registers. Lazy
`select` records only its chosen branch; literals have no read arrows. Repeated
same-value writes remain visible. Zero, `Z` and unavailable remain distinct.

The engine records the first 64 assignments per tick plus the total executed
count. Later actions still execute. Faults retain successful assignment prefixes;
a failing write is not shown as completed. These are additive JSON trace fields
(`operations`, `operationCount`, `transition`), not new imported-model rules.
Older observations without assignment metadata show value changes only and do
not invent internal dependencies or physical data paths.

## Compare experiments

Run a reference, press `Y` in the terminal or **Capture reference** in browser
Comparison, then change parameters, stimulus, model or session. The captured
trace, declaration widths and settings stay unchanged. `D` opens comparison;
`[`/`]` jump to previous/next differences. Browser buttons also jump to the first
difference. Enter in terminal Comparison opens load/export/clear actions.
Capture again deliberately replaces the reference.

Comparison checks exact state/phase/signal/register names at identical normalized
ticks. It separately reports parameters, ordered stimulus events, duration and
changed widths. Logs, styling and assignment annotations are excluded. Different
model IDs do not imply signal mapping. A match covers this experiment only;
check declaration widths before interpreting a numeric match.

The common timeline extends to the longer trace. Missing snapshots are
**unavailable**, not held copies of the last sample. Leaving Comparison clamps
the cursor to the live trace; saved current-session cursors stay within that
trace. Capture/import/export preserves the live model, settings, stimulus
history and source-program execution. References live in memory until cleared
or the workbench closes; ordinary session saves do not embed them.

Load accepts `chipsim-session` or exported `chipsim-trace` JSON up to 32 MiB.
Validation/comparison preflight happens before replacing the reference. Failure
keeps the previous reference and experiment. Terminal sessions replay model and
program behavior with existing source-guide checks, without installing the
reference model. Browser model sessions replay without installation. For `.chip`
runs in the browser, load exported `trace.json`: the static browser does not
replay source programs or verify their guide files.

Imported traces are labeled **recorded**: bounds, field declarations and widths
are validated, but import executes no definition and authenticates no run.
Legacy built-in exports may have observed 32-bit registers without declarations.
The report uses `format: "chipsim-experiment-comparison"`, version 1, and includes
reference/current sessions and origin labels, configuration changes and all
differences (`null` means unavailable). It is an inspection report, not a
loadable session or acceptance case. Retain the original trace alongside reports
using recorded references.

Draft behavior-table review still requires identical experiment settings.
HDL comparison uses `H` and explicit mappings, widths and time units; normalized
experiment comparison does not silently convert HDL timestamps.

## PIO example

```sh
chipsim --model pio --view states --at 32
chipsim --model pio --view flow --at 2
```

With payload 179, 8 bits and half-period 2, bit 0 is captured at tick 2; the frame
enters `wait` at 32 and default ACK enters `success` at 35. Capture a reference,
change ACK to `missing`, and compare: the first difference is 35 and timeout is 40. In a source program, run `N`/`C` before inspecting future ticks.

Agents should explain a specific recorded experiment, then derive independent
expectations from its source and assumptions. See [Model format](MODEL_FORMAT.md),
[TUI](TUI.md) and [behavior changes](CHANGELOG.md) for contract and context.
