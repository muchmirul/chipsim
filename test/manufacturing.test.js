import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../src/workbench/service.js";
import { Store, hash } from "../src/design/store.js";
import {
  validateVerification,
  verificationChecks,
} from "../src/manufacturing/verify.js";
import { waitJob, retryJob } from "../src/design/jobs.js";
import { serviceJob } from "../src/manufacturing/jobs.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-manufacturing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new Store(root), wb: await createWorkbench(root) };
}
test("manufacturing discovery works before manifests; malformed metadata is rejected", async (t) => {
  const { wb } = await setup(t);
  const result = await wb.call("manufacturing_profiles");
  assert.equal(result.ok, true);
  const profile = result.result.profiles[0];
  assert.match(profile.pins.image, /@sha256:[a-f0-9]{64}$/);
  assert.ok(profile.requiredChecks.includes("gate:tests"));
  assert.ok(profile.sources.pdk.sha256);
  assert.equal(
    (
      await wb.call("project_bootstrap", {
        profile: profile.id,
        environment: "a".repeat(64),
        metadata: {},
      })
    ).error.code,
    "INVALID_ARGUMENTS",
  );
  assert.equal((await wb.call("release_status")).result.ready, false);
});
test("binary artifact chunks reconstruct exact bytes and detect corrupted storage", async (t) => {
  const { root, store, wb } = await setup(t);
  const bytes = Buffer.from(Array.from({ length: 150023 }, (_, i) => i % 256));
  const file = join(root, "binary.zip");
  await writeFile(file, bytes);
  const payload = await store.putFile(file);
  const artifact = await store.put("artifact", {
    path: "submission.zip",
    payload,
    inputs: [],
  });
  const chunks = [];
  let offset = 0;
  do {
    const result = await wb.call("artifact_read", {
      artifact: artifact.id,
      offset,
      limit: 32768,
    });
    assert.equal(result.ok, true);
    const chunk = Buffer.from(result.result.data, "base64");
    assert.equal(hash(chunk), result.result.chunkSha256);
    assert.equal(result.result.sha256, hash(bytes));
    chunks.push(chunk);
    offset = result.result.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(
    (
      await wb.call("artifact_read", {
        artifact: artifact.id,
        offset: bytes.length + 1,
      })
    ).error.code,
    "BYTE_RANGE",
  );
  assert.equal(
    (await wb.call("artifact_read", { artifact: artifact.id, limit: 65537 }))
      .error.code,
    "INVALID_ARGUMENTS",
  );
  await chmod(store.blobPath(payload.sha256), 0o644);
  await writeFile(store.blobPath(payload.sha256), "damage");
  assert.equal(
    (await wb.call("artifact_read", { artifact: artifact.id })).ok,
    false,
  );
});
test("native test reports require the declared executed cases and never pass skipped or absent results", async (t) => {
  const { root } = await setup(t);
  const task = { definition: { options: { operation: "rtl" } } };
  await writeFile(
    join(root, "acceptance.json"),
    JSON.stringify({ cases: ["reset", "normal"] }),
  );
  const check = async () =>
    (await verificationChecks(task, root, { ok: true }))[0];
  assert.equal((await check()).verdict, "inconclusive");
  await writeFile(
    join(root, "results.xml"),
    '<testsuite tests="2"><testcase name="reset"/><testcase name="normal"/></testsuite>',
  );
  assert.equal((await check()).verdict, "pass");
  await writeFile(
    join(root, "results.xml"),
    '<testsuite tests="2"><testcase name="reset"/><testcase name="normal"><skipped/></testcase></testsuite>',
  );
  assert.equal((await check()).verdict, "inconclusive");
  await writeFile(
    join(root, "results.xml"),
    '<testsuite><testcase name="unrelated"/></testsuite>',
  );
  assert.equal((await check()).verdict, "inconclusive");
  await writeFile(join(root, "acceptance.json"), '{"cases":[]}');
  assert.equal((await check()).verdict, "inconclusive");
});
test("container verification rejects unsafe source spelling and native check overrides", () => {
  const task = {
    adapter: "tinytapeout-verify",
    options: {
      operation: "rtl",
      top: "tt_um_demo",
      sources: ["src/demo.v"],
      image: "ghcr.io/librelane/librelane@sha256:" + "a".repeat(64),
      python: "/python",
      pdkRoot: "/pdk",
    },
  };
  validateVerification(task);
  assert.throws(() =>
    validateVerification({
      ...task,
      options: { ...task.options, sources: ["src/x.v;exec"] },
    }),
  );
  assert.throws(() =>
    validateVerification({ ...task, checks: [{ name: "tests" }] }),
  );
});
test("pre-manifest managed service requests deduplicate and preserve ordinary job failure evidence", async (t) => {
  const { root, store } = await setup(t);
  const job = await serviceJob(
    root,
    "setup",
    { profile: "unsupported-profile" },
    "setup-1",
  );
  const replay = await serviceJob(
    root,
    "setup",
    { profile: "unsupported-profile" },
    "setup-1",
  );
  assert.equal(replay.id, job.id);
  assert.equal(replay.deduplicated, true);
  await assert.rejects(
    () => serviceJob(root, "setup", { profile: "different" }, "setup-1"),
    /requestId/,
  );
  const done = await waitJob(store, job.id, { timeoutMs: 15000 });
  assert.equal(done.state, "failed");
  assert.equal(done.ready, false);
  assert.ok(done.run);
  const retried = await retryJob(store, job.id);
  assert.equal(retried.plan, done.plan);
  assert.equal(retried.snapshot, done.snapshot);
  assert.equal(retried.generation, done.generation + 1);
  assert.equal(
    (await waitJob(store, retried.id, { timeoutMs: 15000 })).state,
    "failed",
  );
});

test("bootstrap preserves existing projects and installs an explicit failing starter from verified environment evidence", async (t) => {
  const { root, store, wb } = await setup(t);
  const { manufacturingProfile } =
    await import("../src/manufacturing/profiles.js");
  const { dependencyIdentity, loadDesign } =
    await import("../src/design/project.js");
  const { manufacturingMetadata } =
    await import("./fixtures/manufacturing.mjs");
  const { mkdir, readFile } = await import("node:fs/promises");
  const { identity } = await import("../src/design/store.js");
  const profile = await manufacturingProfile("tinytapeout-ihp-v1");
  // Original unit-test source bytes; this exercises bootstrap/evidence mechanics,
  // and deliberately makes no claim to be an installed or native EDA toolchain.
  const external = await mkdtemp(join(tmpdir(), "chipsim-bootstrap-unit-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const template = join(external, "template"),
    support = join(external, "support");
  await mkdir(join(template, "src"), { recursive: true });
  await mkdir(support);
  await writeFile(join(template, "src/config.json"), '{"CLOCK_PERIOD":20}');
  await writeFile(
    join(support, "fixture.txt"),
    "Original unit-test support fixture",
  );
  const dependencies = [];
  for (const path of [template, support])
    dependencies.push({ path, sha256: await dependencyIdentity(path) });
  const environment = {
    profile: profile.id,
    digest: profile.digest,
    dependencies,
    template,
    support,
    python: "/python",
    precheckPython: "/precheck",
    pdkRoot: "/pdk",
  };
  environment.identity = identity(environment);
  const payloadFile = join(external, "environment.json");
  await writeFile(payloadFile, JSON.stringify(environment));
  const artifact = await store.put("artifact", {
    path: "environment.json",
    payload: await store.putFile(payloadFile),
    inputs: [],
  });
  const run = await store.put("run", {
    target: "manufacturing-setup",
    state: "completed",
    readiness: { ready: true },
    artifacts: [artifact.id],
  });
  const args = {
    profile: profile.id,
    environment: run.id,
    metadata: manufacturingMetadata,
  };
  await writeFile(join(root, "LICENSE"), "Existing user license");
  assert.equal((await wb.call("project_bootstrap", args)).ok, false);
  assert.equal(
    await readFile(join(root, "LICENSE"), "utf8"),
    "Existing user license",
  );
  await assert.rejects(() => readFile(join(root, "chipsim.design.json")));
  await rm(join(root, "LICENSE"));
  const replayArgs = { ...args, requestId: "bootstrap-recovery" };
  assert.equal((await wb.call("project_bootstrap", replayArgs)).ok, true);
  assert.equal((await wb.call("project_bootstrap", replayArgs)).ok, true);
  // Simulate a crash after only some top-level destinations were installed.
  await rm(join(root, "src"), { recursive: true });
  assert.equal((await wb.call("project_bootstrap", replayArgs)).ok, true);
  assert.match(await readFile(join(root, "src/project.v"), "utf8"), /module/);
  const originalSource = await readFile(join(root, "src/project.v"), "utf8");
  await writeFile(join(root, "src/project.v"), "user edit");
  const conflict = await wb.call("project_bootstrap", replayArgs);
  assert.equal(conflict.ok, false);
  assert.match(conflict.error.message, /changed/);
  assert.equal(
    await readFile(join(root, "src/project.v"), "utf8"),
    "user edit",
  );
  await writeFile(join(root, "src/project.v"), originalSource);
  assert.equal(
    (
      await wb.call("project_bootstrap", {
        ...replayArgs,
        metadata: { ...args.metadata, title: "changed" },
      })
    ).ok,
    false,
  );
  assert.equal(
    (await wb.call("workflow_status")).result.stage,
    "implement-and-verify",
  );
  const design = await loadDesign(root);
  assert.ok(
    design.config.targets.release.requiredChecks.includes("physical:precheck"),
  );
  assert.ok(
    design.config.targets.release.requiredChecks.includes("gate:tests"),
  );
  assert.match(await readFile(join(root, "test/tb.sv"), "utf8"), /\$fatal/);
  assert.equal(
    JSON.parse(await readFile(join(root, "info.yaml"), "utf8")).project
      .clock_hz,
    manufacturingMetadata.clockHz,
  );
  assert.equal((await wb.call("project_bootstrap", args)).ok, false);
  assert.equal((await wb.call("release_status")).result.ready, false);
  await writeFile(join(support, "fixture.txt"), "changed cache bytes");
  const changed = await wb.call("project_bootstrap", args);
  assert.equal(changed.ok, false);
  assert.match(changed.error.message, /Locked dependency changed/);
});

test("submission archives preserve binary files and reject content inconsistent with their manifest", async (t) => {
  const { root } = await setup(t);
  const { mkdir, readFile } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const source = join(root, "delivery");
  await mkdir(join(source, "tt_submission"), { recursive: true });
  const data = Buffer.from([0, 255, 12, 3, 0, 128]);
  const member = "tt_submission/original.gds";
  await writeFile(join(source, member), data);
  const manifest = JSON.stringify({
    members: [{ path: member, sha256: hash(data), bytes: data.length }],
  });
  await writeFile(join(source, "release-manifest.json"), manifest);
  await writeFile(
    join(source, "SHA256SUMS"),
    hash(data) +
      "  " +
      member +
      "\n" +
      hash(manifest) +
      "  release-manifest.json\n",
  );
  const script = new URL("../scripts/manufacturing-archive.py", import.meta.url)
    .pathname;
  const extracted = join(root, "extracted");
  await promisify(execFile)("python3", [
    script,
    source,
    join(root, "submission.zip"),
    extracted,
  ]);
  assert.deepEqual(await readFile(join(extracted, member)), data);
  await writeFile(join(source, member), "corrupt");
  await assert.rejects(
    () =>
      promisify(execFile)("python3", [
        script,
        source,
        join(root, "corrupt.zip"),
      ]),
    /Archive member/,
  );
});

test("physical support imports defer optional image-rendering libraries without replacing their behavior", async (t) => {
  const { root } = await setup(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await writeFile(
    join(root, "project.py"),
    "from render_utils import render_svg\nclass Project: pass\n",
  );
  await writeFile(
    join(root, "render_utils.py"),
    "raise RuntimeError('optional native renderer requested')\n",
  );
  const scriptDirectory = new URL("../scripts/", import.meta.url).pathname;
  const source =
    "import sys; sys.path.insert(0,sys.argv[1]); from tinytapeout_project import load_project; assert load_project(sys.argv[2]).__name__=='Project'; import render_utils\ntry: render_utils.render_svg(None)\nexcept RuntimeError as e: assert str(e)=='optional native renderer requested'\nelse: raise AssertionError('native renderer was bypassed')";
  await promisify(execFile)("python3", ["-c", source, scriptDirectory, root], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
});

test("managed Python inventory rejects altered installed files and unpinned distributions", async (t) => {
  const { root } = await setup(t);
  const { mkdir } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const data = "original = True\n";
  const digest = Buffer.from(hash(data), "hex").toString("base64url");
  await mkdir(join(root, "original_fixture-1.0.dist-info"));
  await writeFile(join(root, "original_fixture.py"), data);
  await writeFile(
    join(root, "original_fixture-1.0.dist-info/METADATA"),
    "Metadata-Version: 2.1\nName: original-fixture\nVersion: 1.0\n",
  );
  await writeFile(
    join(root, "original_fixture-1.0.dist-info/RECORD"),
    "original_fixture.py,sha256=" +
      digest +
      "," +
      Buffer.byteLength(data) +
      "\noriginal_fixture-1.0.dist-info/RECORD,,\n",
  );
  await writeFile(join(root, "requirements.lock"), "original-fixture==1.0\n");
  const directory = new URL("../scripts/", import.meta.url).pathname;
  const run = () =>
    promisify(execFile)(
      "python3",
      [
        "-c",
        "import sys; sys.path.insert(0,sys.argv[1]); from manufacturing_python import verify; verify(sys.argv[2], [sys.argv[3]])",
        directory,
        join(root, "requirements.lock"),
        root,
      ],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
  await run();
  await writeFile(join(root, "original_fixture.py"), "modified = True\n");
  await assert.rejects(run, /differs from its wheel record/);
  await writeFile(join(root, "original_fixture.py"), data);
  await writeFile(join(root, "requirements.lock"), "unrelated-package==1.0\n");
  await assert.rejects(run, /Unexpected cached Python distribution/);
});

test("complete duplicate, missing, contradictory and failed xUnit reports never falsely pass", async (t) => {
  const { root } = await setup(t);
  const task = { definition: { options: { operation: "rtl" } } };
  await writeFile(
    join(root, "acceptance.json"),
    JSON.stringify({ cases: ["reset", "normal"] }),
  );
  for (const xml of [
    '<testsuite><testcase name="reset"/><testcase name="reset"/></testsuite>',
    '<testsuite><testcase name="reset"/></testsuite>',
    '<testsuite tests="1"><testcase name="reset"/><testcase name="normal"/></testsuite>',
    '<testsuite><testcase name="reset"><failure message="wrong"/></testcase><testcase name="normal"/></testsuite>',
    '<testsuite><testcase><failure/></testcase><testcase name="normal"/></testsuite>',
  ]) {
    await writeFile(join(root, "results.xml"), xml);
    const [check] = await verificationChecks(task, root, { ok: true });
    assert.notEqual(check.verdict, "pass");
  }
});
