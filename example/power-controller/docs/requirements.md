# Digital power-controller requirements

This original example controls the digital interface of an external power stage.
It does not contain an analog regulator, voltage/current sensing, or a MOSFET gate driver.
All control inputs are synchronous to `clk`; `rst_n` is an asynchronous active-low reset.
The Tiny Tapeout `ena` input independently inhibits operation.

The target is the pinned `tinytapeout-ihp-v1` / `ihp-sg13cmos5l` flow, one 1x1 tile,
with a 50 MHz clock. The clock period in the physical configuration is 20 ns.

| ID | Required observable behavior | Independent acceptance cases |
| --- | --- | --- |
| PWR-01 | Reset drives every output low. Unused bidirectional pins always have output-enable zero. | reset-and-idle, asynchronous-reset-dominates |
| PWR-02 | OFF ignores power-good and duty changes until both run_request and ena are high. | reset-and-idle, disabled-safe |
| PWR-03 | A sampled run request enters STARTUP and asserts power_enable; PWM and ready remain low for eight following clock edges. | minimum-startup-delay |
| PWR-04 | After the minimum delay, a sampled high power_good enters RUN. A late power_good is accepted without restarting the minimum-delay timer. | startup-waits-for-power-good |
| PWR-05 | If power_good remains low through the 256th startup clock, enter a latched FAULT and disable all drive signals. A high power_good on that exact clock wins over timeout. | startup-timeout-latches, power-good-at-timeout-boundary |
| PWR-06 | fault_in immediately inhibits drive combinationally and latches FAULT at the next rising clock, including while ena is low. | fault-inhibit-and-latch, enable-abort-and-independent-fault-capture |
| PWR-07 | FAULT persists after the source recovers, run is withdrawn, or ena changes. Clear only on a rising clock with run_request=0, fault_in=0, clear_fault=1; reset also clears it. | fault-clear-interlock, enable-abort-and-independent-fault-capture |
| PWR-08 | Loss of power_good in RUN inhibits PWM/power-enable immediately and latches FAULT on the next rising clock. | running-power-good-loss |
| PWR-09 | A PWM frame has 256 clock slots, starting at slot zero when ready first rises. Command N=0..15 produces N*16 consecutive high slots followed by low slots. | all-sixteen-duty-levels |
| PWR-10 | Latch duty_command at entry to RUN and only at subsequent frame boundaries. Mid-frame commands must not shorten or extend the current pulse. | duty-updates-only-at-frame-boundary |
| PWR-11 | Removing the request or ena inhibits drive immediately and returns nonfaulted operation to OFF on the next clock. Re-enabling repeats startup; it never resumes a partial PWM frame. | stop-and-restart, enable-abort-and-independent-fault-capture |

Timing is defined in sampled clock edges. At 50 MHz the minimum startup delay is
160 ns, the startup timeout is 5.12 us, and PWM repetition is 195.3125 kHz.
These digital example constants do not establish analog supply settling or power-stage stability.
The highest command is 93.75% duty; this interface deliberately has no 100% command.
`power_enable` stays asserted throughout valid STARTUP and RUN, even at zero PWM duty.
The fault-status output describes the sampled latch, so it rises on the capture edge,
while combinational drive inhibition may occur before that edge.

Acceptance is based on public output pins only. The same testbench must pass
against original RTL and the actual physical-flow netlist with the pinned PDK
cell models. Native timing, DRC, LVS and Tiny Tapeout precheck must separately pass.
Passing these checks is a local handoff result, not a manufacturer acceptance or
an analog, CDC, radiation, or whole-design formal proof.
