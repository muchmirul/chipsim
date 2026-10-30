# Connected circuit examples

`swap.json` defines cross-connected register Q-to-D paths. `load-hold.json`
defines a complete one-bit table with explicit synchronous reset priority.
`counter-capture.json` combines modular arithmetic, a mux, capture of old counter
state and an output slice. JSON is authoritative for those flows; generated RTL
comes from the same representation.

```sh
chipsim circuit verify examples/connected-circuit/counter-capture.json --out /tmp/capture-check
chipsim circuit run examples/connected-circuit/counter-capture.json \
  --stimulus examples/connected-circuit/counter-capture.stimulus.json --out /tmp/capture-run
chipsim --circuit /tmp/capture-run/circuit.json
```

The separate `.sv` examples demonstrate **HDL-authoritative** import. They are
independent examples, not an assumption that handwritten JSON and RTL agree:

```sh
chipsim circuit import examples/connected-circuit/swap.sv --top swap --clock clk \
  --initial examples/connected-circuit/swap.initial.json \
  --yosys /path/to/existing/yosys --out /tmp/imported-swap
chipsim --circuit /tmp/imported-swap/connected/circuit.json
```

Import actually derives the connected representation from Yosys's lowered
connections and checks supported small domains against the original RTL with
Icarus. No source-name wiring inference or handwritten correspondence is used.
Use `counter_capture.sv`, top `counter_capture`, and its adjacent initial JSON
for the counter example.

These are binary synchronous digital examples, with explicit initial values
and testbench scheduling choices. They are not physical timing, transistor,
reachability or whole-chip proofs. No PDF, provider or tool installation is
required by the authoring/check flow. See the complete contract and limits in
[CONNECTED_CIRCUITS.md](../../docs/CONNECTED_CIRCUITS.md).
