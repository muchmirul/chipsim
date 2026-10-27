# CSV register maps and stimulus tables

Use CSV exported from a spreadsheet, a hardware specification or your scripts.
These inputs need no PDF, Poppler or EDA installation. They describe explicit
developer-authored register experiments and model inputs. They do not infer a
device's behavior from names or generate synthesizable RTL.

## Create a register experiment

Save a UTF-8 `.csv` with all five named columns:

```csv
name,address,mode,reset,mask
CONTROL,0x00,rw,0x00000000,0x0000000F
STATUS,0x04,w1c,0x00000000,0x00000003
ID,0x08,ro,0x12345678,0x00000000
```

Choose a word width and whether synthetic hardware-set events occur before or
after bus accesses. Both choices must be explicit:

```sh
chipsim table registers examples/csv/registers.csv --width 32 --priority after --name "Example CSR" --out tmp/csv-bank
chipsim --document tmp/csv-bank/source.csv --model tmp/csv-bank/session.json
```

The command validates the table, runs generated acceptance cases and a
demonstration experiment, and writes `model.json`, `session.json`, `inputs.json`,
JSON/CSV/VCD traces, `sources.json`, the original bytes in `source.csv`, and
`result.json`. Stdout is one JSON result with artifact paths, checks and a `tui`
argument array. Existing output directories reject; validation failures create
no result directory. The model ID is prefixed with `csv-`. Use the register
menu (`u`), waveforms (`1`), words (`6`), stimulus (`7`) and ordinary exports.

The fingerprint covers exact CSV bytes. Source view displays the table as
**one logical CSV source page**, without claiming PDF pagination. Load
`source.csv` with the model/session to verify its source excerpt. Loading only
the model retains the ordinary missing-source warning. The CSV is an authored
specification, not independent vendor evidence. Changing source text requires
generating a new model into a new directory. Opening a CSV alone attaches source
text; it does not guess width, ordering or compile a model.

Tables contain 1–16 distinct words, each 1–32 bits wide, with unsigned 32-bit
addresses. Numeric fields accept decimal, `0x`, `0b` and `0o` notation. Modes
are `rw`, `ro`, `w1c`, `w1s` and `rc`. Masks and resets are mandatory and must
fit the width; read-only words require mask zero. Names and addresses must be
unique. See [REGISTER_BANKS.md](REGISTER_BANKS.md) for exact mask, request-token,
reset and synthetic `set_NAME` event semantics. Files are bounded to 64 KiB.
Existing PDF-backed register authoring also accepts CSV via `@path/map.csv`.
For guided authoring in the TUI, import the CSV with `d`, then press `c`.
The register builder starts with its row file selected; choose width/order and
review the source excerpt and assumptions before creating a new model.

## Apply a stimulus table

```csv
tick,signal,value
1,address,0x00
1,write_data,0x05
1,write,1
1,request,1
2,write,0
2,request,0
```

Use declared **input** identifiers. Values hold until changed. Ticks are
normalized model steps from 0 to 10000, rather than physical time or clock
cycles. Values must fit the input width. Outputs, unknown names, negative
numbers, fractions, formulas and X/Z are rejected.

```sh
chipsim --document tmp/csv-bank/source.csv --model tmp/csv-bank/session.json --inputs examples/csv/stimulus.csv
chipsim table stimulus examples/csv/stimulus.csv --model tmp/csv-bank/model.json --out tmp/csv-inputs
```

The first command runs the table in the terminal experiment. In an open TUI,
press `a`, choose the load action from Stimulus view, and enter a CSV path.
Replacement occurs only after validation and successful simulation; `U` undoes
it. Failure preserves the prior experiment. The second command validates
against model JSON or a built-in ID and writes `inputs.json`, a source copy and
a fingerprinted result, without running the model. It is a JSON bridge for
existing scripts. `--inputs` also accepts CSV in `agent run`, managed `model`
tasks and `npm run model -- simulate`; their existing source/PDF gates still
apply. To simulate an authored CSV bank headlessly with a different schedule:

```sh
npm run model -- simulate tmp/csv-bank/model.json --sources tmp/csv-bank/sources.json --inputs examples/csv/stimulus.csv --ticks 20 --out tmp/csv-trace.json
```

Stimulus files are bounded to 1 MiB and 10000 events. Rows sort stably by tick;
same-signal/same-tick rows retain file order, so the final row wins as with JSON
stimulus. A header-only table clears events. Events beyond the experiment
duration remain unexecuted. CSV trace **exports** have a different schema and
cannot be used as stimulus. These tables do not inject arbitrary nets into live
HDL; use [HDL environments](HDL_ENVIRONMENT.md) for native timing disturbances.

## CSV syntax

Headers are case-insensitive and may be reordered. Unknown, duplicate or missing
columns reject. LF/CRLF, an optional UTF-8 BOM, quoted fields, escaped double
quotes and blank lines are supported. Field-edge whitespace is trimmed. Every
field requires an explicit value; formulas are never evaluated. Register fields
must be single identifiers or numeric/access values. Export numbers as text if
your spreadsheet would round hexadecimal values or large integers. Parsing and
simulation stay local. Examples are illustrative rules, not vendor devices.
