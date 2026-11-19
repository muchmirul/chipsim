# MCP reliability coverage

For recovery instructions on the running server, start with `chipsim_project`, `tools/list` and [workbench MCP](WORKBENCH_MCP.md). Test records below describe their captured runtime and tool inventory.

| Guarantee | Executable coverage |
| --- | --- |
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
