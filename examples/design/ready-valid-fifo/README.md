# Ready/valid FIFO: RTL through netlist verification

This original single-clock FIFO demonstrates five managed tasks: observer debug,
parameter-matrix regression, generic Yosys synthesis, generated-netlist simulation,
and EQY equivalence. They use existing adapters, bindings and required-check
policies. `design guide rtl` returns `recipe.verificationExample`; `agent help`
returns `examples.rtlVerification`. No PDF, PDK or provider is needed.

## Contract and independent checks

The FIFO has an active-high synchronous reset, which masks handshakes and clears
occupancy/pointers, leaving data memory uninitialized. Default WIDTH=8, DEPTH=4;
supported depths are powers of two at least two. There is no empty bypass.
Head data is meaningful only while out_valid is high and stays stable under
backpressure. At full, a dequeue permits an enqueue on the same edge. At empty,
simultaneous requests accept only the enqueue.

`tb/fifo_tb.sv` uses an independent shift-queue scoreboard, checks handshakes,
order and occupancy, and requires stalls, full replacement, empty requests and
reset while occupied. It uses a deterministic local PRNG and a watchdog.
The RTL matrix covers WIDTH/DEPTH = 1/2, 8/4, 16/8 with 2,048 random cycles each,
plus directed cases. The netlist has fixed default ports: NETLIST disables DUT
parameter overrides removed by synthesis, preserving the same scoreboard.

## Run and inspect

Copy to an unused destination outside the package:

```sh
cp -R examples/design/ready-valid-fifo ../fifo-work
chipsim design doctor --project ../fifo-work --target acceptance
chipsim design run --project ../fifo-work --target acceptance
chipsim job status JOB_ID --project ../fifo-work --wait --timeout-ms 1000
chipsim job logs JOB_ID --project ../fifo-work --offset 0 --limit 16384
chipsim checks --project ../fifo-work --target acceptance --run RUN_ID
chipsim --design ../fifo-work
```

Replace IDs with returned values. If the wait expires, poll the same job;
expiration does not cancel it. Acceptance requires all eleven checks. Individual
targets are debug, regression, synthesis and equivalence. Stock Icarus
(iverilog/vvp), Yosys and EQY must be on PATH. Debug additionally requires observer
tools advertising capture-scopes-v1 and capture-process-file-v1 in
`chipsim hdl doctor --debug`. Rebuild older
observers into a **new** prefix with `scripts/build-hdl-debug.sh`, then set
CHIPSIM_HDL_DEBUG_TOOLS to that prefix; see [debug setup](../../../docs/HDL_DEBUG.md).
Missing scope support fails setup rather than silently ignoring scope selection.

The debug manifest selects fifo_tb.main_case.genblk1.dut, keeping testbench
reference storage outside the observation budget. Recordings are labelled scoped.
All HDL assertions still execute, including those outside this observation scope;
their failures remain visible and fail the run. Scope selection changes observation,
never DUT execution or scoreboard expectations.

Managed logs expose task/stage/channel labels and fatal messages. Failed
job/task summaries include a diagnostic and artifact ID. Use `artifact inspect
ARTIFACT_ID --project ../fifo-work` for complete native output or a debug payload;
open the returned payloadPath with `chipsim --hdl-debug PAYLOAD_PATH`. Save with S.

## Synthesis and proof scope

Synthesis writes stat.json, netlist.json and netlist.v in its workspace.
Bindings deliver that actual generated netlist to simulation and EQY; no
preexisting netlist or manual output copying is required. Generic cell counts
are size proxies, without a physical area, timing or power claim.

EQY compares RTL with the bound default netlist. formal-wrapper.sv forces the
first sampled reset and masks invalid empty-queue output data. memory_map lowers
the small memory; group * keeps relationships among matched nets instead of
cutting them independently. SAT temporal induction has a maximum depth of 20.
PASS establishes this synthesis correspondence, not the FIFO specification,
other parameter values, liveness or physical behavior. Missing tools, unsupported
strategies or unproven results block acceptance.

## Negative control

In the copied directory:

```sh
python3 mutate.py apply
chipsim design run --project . --target debug
chipsim job status JOB_ID --project . --wait --timeout-ms 1000
chipsim job logs JOB_ID --project .
python3 mutate.py restore
chipsim design run --project . --target acceptance
```

The mutation increments occupancy on a simultaneous transfer and should fail at
cycle 13 with expected=4, actual=5. The helper changes only the DUT, keeps exact
original bytes in an exclusive backup, and refuses to overwrite that backup.
Restore preserves failed evidence and test expectations. Edits make affected
checks stale; exact restoration permits verified reuse. Use --no-reuse to execute
every task afresh.

## Lock script-launched tools

The portable starter has an empty dependency list, without machine-specific
paths. Executable hashes cover entrypoints. If a command is a shell/Python
launcher, explicitly lock the actual backend/support directories it consumes:

```sh
chipsim design lock --project . --path /absolute/backend/bin
chipsim design lock --project . --path /absolute/backend/lib/ivl
```

Copy each returned dependency into chipsim.lock.json.dependencies, optionally
adding `"tasks":["regress","netlist_sim"]`. Use actual installation directories
and returned hashes. Lock imported tool libraries where needed. Directory locks
reject dangling or escaping symlinks; choose a complete compatible directory.
Locks identify dependencies; tool binaries are not bundled with this example.
