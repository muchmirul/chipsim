# Declarative model format · version 1

A ChipSim model describes a bounded behavior scenario. It is JSON data interpreted locally, with no JavaScript execution. A model must declare its scope, source evidence, assumptions, and executable acceptance cases. The authoritative validator is `src/model/validate.js`; the complete working example is `examples/timer.model.json`.

## Required top-level fields

| Field                      | Meaning                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `schemaVersion`            | `1`                                                                        |
| `id`                       | Unique catalog ID; cannot replace a built-in ID                            |
| `name`, `summary`, `scope` | Nonempty text describing the model and its boundaries                      |
| `fidelity`                 | `"behavioral"`                                                             |
| `parameters`               | Configurable integer, boolean, or enum values; may be empty                |
| `signals`                  | At least one declared input/output signal                                  |
| `registers`                | Internal unsigned registers; may be empty                                  |
| `nodes`, `edges`           | Hardware diagram nodes and directed connections                            |
| `initialState`, `states`   | Initial state ID and finite-state behavior                                 |
| `sources`, `evidence`      | PDF fingerprints, short exact quotes, page citations, and supported claims |
| `assumptions`              | Nonempty array separating assumed behavior from source facts               |
| `checks`                   | At least one executable acceptance case                                    |

Optional `exampleInputs` supplies default demonstration stimulus using the event format below. Optional `duration` sets the default run length to 1–10,000 ticks. The default is 100. IDs start with a letter and contain letters, digits, `_`, or `-`, up to 64 characters. `constructor`, `prototype`, and `__proto__` are forbidden. IDs must be unique within each collection. The six built-in catalog IDs (`pio`, `pru`, `flexio`, `udb`, `xmos`, `etpu`) are reserved.

## Parameters, signals, registers

```json
{
  "parameters": [
    {
      "id": "period",
      "label": "Compare period",
      "type": "integer",
      "min": 1,
      "max": 65535,
      "default": 8
    },
    { "id": "enabled", "label": "Enabled", "type": "boolean", "default": true },
    {
      "id": "mode",
      "label": "Mode",
      "type": "enum",
      "options": ["up", "down"],
      "default": "up"
    }
  ],
  "signals": [
    {
      "id": "reset",
      "label": "RESET",
      "width": 1,
      "direction": "input",
      "initial": 0
    },
    {
      "id": "out",
      "label": "OUT",
      "width": 1,
      "direction": "output",
      "initial": 0
    }
  ],
  "registers": [
    { "id": "count", "label": "Counter", "width": 16, "initial": 0 }
  ]
}
```

Register/signal widths are 1–32 bits. Initial values must fit. Assignment wraps modulo `2 ** width`, including negative arithmetic results. Integer parameter bounds are unsigned safe integers from 0 to `0xFFFFFFFF`. UI fields accept decimal or `0x`/`0b`/`0o` prefixes, but JSON files use ordinary JSON numbers. Enum options and defaults are strings. Set `advanced: true` on a parameter to place it under Advanced controls.

Input stimulus can be supplied separately or stored in the model's optional `exampleInputs` array:

```json
[
  { "tick": 2, "signal": "reset", "value": 1 },
  { "tick": 4, "signal": "reset", "value": 0 }
]
```

Only input signals can be driven; each value must fit its width. Events apply before actions at that absolute tick and hold until changed. Events are sorted by tick; events for the same tick preserve supplied order. The last event for a signal at a tick wins. Values outside the simulated duration are not applied. At most 10,000 events are allowed. The TUI, browser, and simulation CLI use `exampleInputs` unless the caller supplies stimulus; an explicit empty array disables the demonstration events. Acceptance cases use only their own `inputs` (or none) and never inherit demonstration stimulus.

## Expressions and actions

Expressions can be number/boolean/string literals, or reference strings:

- `param.period`: parameter value.
- `reg.count`: register value.
- `signal.reset`: signal value.
- `tick`: current absolute model tick.
- `stateAge`: current tick minus the last state-entry tick, including self-transitions.

An expression object has exactly an operator name and an argument array:

```json
{
  "op": "ge",
  "args": ["reg.count", { "op": "sub", "args": ["param.period", 1] }]
}
```

| Operators                          | Semantics                                                                |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `add`, `sub`, `mul`                | Integer arithmetic                                                       |
| `div`, `mod`                       | Floor division / remainder; zero divisor faults                          |
| `eq`, `ne`, `lt`, `le`, `gt`, `ge` | Strict equality/inequality and comparisons                               |
| `and`, `or`, `not`                 | Boolean result; all supplied argument expressions are evaluated          |
| `bitAnd`, `bitOr`, `bitXor`        | Unsigned 32-bit bitwise operations                                       |
| `select`                           | Conditional value; evaluates only the selected branch                    |
| `shiftLeft`, `shiftRight`          | Unsigned 32-bit shifts; JavaScript's low-five-bit shift-count convention |

`select` takes three arguments: condition, true branch, false branch. Only the selected branch is evaluated. `not` takes one argument; other operators take two. Expressions are limited to 16 levels of nesting. Arithmetic results written to a register or signal must be safe integers or booleans. Use numerical operands for arithmetic; type errors or unsafe results stop the run with a fault snapshot.

Actions assign declared registers/output signals, or emit a log message:

```json
[
  { "target": "reg.count", "value": { "op": "add", "args": ["reg.count", 1] } },
  {
    "target": "signal.out",
    "value": { "op": "bitAnd", "args": ["reg.count", 1] }
  },
  { "log": "Counter updated" }
]
```

Actions run sequentially, so the second action reads the updated counter. A log action supplies event text; a transition's explicit `message` takes precedence. Assigning an input signal is forbidden. Unknown references/operators/actions reject import. Register addresses, bit-field names, and behavior have no implicit semantics: model them explicitly only when sourced.

## State execution

```json
{
  "initialState": "counting",
  "states": [
    {
      "id": "counting",
      "label": "Count when enabled",
      "active": ["counter"],
      "entry": [],
      "tick": [],
      "transitions": [
        {
          "to": "counting",
          "when": { "op": "eq", "args": ["signal.reset", 1] },
          "actions": [{ "target": "reg.count", "value": 0 }],
          "message": "Reset clears counter",
          "active": ["inputs", "counter"],
          "evidence": ["reset-rule"]
        }
      ]
    }
  ]
}
```

Every state requires `entry`, `tick`, and `transitions` arrays, even when empty. Every transition requires a target `to`, condition `when`, and `actions` array. `active`, `evidence`, `message`, and `label` are optional.

Execution order is explicit:

1. Initialize registers/signals to their declared values. Apply tick-zero input events, execute initial-state `entry`, then record tick zero. No transition is taken at tick zero.
2. For each later tick, apply input events, execute current-state `tick` actions, then evaluate transitions in order. The first truthy condition wins; there is at most one transition per tick.
3. Execute the chosen transition's actions, set the target state and its entry tick, then execute target `entry` actions. A self-transition also executes `entry` and resets `stateAge`.
4. Record values, active nodes, state/phase, event, evidence IDs, and before/after changes.
5. A state with `terminal: true` latches with phase `complete`: no further model actions run, but later external signal events remain visible. Arithmetic/runtime faults record phase `fault` and stop immediately.

A duration of `N` produces tick zero plus `N` steps unless a fault stops it. Use a `tick` action carefully: it executes before conditions, so a reset transition might observe already-modified registers. For reset priority, put assignments in ordered transitions as in the complete timer example.

## Hardware diagram

```json
{
  "nodes": [
    {
      "id": "inputs",
      "label": "Enable / Reset",
      "kind": "external",
      "signals": ["reset"]
    },
    { "id": "counter", "label": "16-bit counter", "registers": ["count"] }
  ],
  "edges": [{ "from": "inputs", "to": "counter" }]
}
```

Node `registers`/`signals` are references used to display live values. Nodes auto-layout in a grid. Optional integer `x`, `y`, `w`, `h` set diagram geometry (0–4096 for positions, 1–4096 for sizes). `kind: "config"` marks configuration; `"external"` marks an external resource. `note` supplies a short annotation. Active IDs in states/transitions highlight resources on the selected tick. Edges must connect existing nodes.

## Sources and evidence

```json
{
  "sources": [
    {
      "id": "manual",
      "title": "Device reference manual",
      "filename": "manual.pdf",
      "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS"
    }
  ],
  "evidence": [
    {
      "id": "reset-rule",
      "sourceId": "manual",
      "page": 17,
      "quote": "Exact short text from the referenced PDF page",
      "claim": "The documented rule this model relies on"
    }
  ],
  "assumptions": [
    "One model tick is an abstract peripheral step; no physical clock frequency is inferred."
  ]
}
```

Use the PDF's SHA-256 from its source bundle, not a URL or text-file hash. `page` is a **one-based PDF page**, not the page label printed inside the manual. Quotes must contain 8–1000 characters. Whitespace is normalized when checking a quote against that attached source page. Optional `url` can link to the official document; local bundled sources use `docs/references/<filename>.pdf`.

Missing source PDFs generate an unverified-evidence warning. When a matching PDF is attached, any incorrect page/quote rejects the model. A subsequently imported source also revalidates relevant models. A source bundle supplied to the CLI is trusted local input; verification does not fetch URLs or prove that someone else's exported text was authentic.

A verified quote is textual provenance, not verification of the circuit semantics. State the claim precisely, identify interpretation gaps, and declare assumptions. Do not cite a feature list as proof of detailed register behavior. The timer example deliberately separates the documented 16-bit timer feature from its assumed compare/toggle scenario.

## Acceptance cases

```json
{
  "checks": [
    {
      "name": "Reset clears state",
      "parameters": { "period": 3 },
      "ticks": 4,
      "inputs": [{ "tick": 4, "signal": "reset", "value": 1 }],
      "expect": { "reg.count": 0, "signal.out": 0, "state": "counting" }
    }
  ]
}
```

Each case runs independently with defaults plus its parameter overrides. `expect` compares final snapshot values by `state`, `reg.<id>`, or `signal.<id>`. It must contain at least one expectation. Cases require 1–10,000 ticks; unknown parameters, invalid stimulus, faults, or failed expectations reject import. Cases should reflect independently derived behavior, not merely mirror the implementation.

Validate and simulate from the terminal:

```sh
npm run model -- validate my-chip.model.json --sources manual.sources.json
npm run model -- simulate my-chip.model.json --params parameters.json --inputs events.json --ticks 100 --format csv --out trace.csv
```

## Optional source table

Automatically compiled binary logic models include `sourceTable` metadata with compiler ID `binary-function-table-v1`, PDF page/caption, input/output column labels, source rows (input `null` means explicit don't-care), exhaustive output matrix, and instantiated signal labels. This snapshot is displayed for review; executable behavior still resides in `states`. Editing the snapshot alone does not alter simulation rules. Its shape and declared-signal mapping are validated before rendering. See `FUNCTION_TABLES.md` for compilation and scope.

Sequential models use compiler ID `sequential-function-table-v1`. Their input rows can contain `rise`/`fall`, outputs can contain `hold`, and `clock` identifies the input/index and supported edge directions. `symbolRows` preserves original arrows, lowercase set-up symbols, and `no change`. The binary matrix is ordered by previous clock (0, 1), current input combination, then previous output combination; its dimension is `2^(inputs + outputs + 1)` and is capped at 64 entries. The snapshot does not change the executable states or certify source interpretation.

## Guided scenario creation

Press `c` with a PDF loaded in the TUI to configure a counter, FIFO, or shift-transfer model. The builder checks the cited page and exact excerpt, generates a schema-version-1 definition with explicit assumptions and demonstration inputs, and runs acceptance cases before saving. See `docs/TUI.md` for each scenario's rules. A suggested keyword or bit width is a review aid, not a proof of the modeled behavior.

## Limits and extensions

Limits are 32 parameters, 32 signals, 128 registers, 32 diagram nodes, 128 edges, 64 states, 32 transitions per state, 64 actions per action list, 32 sources, 256 evidence entries, and 64 acceptance cases. Browser model files are capped at 2 MiB. These limits keep imported behavior bounded and inspectable.

Version 1 does not implement memories, analog physics, electrical timing, instruction decoding, register-access side effects, concurrent state machines, or complete chips implicitly. Express a bounded scenario explicitly, or add a reviewed JavaScript model using the common interface for behavior the JSON language cannot represent. Keep assumptions visible and add targeted verification whenever expanding the engine.
