# Digital environment experiments

These are illustrative timing experiments, not ASIC candidates or measured
hardware profiles. ChipSim generates stimulus inside the actual HDL run. It
does not move the waveform afterward.

```sh
chipsim hdl run examples/hdl/environment/baseline.project.json --out tmp/env-baseline
chipsim hdl run examples/hdl/environment/delay.project.json --out tmp/env-delay
chipsim hdl run examples/hdl/environment/compensated.project.json --out tmp/env-compensated
chipsim --hdl-debug tmp/env-compensated/debug.json --view debug
```

Use a NEW output directory every time. Default debug requires the observer
tools. `--no-debug` produces ordinary VCD with stock Icarus. The same manifests
can be launched from the terminal's **H** run menu.

Watch `env.nominal`, `env.disturbed`, `target`, `sampled`, `checked` and
`target_met`. Each path has a declared source command, then an environment
arrival. The consumer samples the disturbed level at the 20 MHz clock.

- **baseline**: command at 150 ns, delay 0; arrives at target 150 ns.
- **delay**: command at 150 ns, delay 80 ns; arrives late at 230 ns.
- **compensated**: explicitly move the known command to 70 ns; the same 80 ns
  delay gives arrival at 150 ns. This schedule is entered in the example, not
  produced by an implemented program compiler/calibration algorithm.
- **jitter**: command at 85 ns, delay 65 ns with seeded jitter +/-15 ns. The
  arrival is one reproducible draw in 135..165 ns, not guaranteed at 150 ns.
- **glitch**: XOR inversion from 165 ns inclusive to 185 ns exclusive makes the
  175 ns consumer sample low, despite the nominal high level.
- **missed-target**: the delay scenario with an assertion requiring high at
  150 ns. The run is expected to FAIL and retain its partial traces and profile.

The delayed falling edge at 330 ns lies beyond this short run, which ends at
276 ns. The report retains the complete declared schedule, not a claim that all
reported edges were simulated. The example's single `target_met` check inspects
the level 1 ns after target;
it is not an exact transition-time, setup/hold or protocol timing checker. Read
`environment.json` for exact emitted edge times. Source commands and environment
parameters are both external fixture data; the consumer has no access to the
noise seed or delay settings. There is no automatic controller calibration or
costed control-table hardware here.

Environment times are ns in these profiles, not DUT cycles. Initial clock is 0;
all useful disturbed edges avoid clock edges in the deterministic examples.
Coincident HDL events follow native scheduling, not analog setup/hold rules.
Jitter can create a selected coincidence; it does not simulate metastability.

Edit an inline manifest profile and run anew to vary seed/delay/offset/glitches.
See [HDL_ENVIRONMENT.md](../../../docs/HDL_ENVIRONMENT.md) for the complete schema,
limits, packed-channel wiring and reproducibility contract. No clock drift,
analog voltage noise, PVT qualification, independent physical calibration,
general live-net delay wrapper or exhaustive random proof is supplied.
