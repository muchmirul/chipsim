# MCP reliability coverage

| Guarantee | Executable coverage |
| --- | --- |
| CAS conflicts and invalid drafts | workbench.test.js |
| Request replay after reconnect, simultaneous submission | workbench-mcp.test.js |
| Explicit cancellation, independent project/candidate roots | workbench-mcp.test.js |
| Worker termination, immutable retry, partial evidence | design.test.js |
| Corrupted records/payloads and stale sources | design.test.js, workbench.test.js |
| Binary chunks and archive integrity | manufacturing.test.js |
| Helper environment forwarding, durable journal replay, abrupt client death and lock conflicts | mcp-reliability.test.js |
| Runtime/host acceptance freshness and requirement references | mcp-reliability.test.js |
| Actual native assertion diagnostics, policy/proof blockers, packaging | manufacturing-mcp.test.js |
| Independent control, storage and serial designs | test:manufacturing:matrix |

Tests use disposable roots. Native acceptance requires real prerequisites;
missing tools cannot be counted as passing native validation. The existing
source-free suite does not establish the full physical acceptance matrix.

The [native reliability acceptance record](manufacturing-reliability-acceptance.json)
contains the four design runs, negative controls, archive identities and real helper
interruption/corruption checks for the recorded runtime. The prior profile acceptance
is retained under `manufacturing-history/2026-11-15.json`.
