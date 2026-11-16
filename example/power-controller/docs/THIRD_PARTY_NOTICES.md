# Third-party technology and flow notices

The original power-controller RTL, tests, requirements and helper script are
covered by this example's MIT LICENSE.

The generated layout uses the IHP SG13CMOS5L standard-cell technology from
IHP-Open-PDK revision `2bbec755dc67ca3db0261c3d6163e15735d66710`.
The standard-cell Verilog retains the upstream notice:

> Copyright 2024 IHP PDK Authors

The PDK's original Apache License 2.0 text is retained unchanged in
`licenses/IHP-Apache-2.0.txt`. Technology names, native output and flow metadata
remain those of their upstreams; the MIT license on the original controller does
not replace the technology's license.

The explicit ChipSim manufacturing profile captures the Tiny Tapeout support
revision, template revision, LibreLane image digest/version and PDK identity.
Those external tools are not vendored into this example's tracked source tree.
Their captured source/license records remain in the companion evidence bundle.
Tiny Tapeout and LibreLane integrations have their original Apache-2.0 terms.
