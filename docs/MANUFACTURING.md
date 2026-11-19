# Develop and deliver a digital chip through MCP

The first manufacturing profile is `tinytapeout-ihp-v1`, an explicitly pinned
Tiny Tapeout IHP digital flow. It passed the complete cold-cache MCP acceptance
workflow, including retrieval and extracted-archive precheck. The recorded
profile digest, runtime identity, run IDs, check IDs and archive hashes are in
[the native acceptance record](manufacturing-acceptance.json). New or changed
profiles remain `candidate` until matching native acceptance is recorded. Each
project must independently satisfy its release checks; manufacturer acceptance
remains external.

## Agent workflow

Read `chipsim_project` to verify the bound root and use `chipsim_workflow_status` to see outstanding evidence and its suggested action. Operation names below take a `chipsim_` prefix over MCP. Use the live schemas for arguments. When listed, `chipsim_environment_check` inspects the available tools and cache. Setup is a separate explicit action.

1. Read `manufacturing_profiles` and the selected profile's prerequisites.
   `environment_setup({profile, requestId})` explicitly downloads its pinned
   external tools, container and public PDK to a user cache. Read job status and
   logs; keep its successful run ID. Cached source trees are verified against
   pinned archives. Installed Python versions and wheel-file hashes are checked;
   incomplete or altered managed virtual environments are rebuilt from the locks. The host needs Linux x86-64, Node 22.13+,
   Python 3.11 or 3.12 with venv, and a working Docker engine. Set
   `CHIPSIM_MANUFACTURING_CACHE` before starting the MCP server to select its cache.
2. Capture the requested behavior, reset semantics, inputs/outputs, clock rate,
   tile size, independent acceptance expectations, author and license. Use
   `project_bootstrap` with the environment run, profile and explicit metadata.
   Existing project files are preserved. The initial testbench deliberately fails
   until the agent implements independently justified tests and hardware.
3. Edit requirements, RTL, `test/tb.sv`, `acceptance.json` and documentation using
   the normal CAS file tools. The testbench top is `tb`; it must assert expected
   hardware behavior and write `results.xml` containing exactly the nonempty
   named cases declared by `acceptance.json`. Emit a report only after each
   corresponding test executed. A simulator exit code alone cannot pass.
4. Run `simulation`, inspect failures/logs/waveforms, and repair the design while
   preserving the independent tests and declared constraints. Add project SBY/EQY
   tasks for requested proofs; all declared proof tasks must gate release.
5. Run `release` through `job_start`. Its captured task graph performs RTL tests,
   synthesis, physical hardening, native precheck and gate-level tests. The gate
   test uses the same testbench, the actual produced netlist and pinned PDK cell
   models. Native timing, DRC and LVS outcomes retain their limited scopes.
6. Query `release_status` for the selected run. Missing, skipped, stale,
   inconclusive, corrupted or failed mandatory evidence blocks packaging.
7. Start `release_package({run, requestId})`, then inspect its ordinary managed
   job and artifacts. Retrieve `submission.zip`, checksums, manifest and companion
   evidence using `artifact_read` in bounded byte chunks. Check each chunk hash
   and the complete archive hash after reassembly.

The package is a local deliverable validated against its pinned profile.
Submitting it to a shuttle, paying for fabrication and manufacturer acceptance
remain external actions. Native physical files can be viewed with KLayout;
ChipSim's interactive frontend remains the terminal.

## Verification and implementation

`npm run test:manufacturing` uses the official MCP client to start from an empty
project and, by default, an empty managed cache. It installs real pinned
prerequisites, demonstrates a failing independent test, repairs the RTL, hardens
an original counter/XOR design, checks the produced netlist and retrieves its
ZIP through MCP. It also cancels a concurrent setup, checks policy weakening and
declared-proof blockers, and reruns native precheck on the extracted archive.
It requires network access and substantial disk/time for the
container and PDK; missing host prerequisites fail acceptance. Artifacts and logs
are retained at the printed temporary project directory. An explicit
`CHIPSIM_MANUFACTURING_CACHE` selects a reusable cache instead of a cold install.

Fast regression cases in `test/manufacturing.test.js` cover discovery before
manifests, metadata bounds, binary reconstruction and tampering, exact test-case
coverage, source spelling, and pre-manifest durable request replay. A profile is described as supported only after this native suite establishes
its complete delivery workflow. Acceptance metadata changes do not alter the
execution contract or waive any project release checks.

Shared services live in `src/manufacturing/`. Setup and packaging build immutable
plans for the ordinary design worker. `tinytapeout-verify` executes the pinned
container's simulator and synthesizer and parses actual xUnit cases; the existing
`tinytapeout` adapter supplies physical layout/precheck evidence. No provider or
agent turns are started by ChipSim.

## Acceptance freshness and verification detail

Profile discovery compares the acceptance profile digest, runtime source hash,
platform and architecture. Mismatches expose reasons and report `candidate`;
candidate profiles remain executable for native validation. Node version remains
recorded provenance, subject to the installation's supported engine range.

`release_status.verification` preserves individual check scopes, assumptions,
reported contexts (including timing corners), test cases and evidence IDs.
Undeclared proofs are represented by an empty proof list. Analog behavior,
requirement completeness and manufacturer acceptance remain unverified.
Optional `acceptance.json.requirements` maps existing `engineering.requirements`
IDs to arrays of declared case names. Unknown IDs/cases reject release; unmapped
requirements are reported without inventing a completeness score or changing
legacy projects' minimum policy.

`npm run test:manufacturing:matrix` runs counter/XOR, power controller, four-entry
eight-bit FIFO and synchronous 8N1 UART transmitter fixtures. Every fixture runs
an intentional RTL defect against fixed tests, then actual RTL/gate tests,
physical checks, packaging and verified archive retrieval. Default execution
uses a new cache for the first design and shares it with subsequent designs.
`CHIPSIM_MANUFACTURING_CACHE` explicitly selects a warm cache. Retained
`acceptance-record.json` files identify actual runs; they do not automatically
promote a profile. Update native acceptance only after the final runtime passes.

The matrix also exercises source/policy/locked-dependency mutations during
packaging, a source edit after final checksum creation, cancellation while
packaging, and actual owned-container cleanup with an unrelated container kept
running. Test-only preload barriers make these boundaries deterministic and are
never loaded by ordinary product commands. `CHIPSIM_TEST_MANUFACTURING_RACES=1`
enables these scenarios for the single-counter `test:manufacturing` runner too.
The matrix additionally runs native bootstrap server-crash recovery in both
partial-install and lost-reply cases. Package freshness is checked again after
all archive and checksum work, immediately before returning the deliverable.

## Project evidence requirements

A target can opt in to `evidencePolicy`. Each entry refers to a declared engineering requirement. RTL and gate rules use the case names linked by `acceptance.json`. Formal rules name the task, proof kind and optionally a property from the executed model. A BMC rule may also require a minimum depth. Timing rules name a clock that must appear in the native clock and timed path-group reports across all recorded corners. Missing coverage stays unknown and blocks a requirement that needs it.

```json
{
  "evidencePolicy": [
    {"id":"COUNTER-WRAP","kind":"rtl"},
    {"id":"COUNTER-WRAP","kind":"gate"},
    {"id":"RESET","kind":"bmc","task":"resetProof","minDepth":16},
    {"id":"CLOCK","kind":"timing","clock":"clk"}
  ]
}
```

Supported kinds are `rtl`, `gate`, `bmc`, `prove`, `cover`, `equivalence` and `timing`. A project waiver is a nonempty `waiver` reason on a rule. Release status lists the rule, matching check or missing evidence, and any waiver. The pinned manufacturing profile always enforces its own minimum checks. Submission manifests include the captured and evaluated policy digests.
