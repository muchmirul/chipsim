# CSV hardware workflow

`registers.csv` defines illustrative 32-bit register storage and explicit masks.
`stimulus.csv` writes/reads CONTROL and exercises STATUS write-one-to-clear.
These are developer-authored examples, not a vendor device.

```sh
chipsim table registers examples/csv/registers.csv --width 32 --priority after --name "Example CSR" --out tmp/csv-bank
chipsim --document tmp/csv-bank/source.csv --model tmp/csv-bank/session.json --inputs examples/csv/stimulus.csv
```

Use a new output directory. No PDF, Poppler or simulator is required. See
[CSV_INPUTS.md](../../docs/CSV_INPUTS.md) for formats, bounds, conversion, source
fingerprints and independent hardware-review limits.
