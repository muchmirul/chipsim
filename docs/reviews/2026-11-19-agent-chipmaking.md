# ChipSim reliability and MCP chipmaking audit

Reviewed `b0e8dfb46f88faa04364d4c2bbf1046643ed83bd` on Linux x64, Node 22.23.2, on 19 November 2026. The audit used disposable projects, the checkout's stdio server and independent checks against native tool output.

**Decision.** ChipSim can carry an agent from an empty directory through a verified digital submission archive. Fix the release gate first. After I added a task that always exits with a failure to the release target, ChipSim still packaged the earlier run. Next, make candidate selection consistent and strengthen the behavioral tests behind release claims.

## What was exercised

| Entry point | Result on this commit |
| --- | --- |
| Source and reference suites | `npm run verify` passed 253 of 414, with 161 skipped. An isolated checkout with all 34 private reference originals fingerprinted passed 361 of 414, with 53 skipped. Both included their terminal smoke tests. The suites overlap. |
| MCP clients and install | The official stdio SDK passed all three lifecycle tests, including failure, repair and reconnect. The optional benchmark suite passed both service tests. The install smoke test passed. An offline-installed npm tarball exposed the same 35 input schemas. The installed Prime 0.10.0 client verified isolation, write conflicts, job replay and binary retrieval through MCP. |
| HDL, circuit and formal | The native HDL suite passed 14 and skipped two. The debug suite passed 40 of 40 plus its terminal smoke with a compatible observer. Four tests failed with the host's default observer. The opt-in circuit, evolution and ALU suite passed 42 and gated five. All five passed when rerun with the required observer, Yosys and Z3. |
| Digital EDA and firmware | After equipping the host with the optional tools, the stock digital acceptance command failed on PicoRV32 debug capture. A waveform-only rerun passed the RTL MMIO assertions. Changing the firmware exposed a separate false pass in the Renode target. |
| Physical failure control | The SKY130 ORFS/OpenROAD-MCP example passed timing and DRC, failed LVS and returned `ready:false`. The integration test passed because it correctly reported the physical failure. The LVS comparison reported 17 circuits and 1,193 mismatch entries. |
| Agent delivery and independent receipt | A native IHP counter passed all 11 required checks. The SDK delivery helper downloaded the submission, evidence bundle, manifest, validation XML and checksums. Both archive digests, ZIP integrity, all 22 manifest member digests and the 10 archive precheck cases verified. The CLI imported 931 records into a second initialized project and verified the original release run there. |

## Native manufacturing results

Each fixture started from an empty project through the official stdio SDK. All four deliberately wrong designs failed simulation. Each corrected design passed all 11 required release checks and produced a submission ZIP with a GDS. Independent reads verified each ZIP and every member digest declared in its manifest. The FIFO and UART benches group several pin-level assertions into one named case each.

| Design | Named RTL / gate cases | Physical precheck cases | Worst setup / hold slack (ns) | Submission SHA-256 prefix |
| --- | ---: | ---: | ---: | --- |
| Counter | 5 / 5 | 10 | 11.244 / 0.155 | `cbe43dff623a` |
| Power controller | 14 / 14 | 10 | 10.115 / 0.116 | `9093ec75275c` |
| FIFO | 1 / 1 | 10 | 12.831 / 0.127 | `aca023126f8a` |
| UART | 1 / 1 | 10 | 13.567 / 0.172 | `dd63b2440844` |

The first sequential matrix command used a fresh ChipSim cache and stopped at power setup on a registry DNS error after the counter passed. The unchanged power, FIFO, UART and bootstrap recovery tests completed separately against that cache after DNS recovered. The host already had the pinned Docker image. The counter rejected source, policy and dependency edits during packaging, including a late source edit, and cancellation preserved an unrelated container. Both bootstrap server-loss cases preserved the original cache and user edits after the harness confirmed the lock owner was dead and cleared its lock. [Matrix entry point](../../scripts/test-manufacturing-matrix.mjs) · [Native recovery cases](../../test/workflow-native.test.js)

## Findings to fix first

### A changed target can inherit a green readiness result

A one-task target passed. I appended an independent verification task to its task list and kept the original required check. The current plan listed both tasks. `checks` still returned `ready:true`. Executing that exact new target returned `failed`, `ready:false`. On an isolated copy of the native IHP counter release, I added the same kind of independent task, configured to exit 1, to the release target. `release_status` still returned `ready:true`, 11 passing checks and zero blockers for the earlier release. `release_package` completed with `ready:true` without executing the added task. Its retrieved 146,996-byte submission ZIP matched the earlier archive byte for byte by SHA-256. Freshness iterates the captured task list and the final decision considers the old execution plus the current named checks. [Target freshness](../../src/design/service.js)

**Acceptance test.** Compare the current task graph with the captured graph, including added tasks and changed dependencies. Keep historical verdicts inspectable. Return a machine-readable reason for current staleness. Regress addition of an independent task, a changed dependency, and a policy-only check change through `checks`, `release_status` and `release_package`. Block publication until the current target has passed.

### Two accepted candidate-scoped calls silently use the base project

Through the official SDK, `file_read` returned the edited candidate. `resource_read` with that same candidate argument but a plain project URI returned base text. The URI emitted by the candidate file read returned the correct text. A second `candidate_create` with the first candidate as its source also copied the base text. [Dispatch](../../src/workbench/service.js) · [Tool schemas](../../src/workbench/schema.js)

**Acceptance test.** Resolve the effective candidate once. Reject conflicting URI and argument selectors. Clone the selected candidate or reject that argument explicitly. Test two distinct root/candidate file hashes, nested candidate creation, and both resource access forms over stdio.

### The manufacturing counter fixture accepts a broken XOR output

Each of its 256 vectors pairs a byte with its complement, so every expected XOR result is `0xff`. Icarus ran the checked-in testbench against a design whose XOR output was tied high. It emitted all five passing cases. One extra zero/zero vector failed the altered design and passed the original. [Fixture](../../test/fixtures/manufacturing.mjs)

**Acceptance test.** Exercise zero, equal, complementary and independent operands, or exhaust all 65,536 byte pairs. Run the fixed bench against correct RTL and constant, OR and disconnected-bit variants. Use independently varied inputs at RTL and against the delivered netlist. Track which fault each test detects.

### The checkout and its own npm distribution have different runtime identities

The checkout reported `7b41ad75…` and the freshly packed and installed version reported `a392eb36…`. I compared every inventoried path and digest. The only difference was `extensions/.npmignore`, present only in the checkout. The 35 tool schemas matched. Since profile support and snapshot retry use runtime identity, a checkout acceptance record cannot match that package build. [Runtime inventory](../../src/design/project.js) · [Profile support](../../src/manufacturing/profiles.js)

**Acceptance test.** Compute a canonical inventory of execution-relevant shipped files, or produce and verify a build manifest in both forms. From one commit, compare installed and checkout identity, retry a captured fixture through the installed executable, and verify that a genuine change to an adapter invalidates it.

### The supplied Renode software target accepts the wrong MMIO values

I changed the firmware's first write from `0x1234` to `0x5555`. The RTL test failed its assertion. The software target returned `completed`, `ready:true` with no diagnostic, even though the monitor printed `0x5555` and `0x5556` and logged a CPU abort after execution. Its only software-side requirement is process success. [Target policy](../../examples/design/soc/chipsim.design.json) · [Renode script](../../examples/design/soc/run.resc)

**Acceptance test.** Add an explicit firmware completion condition and a machine-checked independent readback of both words. Keep process success available as a separate check. The altered image must fail both behavioral tests, with the observed values available in the result.

## Additional reproduced issues

### The formal verdict omits the proof mode and bound

For a four-bit counter with an assertion that fails at seven, real SymbiYosys and Z3 returned a bounded pass at depth 4 and a counterexample at depth 12. ChipSim correctly returned `pass` then `fail`. The first structured check said only `formal` with generic scope. A client must inspect the captured configuration to distinguish that bounded result from induction. [Formal adapter](../../src/design/adapters.js) · [Release proof inventory](../../src/manufacturing/release.js)

**Acceptance test.** Report mode, depth, engine and property scope with the verdict. Allow a requirement to request a specific proof kind. Show the depth-4 result as bounded and link the depth-12 counterexample. A cover or bounded run must only satisfy matching requirements.

### The shipped digital EDA acceptance command fails on the PicoRV32 fixture with an equipped host

After source generation, Verilator, cocotb, formal and equivalence had passed, the firmware ran to its normal `$finish`. Default debug capture then hit its 512-signal limit at signal 513. The fixture only declares a waveform output. On a disposable copy, selecting waveform-only execution passed the RTL MMIO assertions. The independent Renode target also completed. [SoC target](../../examples/design/soc/chipsim.design.json) · [Native acceptance command](../../scripts/test-eda.mjs)

**Acceptance test.** Select the capture mode the fixture actually requires, or specify a scope that fits the observer budget. Keep the full debug limit and keep the MMIO assertions. Run the shipped `test:eda -- --digital` command end to end with all prerequisites in CI.

### An agent can follow valid guidance indefinitely

A successful simulation-only project returned stage `release` and suggested a fresh simulation despite having no release target. With a malformed lock and a valid design manifest, the repair action opened the valid design manifest. [Workflow selection](../../src/workbench/workflow.js)

**Acceptance test.** Report a terminal verified state for completed non-manufacturing targets. Return the offending path in a parse diagnostic. Exercise simulation-only, multiple-target, invalid-lock, invalid-design and partially bootstrapped projects by following the suggested actions to a terminal state.

### Directional queries omit one side of bidirectional hardware

A real Yosys netlist for a driven and sampled `inout` pin identified the port correctly. Its ChipSim fan-in was empty. Fan-out contained a single edge labeled bidirectional. The graph query tests only the stored endpoint direction. [Netlist graph and queries](../../src/workbench/inspect.js)

**Acceptance test.** Include bidirectional connections in either direction and preserve pin and bit identity. Distinguish aliases, unresolved directions and physical drivers. Compare both queries against Yosys output for input, output, tri-state and bidirectional cell/port examples.

### Valid XML can turn a passing test into missing evidence

A report containing the properly escaped case name `read &amp; clear` returned `inconclusive` for the declared name `read & clear`. The captured case kept the literal entity text. [xUnit reader](../../src/design/xunit.js) · [Manufacturing case matching](../../src/manufacturing/verify.js)

**Acceptance test.** Decode predefined and numeric XML references and retain the current input bounds and rejection of external entities. Cover case names, messages, malformed entities, duplicate names and incomplete reports at the release-check boundary.

### Artifact transfer repeatedly hashes the complete payload

Instrumentation around the existing verification method counted 128 full verifications, exactly 1 GiB of payload hashing, to transfer one 8 MiB artifact in 128 calls. The reconstructed digest matched. This excludes any hashing of referenced inputs, and follows directly from each chunk calling full evidence verification. [Server](../../src/workbench/service.js) · [Evidence verification](../../src/design/evidence.js) · [Download helper](../../extensions/mcp/workflow.mjs)

**Acceptance test.** Publish authenticated per-chunk hashes, or use a bounded verified transfer session with an immutable read handle and explicit invalidation. Verify the assembled hash at the client. Stream resumed prefixes. Add a transfer-size scaling test alongside the existing interrupted, modified and conflicting download tests.

### A tools-only agent cannot retrieve the starting RTL using the built-in benchmark's returned path

Preparing the built-in counter in an empty project succeeded, returned `counter.sv`, and a project file read returned `ENOENT`. The response contains a context, fixed hashes and path. The benchmark captures the installed source, while the advertised path is relative to the project. [Benchmark preparation](../../src/benchmark/service.js) · [Registered resources](../../src/workbench/service.js)

**Acceptance test.** Return a read-only resource for the captured starting candidate with its digest, or an explicit materialization operation. Test a baseline run from an empty project using only the tool results, including obtaining its text and hash.

### Setup requires registry DNS even when the pinned image is installed

The four-design matrix completed the counter, then failed at the start of the power fixture. Both setup workers failed to resolve GHCR during an unconditional `docker pull`. The test reported a secondary cancellation assertion. Immediately afterward, Docker could inspect the exact digest locally. A later pull succeeded and reported that the image was up to date. [Pinned setup](../../scripts/manufacturing-setup.py) · [Setup and cancellation test](../../test/manufacturing-mcp.test.js)

**Acceptance test.** Resolve the pinned digest from the local Docker store first and verify its platform and identity. Pull by digest if absent. Exercise cold, warm and unavailable-registry setup while preserving archive, PDK and Python lock verification. If setup fails before a cancellation test reaches its barrier, surface the setup diagnostic.

## Improvements to the agent contract

1. **Expose the evidence behind a decision.** Return current plan identity, captured plan identity, readiness reason and relevant task/check IDs in a small typed result. Give each frequently used tool a result schema for its actual payload. The current 35 tools share an envelope whose success payload is an arbitrary object. Keep detailed logs, waveforms and native reports separately pageable. [Workbench schemas](../../src/workbench/schema.js)
2. **Make requirements testable at delivery.** The existing requirement-to-case mapping is optional and already reports unmapped IDs. Support a project policy that identifies mandatory requirements, their acceptance cases, and the evidence kind required for each. An agent should be able to tell whether a requirement has an RTL test, a gate-level test, a bounded check, an unbounded proof or an explicit waiver. Include the failing requirement and case in the release decision. [Requirement coverage](../../src/manufacturing/coverage.js) · [Release checks](../../src/manufacturing/release.js)
3. **Make recovery and prerequisites discoverable.** Surface missing binaries, observer capabilities, the failing file, and whether to edit inputs, resume a request or retry its captured snapshot. Offer a read-only environment check before an expensive job. Distinguish installed adapters from available toolchains on this host. The four initial HDL debug failures disappeared when I selected the installed observer build with the required capabilities. [HDL tool discovery](../../src/hdl/debug/tools.js) · [MCP workflow](../../docs/WORKBENCH_MCP.md)
4. **Keep separate automated gates for the source suite, installed stdio server and native manufacturing.** Run the SDK repair/reconnect tests on changes to the workbench. Run bounded native simulation/synthesis/formal tests on changes to adapters or verdicts. Run the four-design matrix for release promotion, with physical reports, failing controls, cold setup, archived evidence and the exact runtime identity. Publish the command, skips and prerequisites for each lane. The checkout's default verification and install tests can both pass without running the full manufacturing flow. [Verify runner](../../scripts/verify.mjs) · [SDK suite](../../test/workbench-mcp.test.js) · [Manufacturing matrix](../../scripts/test-manufacturing-matrix.mjs)
5. **Close the handoff between agents.** Make isolated candidates listable and recoverable by durable ID or request ID after a lost reply. Let the agent export a candidate diff with its base revision, then apply it with a compare-and-swap check. Add an MCP import or restore path for evidence bundles so a second project can verify a delivery using the same transport. The current workbench exports evidence and the CLI imports it. [Candidate operations](../../src/workbench/files.js) · [MCP inventory](../../src/workbench/schema.js) · [Evidence import](../../src/design/evidence.js)
6. **Expose physical coverage alongside passing counters.** For the counter, the native report identified three timing corners, 11.244 ns of worst setup slack and 0.155 ns of worst hold slack. Report the clocks, exceptions and unconstrained endpoints where the backend provides them. If coverage data is absent, mark it unknown. Allow a project to require coverage for specified clock domains. [Tiny Tapeout timing checks](../../src/design/tinytapeout.js)

## How to use the current build

After changing a target's tasks or dependencies, validate the current plan and start a fresh target run with `reuse:false`. Inspect that run's job and check records before calling `release_package`. For a candidate, use `file_read` with its ID or follow the candidate-specific resource URI it returns. For a new digital design, include a deliberately wrong implementation that the behavioral tests must reject before relying on those tests as release evidence.

The native evidence here covers local digital designs and the pinned Tiny Tapeout IHP profile. The separate SKY130 run exercises the handling of an LVS failure. Manufacturer submission, silicon measurements, analog or mixed-signal sign-off and qualification of additional processes are outside this audit. The external-agent compatibility result is specific to the installed Prime client and its isolated configuration harness. Hosted model performance remains unmeasured. Profile discovery reported this runtime as `candidate` against the checked-in acceptance metadata.

## Reproducing the audit

From the repository root, these commands cover the source, SDK transport, digital EDA and native release paths. The optional EDA and manufacturing suites need their documented native tools. The source-backed verification command additionally needs the privately held, fingerprinted reference files.

```sh
npm run verify
npm run test:mcp
npm run test:install
npm run test:hdl
npm run test:eda -- --digital
npm run test:physical -- --mcp
npm run test:manufacturing:matrix
```

On the audited host, `~/chipsim-audits/2026-11-19-b0e8dfb/` contains the commands and standalone probe scripts, their output, runtime identities, native records and retrieved archives. For the smallest release regression, run a one-task target successfully, append an independent task that exits 1 to that target, and leave its named checks alone. Compare `checks` with the outcome of a fresh `job_start` for the same target. The IHP reproducer adds that task to a copy of a previously passing counter release and retrieves the package it produces.
