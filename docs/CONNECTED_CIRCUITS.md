# Connected circuit state and next-state models

ChipSim can inspect a circuit's declared connections and complete binary
transition rules, separately from the transitions observed in a simulation.
This is a distinct version-1 `chipsim-circuit` contract. Existing JSON models
retain their ordered assignments and first-true transition behavior.

Two authoring paths share the same checked representation:

- **HDL is authoritative:** `circuit import` runs an explicitly selected Yosys
  lowering, derives actual gate/flop connections, and checks small models against
  the original RTL with Icarus. It preserves source/tool identities and a mapping
  from connected state IDs to retained RTL state bits.
- **Tables/equations are authoritative:** author a connected JSON model, then
  `circuit build` generates SystemVerilog and a symbolic SMT-LIB representation
  from those same rules. No independently maintained handwritten RTL is assumed
  to agree. `circuit verify --rtl FILE` can check another implementation.

Neither flow needs a PDF. Initial values and rules identify authored scenarios,
not vendor power-up guarantees or physical silicon accuracy. Fixed connections
do not mean fixed signal levels: mux selectors choose among existing paths.

## Try the examples

```sh
chipsim circuit help
chipsim circuit check examples/connected-circuit/swap.json
chipsim circuit verify examples/connected-circuit/swap.json --out /tmp/swap-check
chipsim circuit run examples/connected-circuit/counter-capture.json \
  --stimulus examples/connected-circuit/counter-capture.stimulus.json \
  --out /tmp/counter-recording
chipsim --circuit /tmp/counter-recording/circuit.json
```

Use new output directories; existing destinations are never replaced. In a
checkout, replace `chipsim` with `node scripts/chipsim.mjs`. For installed paths,
use `agent help` → `examples.circuit` and `documentation["CONNECTED_CIRCUITS.md"]`,
or `design guide circuit`. Source inspection, symbolic checks and HDL generation
need only Node.js 22.13+. Explicit native run/verification needs `iverilog` and
`vvp`; HDL import additionally needs an existing Yosys executable. No tools,
providers or credentials are installed automatically.

## First supported digital subset

Version 1 supports finite unsigned binary vectors, combinational equations and
tables, explicit initialized register state, one declared rising-edge clock and
designer-defined synchronous reset/safety/enable rules. The clock input must be
one bit with explicit initial zero. It is an event source, not a routable data
path. Initialization is not an edge, and a held high or falling clock holds state.

At a rising edge, every guard and D expression reads the **same old-state and
sampled-input snapshot**. All accepted updates then commit together. Outputs
are evaluated both before commit and after the acyclic combinational network
settles with the new Q values. Reset has no special inferred behavior: its rule,
condition, loaded value and explicit priority define its synchronous effect.
Changing reset without an edge does not update stored state.

For the cross-connected swap example, `A_next=old(B)` and `B_next=old(A)`.
From `(A,B)=(0,1)` this produces `(1,0)`, regardless of declaration/rule order.
The counter/capture example captures old Count while Count increments on the
same edge, or selects explicitly wired external data.

Memories and memory ports, asynchronous reset/control, latches, multiple/gated
clocks, clock-as-data paths, unknown/uninitialized state, X/Z/resolved buses,
black boxes and combinational loops are unsupported and reject. There are no
implicit tick/age counters, event queues, bypass paths, dispatch or writable
combinational storage. Add such state explicitly where expressible, or use the
native HDL flow for unsupported hardware. CDC, metastability, propagation
delays, analog behavior and physical/transistor accuracy are outside this model.

## JSON connections and rules

Read [swap.json](../examples/connected-circuit/swap.json),
[load-hold.json](../examples/connected-circuit/load-hold.json) and
[counter-capture.json](../examples/connected-circuit/counter-capture.json) for
complete minimal files. Required top-level fields are `format`, `version`, `id`,
`name`, `clock`, `inputs`, `state`, `nodes`, `outputs`, `connections`; `description`
is optional. Unknown fields reject. Identifiers start with an ASCII letter and
contain at most 32 letters/digits/underscores.

Inputs declare `id`, `width`, `initial`. State elements declare those fields,
named input `ports` with widths, and exactly one `rules` or `table` definition.
Nodes declare `id`, `width`, `ports`, `expression`. Outputs declare `id`, `width`.
Widths are 1–64 bits. Numeric values are unsigned safe JSON integers or decimal,
`0b` binary or `0x` hexadecimal strings that fit their width; no truncation of
out-of-range literals, implicit zero or signed extension occurs.

Each connection names `from`, `to`, and optionally an inclusive `[high,low]`
source `slice`. Valid sources are `input.ID`, `state.ID` (Q), and `node.ID`.
Destinations are `state.ID.PORT`, `node.ID.PORT`, and `output.ID`. Every declared
destination needs exactly one equal-width driver. References to missing signals,
unbound ports, D endpoints as freely readable sources, partial destination
writes or multiple drivers reject. State feedback crosses an event boundary;
combinational node dependencies must be acyclic. Declared edges constrain which
values an expression can read; they are not decorative diagram links.

Expressions are data, with no evaluated source strings:

| Form | Meaning |
| --- | --- |
| `{"ref":"PORT"}` | Read this element's declared connected input port |
| `{"bits":"0x3","width":4}` | Explicit unsigned constant |
| `{"op":"add","args":[A,B]}` | Same-width modular addition; subtraction uses `sub` |
| `and`, `or`, `xor`, `not` | Same-width bitwise operations (`not` has one argument) |
| `eq`, `ult` | Same-width equality/unsigned less-than, producing one bit |
| `{"op":"mux","args":[SELECT,YES,NO]}` | One-bit selector and same-width data paths |
| `{"op":"slice","args":[A],"high":3,"low":0}` | Explicit inclusive bit slice |
| `{"op":"concat","args":[HIGH,LOW]}` | MSB-first concatenation; at most 16 arguments |

Every rule declares unique `id`, `priority` (0–65535), `reason`, and a one-bit
`when`. It either declares a same-width `value` expression, or `hold:true`.
Reasons are `load`, `reset`, `safety`, `hold`; `hold` requires `hold:true` and
other reasons require a value. Larger numeric priority wins. Same-priority
winning rules may overlap only if their next values agree for every overlap.
Rule order never defines priority. An explicit always-true low-priority hold
is permitted; an omitted case is not silently repaired into hold.

A table declares ordered connected-port `columns` and `rows`. Each row has
`id`, `match`, `priority`, `reason`, and `value` or `hold`. `match` spells every
column bit MSB-first using `0`, `1`, or `X` (binary-domain don't-care, **not an
unknown runtime value**). Tables lower to the same typed guards and rules.

## Complete rules, probes and native observations

`circuit check SOURCE` uses reduced ordered binary decision diagrams to check
every binary state/input assignment at a rising edge for missing cases and
contradictory winning writes. A failing result includes a concrete snapshot
that can be supplied to `circuit step` to reproduce it. Higher-priority rules
mask lower-priority conflicts only where those higher-priority guards hold.

`complete-scoped-proof` applies only to rule completeness/agreement over this
finite domain. It is **not** reachability, a temporal property proof, observed
coverage, or HDL equivalence. BDD budget exhaustion returns `inconclusive` and a
failing command result; skipped/unexplored assignments never count as a pass.
Larger state is represented with compact equations, not a giant truth table.
`relation.smt2` describes old/next Q and pre/post-commit outputs; its query checks
guard completeness only. A solver result must retain that scope.

For a one-event probe, supply all state/input values and previous clock:

```json
{"state":{"A":0,"B":1},"inputs":{"clk":1},"previousClock":0}
```

```sh
chipsim circuit step examples/connected-circuit/swap.json --snapshot step.json
```

This evaluates one relation snapshot; it does not run or duplicate an HDL
simulator. Result fields separate old Q, sampled inputs, next Q, pre/post outputs,
matching/accepted rules, connected ports and selected guard/data dependencies.
Static dependencies retain both mux paths; selected flow follows the selected
branch. A probe does not advance an existing recording.

`circuit run` executes generated HDL using the existing native runner. Explicit
`chipsim-circuit-stimulus` v1 events have `tick`, `signal`, `value`, and a declared
`duration`; initial inputs come from the source, events begin at tick 1. One
stimulus tick is one testbench ns, a scheduling choice, not a physical delay
claim. At the same timestamp, data/control changes settle before the clock edge.
The harness does not invent clocks or edges; the default has no input events.

`circuit verify` injects arbitrary old state in a test harness, samples a rising
edge, and compares actual old Q, sampled inputs, next Q and settled outputs.
Up to 12 binary state/non-clock input bits, it checks all combinations (at most
4096). Larger domains need `--cases CASES.json`, an array of complete snapshots.
Successful native correspondence is labeled `simulation-only`, even for an
exhaustive one-step case set. A mismatch is `counterexample`; incomplete/failed
native capture is `inconclusive`. State injection is a verification mechanism,
not a new circuit input, routing path or physical programming capability.

## Import authoritative SystemVerilog

```sh
chipsim circuit import design.sv --top my_top --clock clk --initial inputs.json \
  --yosys /path/to/existing/yosys --out /tmp/connected-import
```

`inputs.json` explicitly gives every input's initial value; clock must be zero.
The first importer accepts one self-contained unsigned SystemVerilog compilation
unit, without external includes. Top names are 1–23 ASCII identifier characters;
ports must be ordinary zero-based descending unsigned input/output vectors.
It runs `hierarchy`, `proc`, `flatten`, structural checks, `techmap`, `simplemap`,
cleanup and JSON export. It consumes the resulting actual net bit connections,
not inferred wiring from variable names. Supported primitive cells are buffers,
NOT/AND/OR/XOR/XNOR/NAND/NOR/ANDNOT/ORNOT/mux and positive-edge DFFs. Every retained
flop must have known binary HDL initialization and the same declared clock.
Unsupported cells/constructs and missing initialization fail explicitly.

The original RTL, lowering script, tool version/hash, netlist and diagnostics are
retained. `R0`, `R1`, etc. map to actual retained RTL state bits and original net
names. Reset selection remains in actual connected logic; its purpose is not
inferred from a signal called reset. The view describes the lowered digital
model, including all retained flop bits, not a physical placement/routing graph.

For domains up to 12 bits, import checks the derived relation against the
**original RTL** in Icarus, using mapped state injection rather than comparing
only regenerated HDL. Larger imports need `--cases` for this check; otherwise
original correspondence remains explicitly inconclusive. Native state mapping
requires ordinary inspectable hierarchical register names. Lowering success
alone is not a proof of HDL correspondence. No SBY/EQY run or temporal proof is
implied; existing formal/equivalence adapters remain available for supplied
properties/configurations and their independently scoped results.

## Evidence, terminal and managed projects

Bundles retain source, `relation.json`, `coverage.json`, generated RTL, SMT-LIB,
testbench/manifests and hashes. Runs also retain native source/tool/diagnostic
snapshots, waveform JSON, CSV, VCD, portable `session.json` and correspondence
reports where applicable. `circuit validate BUNDLE/circuit.json` verifies captured
hashes, reruns scoped coverage and rejects changed compiler/source/RTL/tool
identities when original files remain available. Missing external originals
leave a captured snapshot, not an assertion that the current source matches.
Frozen portable sessions preserve source bytes and observed waveform hashes.
Hashes establish stored identity, not correctness or a security boundary.

Open a source, bundle or portable session with `--circuit` or ordinary `d` import.
Press `O` for the connected view, `t` for static rules/connections, `e` for a
one-step probe and `o` for native observations. `[`/`]` select stored state;
`j`/`k` scroll complete wrapped details; `p` loads a probe snapshot.
`s` shows frozen authoritative source and `r` the generated RTL. `h`/`l` move
the native event cursor; `1` shows the same waveform and `S` saves a portable
session. Probes and mode switches preserve the recording and cursor. Failed
validation/import preserves the active model. Native correspondence harness
state injection is labeled separately from circuit transitions.

The managed `circuit` adapter requires explicit options `source` and `operation`
(`check`, `build`, `run`, `verify`), with optional `stimulus`, `cases`, `rtl`.
Inputs and the compiler identity enter the managed fingerprint. It publishes
separate `coverage`, `simulation`, `correspondence` checks as applicable; choose
them explicitly in `requiredChecks`. A `circuit-session` output opens through
verified artifact inspection without replacing the active project. A generated
bundle also includes an ordinary HDL managed design for native simulation.
Generic tool execution success never substitutes for coverage or correspondence.

## Bounds and regression checks

Source: 1 MiB; widths: 1–64 bits; states: 1–64; total state/non-clock input domain:
512 bits; inputs/outputs: at most 64 each; nodes: 128; connections: 1024; total
rules: 512; table rows: 256 per state; ports: 32 per element; expression nodes:
4096 total, depth 32. Symbolic checking: 100000 BDD nodes/2000000 operations.
HDL import: at most 192 lowered cells, also subject to all connected-model
bounds. Native correspondence: 4096 cases; stimulus: 10000 events and duration
1–10000 ns; native/lowering execution: 30 seconds, version probe: 10 seconds.
Common native capture limits still apply. Unsupported/bounded-out work is
reported as failed/inconclusive, never silently omitted.

```sh
node --test test/circuit*.test.js
CHIPSIM_TEST_CIRCUIT=1 node --test test/circuit*.test.js
CHIPSIM_TEST_CIRCUIT=1 CHIPSIM_YOSYS=/path/to/yosys node --test test/circuit*.test.js
```

Tests use independent swap/load/counter oracles, reordered declarations/rules,
coverage/conflict witnesses, selected mux paths, large symbolic state, stale
artifacts, unsupported constructs, actual Icarus/Yosys execution, intentional
RTL mismatch, managed evidence and portable-session inspection. Terminal tests
cover 80×24 and 120×40; packaging tests exercise installed discovery and source-free
commands. Existing table/JSON/HDL semantics and sessions remain separately tested.

## Validation against the requested feature

Validated on 2026-10-30 against the user's `addthis.md` specification
(SHA-256 `4a0c79a35f5767a839d6118164c5bf491173d4ea34ceb2808b33732498c6a5c0`).
The implemented first subset and exclusions are stated above; the original
request's baseline audit does not describe the new implementation.

| Requested contract | Implementation and acceptance evidence |
| --- | --- |
| Stored state with explicit initialization, reset validity and update events | Typed initialized vectors; clock initial zero; explicit synchronous reset rules. Exhaustive load/hold/reset checks and native initialization comparison run before arbitrary verification-state injection. Wrong initial RTL produces a counterexample. |
| Fixed connections, slices, selectors and legal data/control paths | Mandatory single drivers and local-port-only references; explicit mux/bit slices; undeclared paths, width conflicts and combinational loops reject. Static dependencies and selected paths remain separate. |
| Complete explicit update rules, hold/conflict handling and numeric priority | Tables/equations use the same typed representation. Exact BDD checks produce executable missing/conflicting-case witnesses; agreeing overlaps and explicitly masked lower priorities are checked separately. |
| Simultaneous old-state sampling and event semantics | All four swap states and reordered declarations/rules agree with independent expectations. Counter/capture checks all 1024 binary one-edge cases, including same-edge enable/data/selector changes; reset waits for the declared edge. |
| Composition and every dependency needed for a step | One-event snapshots explicitly supply complete old state, sampled inputs and previous clock. Derived wires are not writable state. Implicit age/tick counters, pending-event queues, memories/ports and unsupported clock/control semantics are excluded rather than inferred. |
| Full finite coverage and compact larger relations | BDD checking distinguishes exact scoped rule proof, counterexample and budget-inconclusive outcomes. A 128-bit state relation remains compact; 64-bit arithmetic/overflow, high-bit preservation and old-state capture pass explicit native cases. SMT emission is independently checked with Z3, including post-commit values. No reachability/temporal proof is claimed. |
| Single executable source of truth and HDL-backed derivation | Authored JSON generates its HDL/SMT. Actual Yosys-lowered HDL derives the same connected contract, preserving every retained flop bit and source mappings. Import checks original swap/counter RTL in Icarus, not merely regenerated RTL. |
| Bound identities and stale/unsupported failures | Original source/tool fingerprints, captured netlist re-derivation, generated artifact hashes and the native artifact closure are validated. Changed source/RTL/native sources and unsupported async state, latches, unknown initialization and loops reject with retained evidence. Missing external originals are explicitly snapshot-only. |
| Independent model/HDL checks and honest results | Wrong next-state RTL and wrong initial RTL return counterexamples; failed compilation/capture is inconclusive. Native correspondence remains simulation-only; exact rule proof has its narrower stated scope. No bounded temporal proof is reported because none is performed by this contract. |
| Existing behavior, terminal, exports, packaging and workflow integration | Original ordered JSON engine code is unchanged. Full source-backed regressions, real Icarus/GHDL/debug/evolution regression gates, both terminal sizes, portable reopening, JSON/CSV/VCD round trips, managed checks/evidence and installed-package commands pass. No provider calls, tool installation or browser frontend were introduced. |

The final combined regression command was:

```sh
CHIPSIM_REFERENCE_ROOT=/path/to/private-originals \
CHIPSIM_TEST_HDL=1 CHIPSIM_TEST_HDL_DEBUG=1 CHIPSIM_TEST_EVOLUTION=1 \
CHIPSIM_TEST_CIRCUIT=1 CHIPSIM_YOSYS=/path/to/existing/yosys \
CHIPSIM_Z3=/path/to/existing/z3 npm run test:references -- --verify
```

Result: **331 tests passed, zero failed, zero skipped**; all 34 original-reference
fingerprints matched (134.3 MiB), and the source-backed/native terminal suites
passed at both sizes. The focused circuit suite passed **19/19** with real
Icarus, Yosys and Z3 enabled. `npm run test:install` passed outside the checkout,
including the new connected command, generation and terminal snapshot. Private
originals remain outside the public tree; the acceptance runner's temporary
ignored links were removed. These results cover the declared digital subset,
not physical timing, transistor behavior, CDC qualification or whole-chip proof.
