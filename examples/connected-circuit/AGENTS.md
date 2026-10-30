# Using the connected circuit starter

This directory is a copyable example project. Discover the active installation
with `chipsim agent help`; read `documentation["AGENT_CIRCUITS.md"]` and
`documentation["CONNECTED_CIRCUITS.md"]`. Those installed paths remain valid
after copying this directory; do not assume repository-relative docs exist in
the copied project. Follow any instructions in the user's parent project.

- Inspect the source and manifests before editing. `counter-capture.json` is
  authoritative for the managed targets. Its expected behavior is illustrative:
  modulo-4 increment when enabled, capture of old Count or explicitly selected
  external data, and synchronous reset priority. State/input initialization is
  a declared scenario, not a vendor power-on claim.
- `analyze` checks complete rules and wiring with Node only. `verify` adds real
  Icarus correspondence over all 1024 binary one-edge assignments. Inspect
  `design plan/doctor/status` for the chosen target before running; retain actual
  job/run/artifact IDs and required-check results.
- `.sv` files demonstrate a separate HDL-authoritative import path. They are
  independent examples; do not edit JSON and RTL in parallel and assume they
  agree. For existing RTL, use `circuit import` with an existing Yosys, explicit
  initial inputs and actual original-RTL correspondence results.
- Keep all accepted register updates on the same old-state snapshot. Express
  conditions, holds and numeric priorities explicitly. The clock starts at zero;
  initialization and a held high clock are not rising edges.
- Declare all paths/widths/selectors. Do not add a free internal write path,
  silently hold an unspecified case or convert X/Z/uninitialized state to zero.
  Async controls, multiple/gated clocks, latches, memories and unknowns are
  outside connected v1; report that boundary or use the native HDL workflow.
- Treat `complete-scoped-proof` as rule coverage/agreement only. Native
  correspondence is simulation-only; budget exhaustion/incomplete capture is
  inconclusive. Preserve independent reset, hold, wrap and same-edge capture
  expectations when adapting the example to the user's actual interface.
- Keep generated bundles, reports and captures as evidence. Edit the actual
  authoritative source and rebuild/re-import into a new directory after changes.
  Hashes establish identity, not physical accuracy or a security boundary.
- Use `--circuit` or verified `circuit-session` artifacts for inspection. Static
  rules, hypothetical probes and native observations are separate. Closing the
  TUI does not cancel a managed job; use the job cancellation command explicitly.

From the copied project directory:

```sh
chipsim design run --project . --target analyze
chipsim design run --project . --target verify
```

Run only the operations needed by the user's task with the installed tools.
This example does not install tools, register an agent host, configure a provider
or start a paid search. Report actual results and their scope, not just a score.
