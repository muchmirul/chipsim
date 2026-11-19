# MCP reliability coverage

For recovery instructions on the running server, start with `chipsim_project`, `tools/list` and [workbench MCP](WORKBENCH_MCP.md). Test records below describe their captured runtime and tool inventory.

| Guarantee | Executable coverage |
| --- | --- |
| Retryable pending vs invalid digest, measured vs diagnostic reports, scoped proof artifacts and corruption | benchmark-proof.test.js (`CHIPSIM_TEST_BENCHMARK=1`) |
| Selected target readiness vs captured requirement evidence and waivers | requirement-coverage.test.js |
| Hold-at-maximum and enabled wrap on the counter waveform | evolution.test.js |
| CAS conflicts and invalid drafts | workbench.test.js |
| Request replay after reconnect, simultaneous submission | workbench-mcp.test.js |
| Explicit cancellation, independent project/candidate roots | workbench-mcp.test.js |
| Worker termination, immutable retry, partial evidence | design.test.js |
| Concurrent retries; queued/running cancellation; crashes before/after run publication; live source/policy/dependency edits; stale mutation locks; bounded responses | job-recovery-matrix.test.js |
| Interrupted/partial download resume; corrupted chunks/prefixes/identities/cursors; destination races and symlinks | workflow-download.test.js |
| Partial bootstrap and lost reply after actual server death | workflow-native.test.js (native opt-in) |
| Packaging source/policy/dependency edits, late source edits, packaging cancellation and actual owned/unrelated containers | manufacturing-mcp.test.js with CHIPSIM_TEST_MANUFACTURING_RACES=1 |
| Corrupted records/payloads and stale sources | design.test.js, workbench.test.js |
| Binary chunks and archive integrity | manufacturing.test.js |
| Helper environment forwarding, durable journal replay, abrupt client death and lock conflicts | mcp-reliability.test.js |
| Runtime/host acceptance freshness and requirement references | mcp-reliability.test.js |
| Actual native assertion diagnostics, policy/proof blockers, packaging | manufacturing-mcp.test.js |
| Independent control, storage and serial designs | test:manufacturing:matrix |
| Frozen benchmark inputs, native artifact retrieval, deduplicated request IDs and cancel cleanup | `CHIPSIM_TEST_BENCHMARK=1 node --test test/benchmark-mcp.test.js` |
| Generic SDK and ordinary Pi reconnect, measured rejection, lost evaluator reply recovery and fresh counter/ALU finalists | Pi Durable checkout's `test:chipsim-benchmark`, with a packaged or source ChipSim installation and real EDA tools |

Tests use disposable roots. Native acceptance requires real prerequisites;
missing tools cannot be counted as passing native validation. The existing
source-free suite does not establish the full physical acceptance matrix.

The [native reliability acceptance record](manufacturing-reliability-acceptance.json)
contains the four design runs, negative controls, archive identities and real helper
interruption/corruption checks for the recorded runtime. The prior profile acceptance
is retained under `manufacturing-history/2026-11-15.json`.

## Completion audit for the reliability plan

| Plan requirement | Implementation and proving check |
| --- | --- |
| Native failure plus independent report validity | `verificationFailure` and `verificationChecks`; explicit failed-case attribution, unfinished XML, duplicates, missing cases and contradictory counts in manufacturing/client tests |
| Current-task diagnostics, bounded excerpts and evidence links | Verification adapter records native failure details; ordinary task and packaging failures receive the same category/stage/exit-status fields; job publication attaches the immutable execution artifact; native negative controls inspect the emitted diagnostics |
| Discovery without execution or mutation | `workflow_status` and read-only project summaries; empty/invalid/active/failed/candidate tests plus native bootstrap recovery checks |
| Preparation/run/delivery/resume through official SDK | `extensions/mcp/workflow.mjs`; durable-request replay, environment forwarding and actual native reproduction |
| Lost response and partial bootstrap recovery | Optional bootstrap request receipt records the file inventory before installation; fast conflict/replay tests and two real server-death scenarios |
| Journal request/job IDs, log cursors and download progress | Client tests assert stable IDs, byte cursors and bounded/truncated log tails across replay; transport tests inspect per-chunk verified-byte progress |
| Interrupted/corrupt downloads and existing destinations | Shared retrieval routine is exercised by automated prefix/chunk/identity/cursor/conflict/symlink tests and real native delivery |
| Verification scope, cases, corners, constraints, proofs and requirements | `release_status.verification` includes captured check context and requirement mapping; native acceptance records retain check IDs and scope |
| Runtime/profile acceptance freshness | Profile discovery matches source hash, profile digest and host; unit tests reject mismatches and final native records identify their runtime |
| Concurrent request replay and retry | Official SDK simultaneous-submission tests plus one-generation retry test |
| Worker death around publication | Test-only preload kills workers immediately before and after run-record publication; immutable retry is verified |
| Queued/running/packaging cancellation | Fast lifecycle tests and real controlled packaging cancellation |
| Owned process and daemon-container cleanup | Fast process tests preserve an unrelated process; native cancellation waits for a real labeled simulator container and preserves an unrelated container |
| Source/policy/dependency edits during execution and packaging | Fast execution barriers and native package barriers, including a late edit after checksum creation |
| Corrupt records/payloads/manifests, partial bootstrap, stale locks and bounds | Existing evidence/archive tests, new bootstrap replay tests, non-stealing lock test and oversized-response recovery test |
| Counter, power controller, FIFO and UART | Four native fixtures retain fixed public-pin tests, intentional failing mutations, required release gates and extracted-archive prechecks |
| Compatibility and distribution | Existing JSON evidence remains readable; no-ID bootstrap remains create-only; installed-package and official MCP checks cover shared tool discovery |

The native portions of this audit require the matrix runner. A source-free pass
alone is insufficient. Acceptance records preserve the exact runtime, fixture
hashes, run/check IDs and archive identities rather than treating this table as
proof by itself.

## Reproducing the November 19 audit fixes

| Question | Regression |
| --- | --- |
| Can an earlier green run authorize a changed release? | `test/design.test.js` changes task membership and dependencies. `test/manufacturing-mcp.test.js` adds a failing task to an already-green native target, checks readiness and attempts to package it. |
| Can a policy change reuse verified evidence? | `test/reliability.test.js` checks proof type, depth, property, named pin cases and clock coverage. A package records the captured and current graph and policy identities. |
| Can two agents review and exchange work? | `test/workbench-mcp.test.js` uses two stdio clients to recover candidates, read selected resources, inspect diffs and detect an apply conflict. The native counter test uploads the evidence ZIP to another project, reconnects during transfer and verifies the original run there. |
| Do checkout and installed clients agree? | `npm run test:mcp:installed` compares runtime identities and tool schemas, retries a checkout snapshot from the package and changes an adapter to verify invalidation. |
| Does an uninterrupted transfer recheck the entire archive for every page? | `test/reliability.test.js` counts closure reads over 128 pages and changes a backing block during a transfer. `test/workflow-download.test.js` covers interrupted downloads and destination verification. |
| Does a passing result exercise the intended behavior? | The native XOR bench rejects constant-high, OR and disconnected-bit designs. The PicoRV32 RTL and Renode targets independently reject incorrect firmware writes. Native formal checks report the SBY mode, bound, properties and trace inventory. |

The [original audit](reviews/2026-11-19-agent-chipmaking.md) describes the reproductions on the earlier revision. The [release qualification procedure](DEVELOPMENT.md#qualification-lanes) lists the source and native commands.

## Qualification on 19 November 2026

The equipped Linux x86-64 runner qualified runtime `1d68064e60719e5271153ea5b0aed1c6c529ec68793da75a75616e15a47f793e` for the local Tiny Tapeout IHP profile. All four corrected designs passed the 11 required checks. Each deliberately incorrect design failed RTL simulation, and each extracted submission passed 10 native archive prechecks.

| Fixture | RTL / gate cases | Submission SHA-256 |
| --- | ---: | --- |
| counter | 5 / 5 | `b3deceb377b35130adceaab8d8e04391ab824f6d95a97fafe32b68d2132ea23e` |
| power | 14 / 14 | `a2718ed444a572aa153e7e9acffd1d62e34f7d6b483027853f34d6e2de9a5c41` |
| fifo | 1 / 1 | `57cc90682faa639de7271ac47596ff78f6e60ca234ce2a1b959e704cb7535667` |
| uart | 1 / 1 | `13c4edbe7f5ee8d687ca37eb7594604a7e8a9fb3be6114e0555dab69266d530a` |

The counter passed all 65,536 input byte pairs at RTL and gate level. The final STA reports identify the clock and a timed path group at each of three corners. They omit an unconstrained-endpoint count, which ChipSim reports as unknown. A policy requiring the observed clock passed and allowed repackaging. Requiring an absent clock blocked readiness.

The source suite passed 263 tests and skipped 164. The overlapping source-backed suite verified 34 private reference fingerprints, passed 371 tests and skipped 56. The official SDK passed five lifecycle tests, and the installed Prime client exercised 40 tools. The SKY130 failure control correctly blocked readiness on LVS.

The [qualification record](manufacturing-reliability-acceptance.json) contains run IDs, archive identities, timing, packaging races, receiving-project import and the SDK delivery receipt. The [previous profile record](manufacturing-history/8764fa98-profile.json) and its [reliability evidence](manufacturing-history/8764fa98-reliability.json) preserve the earlier runtime.
