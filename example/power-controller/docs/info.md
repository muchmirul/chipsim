# ChipSim digital power controller

This small digital chip generates PWM and supervises the power-good/fault interface
of an external power stage. It uses the standard Tiny Tapeout digital interface and
fits one IHP 1x1 tile. Its nominal clock is 50 MHz.

## Pin interface

| Port | Function |
| --- | --- |
| ui_in[0] | run_request: request startup and continued operation |
| ui_in[1] | power_good: external digital supply-good indication |
| ui_in[2] | fault_in: external fault; inhibits drive and sets the sampled latch |
| ui_in[3] | clear_fault: accepted only with run_request low and fault_in low |
| ui_in[7:4] | duty_command: unsigned N=0..15, duty=N/16 |
| uo_out[0] | pwm_out |
| uo_out[1] | power_enable, active during valid STARTUP and RUN |
| uo_out[2] | ready, active only in valid RUN |
| uo_out[3] | fault_latched |
| uo_out[7:4] | constant zero |
| uio_* | unused; output data and all output enables are zero |
| clk, rst_n, ena | Tiny Tapeout clock, asynchronous active-low reset, and enable |

## Operation

1. Assert reset and deassert run_request. Clear the external fault source.
2. Release reset, keep ena high, select duty, and assert run_request.
3. power_enable rises on the next sampled clock. ready/PWM remain low for at least
   eight additional clocks. Assert power_good from the external supervisor.
4. Once startup qualifies, ready rises and the first 256-slot PWM frame begins.
   Duty N produces N*16 high slots. Updates take effect at a frame boundary.
5. Withdrawing run_request or ena stops drive and restarts the startup sequence
   on the next request. Faults and power-good loss while running latch shutdown.
6. To recover from FAULT, set run_request=0, fault_in=0 and pulse clear_fault across
   a rising edge. Reassert run_request for a complete new startup.

If power_good is not sampled high by the 256th startup clock, the timeout latches
FAULT. The final allowed sample is accepted when high. At 50 MHz, the digital
startup delay/timeout are 160 ns/5.12 us and PWM frequency is 195.3125 kHz.
Duty settings span 0% through 93.75% in 6.25% steps.

All control inputs except reset must be synchronous. Analog regulation, sensing
and gate drive are external to this example. See requirements.md for exact
priority, timing, limits and test mapping. The original RTL/testbench are MIT;
the IHP standard-cell technology has its own retained Apache-2.0 notices.

## Bring-up test

After reset, outputs must all read zero. With power_good high, request a command
of eight: ready must rise after startup and PWM should be high for 128 of each
256 clock slots. Drop power_good or assert fault_in, confirm drive stops, and
confirm recovery requires the safe clear sequence. Leave unused bidirectional
pins undriven by this design.
