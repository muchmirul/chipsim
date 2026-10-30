import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startJob, waitJob } from "../src/design/jobs.js";
import { Store } from "../src/design/store.js";
import { verifyEvidence } from "../src/design/evidence.js";
import { checksForTarget } from "../src/design/service.js";
import { TuiState } from "../src/tui/state.js";
import { openRecordedArtifact } from "../src/tui/design-panel.js";

test(
  "managed circuit jobs retain scoped checks, immutable source and inspectable portable evidence",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-circuit-managed-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "swap.json"),
      await readFile(resolve("examples/connected-circuit/swap.json")),
    );
    const config = {
      format: "chipsim-design",
      version: 1,
      id: "connected",
      tasks: {
        analyze: {
          adapter: "circuit",
          options: { source: "swap.json", operation: "build" },
          outputs: [
            { path: "out/session.json", kind: "circuit-session" },
            { path: "out/coverage.json", kind: "report" },
          ],
        },
      },
      targets: {
        analyze: {
          tasks: ["analyze"],
          requiredChecks: ["analyze:coverage", "analyze:outputs"],
        },
      },
    };
    await writeFile(join(root, "chipsim.design.json"), JSON.stringify(config));
    await writeFile(
      join(root, "chipsim.lock.json"),
      JSON.stringify({ format: "chipsim-lock", version: 1, dependencies: [] }),
    );
    const store = new Store(root),
      job = await startJob(root, "analyze"),
      state = await waitJob(store, job.id, { timeoutMs: 15000 });
    assert.equal(state.state, "completed", JSON.stringify(state));
    assert.equal(state.ready, true);
    await verifyEvidence(store, state.run);
    const readiness = await checksForTarget(root, "analyze");
    assert.equal(readiness.ready, true);
    const artifacts = await store.list("artifact"),
      session = artifacts.find(
        (artifact) => artifact.kind === "circuit-session",
      );
    assert.ok(session);
    const ui = new TuiState({ workspace: join(root, "ui") });
    await ui.initialize();
    assert.equal(
      (await openRecordedArtifact(ui, store, session.id)).opened,
      true,
    );
    assert.equal(ui.model.connected.model.spec.id, "swap");
    assert.equal(ui.view, "circuit");
    const source = JSON.parse(await readFile(join(root, "swap.json")));
    source.state[0].rules[0].when = { bits: 0, width: 1 };
    await writeFile(join(root, "swap.json"), JSON.stringify(source));
    const changed = await startJob(root, "analyze"),
      failed = await waitJob(store, changed.id, { timeoutMs: 15000 });
    assert.equal(failed.state, "failed");
    assert.equal(failed.ready, false);
    const checks = await store.list("check");
    assert.ok(
      checks.some(
        (check) => check.name === "coverage" && check.verdict === "fail",
      ),
    );
    await verifyEvidence(store, state.run);
  },
);

test(
  "the copyable agent starter enforces rule and native correspondence readiness",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-circuit-starter-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(resolve("examples/connected-circuit"), root, { recursive: true });
    const store = new Store(root),
      analyze = await startJob(root, "analyze"),
      checked = await waitJob(store, analyze.id, { timeoutMs: 15000 });
    assert.equal(checked.state, "completed", JSON.stringify(checked));
    assert.equal(checked.ready, true);
    await verifyEvidence(store, checked.run);
    if (process.env.CHIPSIM_TEST_CIRCUIT === "1") {
      const verify = await startJob(root, "verify"),
        tested = await waitJob(store, verify.id, { timeoutMs: 20000 });
      assert.equal(tested.state, "completed", JSON.stringify(tested));
      assert.equal(tested.ready, true);
      await verifyEvidence(store, tested.run);
      const artifacts = await store.list("artifact"),
        report = artifacts.find(
          (artifact) => artifact.path === "out/correspondence.json",
        );
      assert.ok(report);
      const measured = JSON.parse(
        await readFile(store.blobPath(report.payload.sha256), "utf8"),
      );
      assert.equal(measured.checked, 1024);
      assert.equal(measured.status, "simulation-only");
      const checks = await store.list("check");
      assert.ok(
        checks.some(
          (check) =>
            check.name === "correspondence" && check.verdict === "pass",
        ),
      );
    }
  },
);
