import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as counter from "./fixtures/manufacturing.mjs";
import { extraFixture } from "./fixtures/manufacturing-extra.mjs";
const fixtureName = process.env.CHIPSIM_MANUFACTURING_FIXTURE || "counter";
const fixture = fixtureName === "counter" ? counter : extraFixture(fixtureName);
const { manufacturingMetadata, cases, counterRTL, counterTestbench } = fixture;
const mutation = fixture.mutation || ["count + 1", "count + 2"];
const enabled = process.env.CHIPSIM_TEST_MANUFACTURING === "1";
test(
  "official SDK: empty project and managed setup through native manufacturing archive retrieval",
  { skip: !enabled, timeout: 14400000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-manufacturing-mcp-"));
    const cache =
      process.env.CHIPSIM_MANUFACTURING_CACHE ||
      (await mkdtemp(join(tmpdir(), "chipsim-manufacturing-cache-")));
    console.log("Native MCP manufacturing evidence:", root, "cache:", cache);
    const { Client } =
      await import("../extensions/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
    const { StdioClientTransport } =
      await import("../extensions/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
    const connect = async (projectRoot = root) => {
      const client = new Client(
        { name: "chipsim-manufacturing-acceptance", version: "1" },
        { capabilities: {} },
      );
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            new URL("../scripts/chipsim.mjs", import.meta.url).pathname,
            "mcp",
            "--project",
            projectRoot,
          ],
          env: { ...process.env, CHIPSIM_MANUFACTURING_CACHE: cache },
          stderr: "pipe",
        }),
      );
      t.after(() => client.close());
      return client;
    };
    let client = await connect();
    const call = async (name, args = {}, target = client) => {
      const r = (
        await target.callTool({ name: "chipsim_" + name, arguments: args })
      ).structuredContent;
      assert.equal(r.ok, true, JSON.stringify(r));
      return r.result;
    };
    const finish = async (job, target = client) => {
      for (;;) {
        const state = await call(
          "job_status",
          { job: job.id, waitMs: 10000 },
          target,
        );
        console.log(
          job.id,
          state.state,
          Object.keys(state.tasks || {}).join(","),
        );
        if (
          ["completed", "failed", "interrupted", "cancelled"].includes(
            state.state,
          )
        )
          return state;
      }
    };
    const profiles = await call("manufacturing_profiles");
    const profile = profiles.profiles[0].id;
    const setup = await call("environment_setup", {
      profile,
      requestId: "setup",
    });
    const otherRoot = await mkdtemp(
      join(tmpdir(), "chipsim-manufacturing-concurrent-"),
    );
    const otherClient = await connect(otherRoot);
    const waitingSetup = await call(
      "environment_setup",
      { profile, requestId: "parallel-setup" },
      otherClient,
    );
    await call(
      "job_status",
      { job: waitingSetup.id, waitMs: 1000 },
      otherClient,
    );
    await call("job_cancel", { job: waitingSetup.id }, otherClient);
    const cancelledSetup = await finish(waitingSetup, otherClient);
    assert.equal(cancelledSetup.state, "cancelled");
    await client.close();
    client = await connect();
    assert.equal(
      (await call("environment_setup", { profile, requestId: "setup" })).id,
      setup.id,
    );
    const environment = await finish(setup);
    assert.equal(environment.state, "completed", JSON.stringify(environment));
    await call("project_bootstrap", {
      profile,
      environment: environment.run,
      metadata: manufacturingMetadata,
    });
    const update = async (path, text) => {
      const old = await call("file_read", { path });
      return call("file_write", { path, text, expectedHash: old.sha256 });
    };
    let raceDependency;
    if (
      process.env.CHIPSIM_TEST_MANUFACTURING_RACES === "1" &&
      fixtureName === "counter"
    ) {
      const { dependencyIdentity } = await import("../src/design/project.js");
      raceDependency = await mkdtemp(
        join(tmpdir(), "chipsim-native-race-dependency-"),
      );
      await writeFile(join(raceDependency, "data"), "original");
      const lock = JSON.parse(
        (await call("file_read", { path: "chipsim.lock.json" })).text,
      );
      lock.dependencies.push({
        path: raceDependency,
        sha256: await dependencyIdentity(raceDependency),
      });
      await update("chipsim.lock.json", JSON.stringify(lock));
    }
    await update("acceptance.json", JSON.stringify({ cases }));
    await update("test/tb.sv", counterTestbench);
    await update("src/project.v", counterRTL.replace(...mutation));
    const failure = await finish(
      await call("job_start", { target: "simulation", requestId: "broken" }),
    );
    assert.equal(failure.state, "failed");
    assert.equal((await call("checks", { target: "simulation" })).ready, false);
    const logs = await call("job_logs", { job: failure.id });
    assert.match(
      logs.text,
      new RegExp(fixture.failurePattern || "counter/wrap failed"),
    );
    assert.ok(failure.diagnostics.some((d) => d.category === "assertion"));
    await update("src/project.v", counterRTL);
    const released = await finish(
      await call("job_start", { target: "release", requestId: "release" }),
    );
    assert.equal(released.state, "completed", JSON.stringify(released));
    assert.equal(
      (await call("release_status", { run: released.run })).ready,
      true,
    );
    const originalConfig = await call("file_read", {
      path: "chipsim.design.json",
    });
    const weakened = JSON.parse(originalConfig.text);
    weakened.targets.release.requiredChecks = ["physical:outputs"];
    await update("chipsim.design.json", JSON.stringify(weakened));
    const policyBlocked = await call("release_status", { run: released.run });
    assert.equal(policyBlocked.ready, false);
    assert.ok(
      policyBlocked.blockers.some((b) =>
        b.includes("Mandatory profile check removed"),
      ),
    );
    const addedProof = JSON.parse(originalConfig.text);
    addedProof.tasks.requiredProof = {
      adapter: "sby",
      options: { config: "required.sby" },
    };
    await update("chipsim.design.json", JSON.stringify(addedProof));
    const proofBlocked = await call("release_status", { run: released.run });
    assert.equal(proofBlocked.ready, false);
    assert.ok(
      proofBlocked.blockers.some((b) => b.includes("Declared proof must pass")),
    );
    await update("chipsim.design.json", originalConfig.text);
    let raceScenarios = [];
    if (
      process.env.CHIPSIM_TEST_MANUFACTURING_RACES === "1" &&
      fixtureName === "counter"
    ) {
      const { packagingRaces } =
        await import("./fixtures/manufacturing-races.mjs");
      raceScenarios = await packagingRaces(root, released.run, raceDependency);
      const { nativeCancellation } =
        await import("./fixtures/native-cancellation.mjs");
      raceScenarios.push(
        await nativeCancellation(call, root, profiles.profiles[0].pins.image),
      );
    }
    const packaged = await finish(
      await call("release_package", {
        run: released.run,
        requestId: "package",
      }),
    );
    assert.equal(packaged.state, "completed", JSON.stringify(packaged));
    const artifacts = [];
    let offset = 0;
    do {
      const page = await call("artifacts", {
        run: packaged.run,
        offset,
        limit: 200,
      });
      artifacts.push(...page.items);
      offset = page.nextOffset;
    } while (offset !== null);
    const archive = artifacts.find((a) => a.path === "submission.zip");
    assert.ok(archive);
    const chunks = [];
    let position = 0;
    let sha256;
    do {
      const chunk = await call("artifact_read", {
        artifact: archive.id,
        offset: position,
        limit: 65536,
      });
      const bytes = Buffer.from(chunk.data, "base64");
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        chunk.chunkSha256,
      );
      sha256 = chunk.sha256;
      chunks.push(bytes);
      position = chunk.nextOffset;
    } while (position !== null);
    const bytes = Buffer.concat(chunks);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
    const retrieved = join(root, "retrieved-submission.zip");
    await writeFile(retrieved, bytes);
    await promisify(execFile)("python3", [
      "-c",
      "import zipfile,sys,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; m=json.loads(z.read('release-manifest.json')); assert all(hashlib.sha256(z.read(f['path'])).hexdigest()==f['sha256'] for f in m['members']); assert any(n.endswith('.gds') for n in z.namelist())",
      retrieved,
    ]);
    const { runtimeIdentity } = await import("../src/design/project.js");
    const acceptance = {
      fixture: fixtureName,
      raceScenarios,
      root,
      cache,
      runtime: await runtimeIdentity(),
      profile: profiles.profiles[0].id,
      digest: profiles.profiles[0].digest,
      sourceSha256: createHash("sha256").update(counterRTL).digest("hex"),
      testbenchSha256: createHash("sha256")
        .update(counterTestbench)
        .digest("hex"),
      failure,
      release: released,
      package: packaged,
      archive: { artifact: archive.id, sha256 },
      readiness: await call("release_status", { run: released.run }),
    };
    await writeFile(
      join(root, "acceptance-record.json"),
      JSON.stringify(acceptance, null, 2),
    );
    console.log("Acceptance record:", join(root, "acceptance-record.json"));
    await update("src/project.v", counterRTL + "\n// changed after release\n");
    assert.equal(
      (await call("release_status", { run: released.run })).ready,
      false,
    );
    console.log(
      "Verified end-to-end delivery",
      archive.id,
      sha256,
      "retained at",
      root,
    );
  },
);
