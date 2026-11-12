# Tiny Tapeout / LibreLane managed flow

The `tinytapeout` design adapter runs the official local Tiny Tapeout support
scripts and LibreLane flow, packages native submission files, then executes the
native precheck. It never uploads a submission. KLayout remains the external
physical viewer. Current support is explicitly `ihp-sg13cmos5l`; other processes
must use their own declared adapters until their flow is integrated and tested.

A project contains `info.yaml`, `src/` (RTL and explicit flow configuration), a
tracked public `tt/` support-tools checkout exported without Git internals, and
`flow-pins.json`. The latter records full 40-character `templateRevision`,
`supportRevision`, `pdkRevision`, immutable `image` digest, and `librelaneVersion`.
The physical task repeats these pins in `options`, together with:

```json
{
  "adapter": "tinytapeout",
  "timeoutMs": 1800000,
  "options": {
    "pdk": "ihp-sg13cmos5l",
    "pdkRoot": "/absolute/installed/pdk",
    "python": "/absolute/librelane-environment/bin/python",
    "precheckPython": "/absolute/precheck-environment/bin/python",
    "templateRevision": "PIN_FROM_REVIEWED_TEMPLATE",
    "supportRevision": "PIN_FROM_REVIEWED_SUPPORT_TOOLS",
    "pdkRevision": "PIN_FROM_REVIEWED_PDK",
    "image": "ghcr.io/librelane/librelane@sha256:REVIEWED_DIGEST",
    "librelaneVersion": "REVIEWED_VERSION"
  }
}
```

These placeholders are documentation, not a runnable configuration. The Python
environments need the official tool requirements, LibreLane and native precheck
dependencies. Docker must already be usable. ChipSim installs none of these
implicitly. Record the complete PDK directory inventory using `chipsim design
lock --project PROJECT --path PDK_ROOT` and add the returned dependency to
`chipsim.lock.json`, optionally scoped with `tasks: ["physical"]`.

All support-tool bytes, RTL/config and pins are captured in the execution
snapshot. PDK contents are verified against the lock before execution. The helper
checks installed LibreLane version and the PDK `SOURCES` revision and invokes the
container by digest. Pins identify reviewed origins; captured hashes identify
the actual project bytes, including intentional changes. They do not claim that
modified project configuration is byte-identical to the upstream template.

The helper calls official `Project.create_user_config`, `harden` and
`create_tt_submission`, followed by the official `tt/precheck/precheck.py` from its expected working
directory. A generated local executable forwards native KLayout calls into the
same pinned container, with project and read-only PDK mounts; a separate host
KLayout installation is not required for precheck.
A managed workspace has no Git repository: metadata methods are replaced only
to label provenance `chipsim:captured-inputs` / `chipsim-task:FINGERPRINT` and the
pinned support revision. The source directory is spelled relative to the managed workspace so yowasp
can read it within its filesystem mapping. This does not synthesize a Git commit
or modify the
hardware/flow algorithms. `scripts/tinytapeout-run.py` documents these overrides.

The adapter retains original metrics, resolved configuration, SDCs, GDS/OAS,
LEF, netlist, reports and precheck XML. Native non-finite metric values become
`null` in a separate hash-bound normalized report with an explicit `nonfinite`
list. Original bytes remain available. `timing` checks final setup/hold violation
counts across reported corners; `drc` checks KLayout's error count; `lvs` checks
the flow LVS error count. `precheck` parses actual xUnit cases and fails on native
failures; absent/skipped cases are inconclusive. Missing/disabled DRC does not
pass. Select required checks explicitly in the target policy:

```json
{
  "tasks": ["physical"],
  "requiredChecks": [
    "physical:outputs",
    "physical:timing",
    "physical:drc",
    "physical:lvs",
    "physical:precheck"
  ]
}
```

Timing scopes refer to captured constraints/corners, never protocol correctness.
The physical adapter does not choose clock periods, tile sizes or a competition
architecture. The public native acceptance fixture selects **1×1** solely for a
small counter/XOR test. It does not migrate any private 6×4 or 8×4 design.

## Native acceptance

`npm run test:tinytapeout` creates a disposable original design, exports public
support tools, inventories the PDK, starts a real managed physical job and
requires actual timing, DRC, LVS and precheck passes. Evidence is retained under
the printed temporary directory. It fails if tools are unavailable rather than
substituting archived reports.

Set these paths to reviewed local installations:

```sh
export CHIPSIM_TT_TEMPLATE=/path/to/ttihp-verilog-template
export CHIPSIM_TT_SUPPORT=/path/to/tt-support-tools
export CHIPSIM_TT_PDK_ROOT=/path/to/IHP-Open-PDK
export CHIPSIM_TT_PYTHON=/path/to/librelane-venv/bin/python
export CHIPSIM_TT_PRECHECK_PYTHON=/path/to/precheck-venv/bin/python
npm run test:tinytapeout
```

The runner's reviewed PDK revision is
`2bbec755dc67ca3db0261c3d6163e15735d66710`, LibreLane `3.1.0.dev3`, and image
`ghcr.io/librelane/librelane@sha256:d109140b8f17fc54f4fca998beb8124f4949404ec52e339eebd2250854a18b5a`.
Template/support commits are captured from the supplied checkouts. The runner
explicitly enables native KLayout DRC in its own fixture because the public
template disables that step. It preserves the chosen tile size and other
configuration. Container/PDK/runtime licenses remain those of their upstreams;
none are bundled by ChipSim.
