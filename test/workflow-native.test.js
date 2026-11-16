import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manufacturingMetadata } from "./fixtures/manufacturing.mjs";
import { createWorkbench } from "../src/workbench/service.js";
import { runtimeIdentity } from "../src/design/project.js";
const enabled = process.env.CHIPSIM_TEST_MANUFACTURING === "1";
for (const mode of ["partial", "reply"])
  test(
    `native SDK bootstrap recovers after ${mode} server loss without replacing project files`,
    { skip: !enabled, timeout: 600000 },
    async () => {
      const { runWorkflow } = await import("../extensions/mcp/workflow.mjs");
      const parent = await mkdtemp(
        join(tmpdir(), "chipsim-native-bootstrap-recovery-"),
      );
      const root = join(parent, "project"),
        statePath = join(parent, "prepare.json"),
        metadata = join(parent, "metadata.json"),
        marker = join(parent, "crashed.json");
      await mkdir(root);
      await writeFile(metadata, JSON.stringify(manufacturingMetadata));
      const saved = {
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        CHIPSIM_MANUFACTURING_CACHE: process.env.CHIPSIM_MANUFACTURING_CACHE,
        CHIPSIM_TEST_BOOTSTRAP_CRASH_MARKER:
          process.env.CHIPSIM_TEST_BOOTSTRAP_CRASH_MARKER,
        CHIPSIM_TEST_BOOTSTRAP_CRASH_MODE:
          process.env.CHIPSIM_TEST_BOOTSTRAP_CRASH_MODE,
      };
      process.env.NODE_OPTIONS =
        "--import=" +
        new URL("./fixtures/bootstrap-crash.mjs", import.meta.url).pathname;
      process.env.CHIPSIM_TEST_BOOTSTRAP_CRASH_MARKER = marker;
      process.env.CHIPSIM_TEST_BOOTSTRAP_CRASH_MODE = mode;
      try {
        await assert.rejects(
          runWorkflow("prepare", {
            project: root,
            profile: "tinytapeout-ihp-v1",
            metadata,
            state: statePath,
          }),
        );
        const crash = JSON.parse(await readFile(marker));
        assert.equal(crash.mode, mode);
        const first = JSON.parse(await readFile(statePath));
        assert.equal(first.bootstrapPending, true);
        assert.ok(first.requests.bootstrap);
        const wb = await createWorkbench(root);
        const discovery = await wb.call("workflow_status");
        assert.equal(discovery.ok, true);
        assert.equal(
          discovery.result.stage,
          mode === "partial" ? "bootstrap-recovery" : "implement-and-verify",
        );
        const original = await readFile(join(root, "src/project.v"));
        // The server died while owning the project mutation lock. Product code
        // must not steal it. This test owns all clients, confirms the exact owner
        // is dead and explicitly removes that stale lock before reconciliation.
        const { alive } = await import("../src/design/process.js");
        const mutationLock = join(root, ".chipsim/workbench-lock");
        const owner = JSON.parse(
          await readFile(join(mutationLock, "owner.json")),
        );
        assert.equal(owner.pid, crash.pid);
        assert.equal(await alive(owner), false);
        await rm(mutationLock, { recursive: true });
        process.env.CHIPSIM_MANUFACTURING_CACHE = join(
          parent,
          "must-not-be-used",
        );
        const resumed = await runWorkflow("resume", { state: statePath });
        assert.equal(resumed.cache, first.cache);
        const { stat } = await import("node:fs/promises");
        await assert.rejects(stat(join(parent, "must-not-be-used")), {
          code: "ENOENT",
        });
        assert.equal(resumed.complete, true);
        assert.equal(resumed.requests.setup, first.requests.setup);
        assert.equal(resumed.requests.bootstrap, first.requests.bootstrap);
        assert.deepEqual(await readFile(join(root, "src/project.v")), original);
        const jobs = await readdir(join(root, ".chipsim/design/jobs"));
        assert.equal(jobs.length, 1);
        assert.ok(
          resumed.logs[
            resumed.results.setup.id + ":" + resumed.results.setup.generation
          ].cursor > 0,
        );
        await writeFile(join(root, "src/project.v"), "user modified source");
        const conflict = await wb.call("project_bootstrap", {
          profile: "tinytapeout-ihp-v1",
          environment: resumed.results.setup.run,
          metadata: manufacturingMetadata,
          requestId: resumed.requests.bootstrap,
        });
        assert.equal(conflict.ok, false);
        assert.match(conflict.error.message, /changed/);
        assert.equal(
          await readFile(join(root, "src/project.v"), "utf8"),
          "user modified source",
        );
        const record = {
          format: "chipsim-native-bootstrap-recovery",
          version: 1,
          mode,
          runtime: await runtimeIdentity(),
          crash,
          requests: resumed.requests,
          setupJob: resumed.results.setup.id,
          environmentRun: resumed.results.setup.run,
          logCursor:
            resumed.logs[
              resumed.results.setup.id + ":" + resumed.results.setup.generation
            ].cursor,
          complete: true,
          editedSourcePreserved: true,
          deadMutationLockExplicitlyCleaned: true,
          originalCachePreserved: true,
        };
        await writeFile(
          join(parent, "acceptance-record.json"),
          JSON.stringify(record, null, 2),
        );
        console.log(
          "Bootstrap recovery record:",
          join(parent, "acceptance-record.json"),
        );
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    },
  );
