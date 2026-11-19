import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluateRequirements } from "../src/manufacturing/coverage.js";
import { parseXunit } from "../src/design/xunit.js";
import { graphWindow, netlistGraph } from "../src/workbench/inspect.js";
import { counterRTL, counterTestbench } from "./fixtures/manufacturing.mjs";

test("xUnit decodes predefined and numeric references once, and rejects malformed references", () => {
  const [c] = parseXunit(
    '<testsuite><testcase name="read &amp; clear &#x41;"><failure message="a &lt; b"> &quot;quoted&quot;</failure></testcase></testsuite>',
  );
  assert.equal(c.name, "read & clear A");
  assert.equal(c.message, 'a < b "quoted"');
  for (const ref of ["&bad;", "&", "&#0;", "&#xD800;"])
    assert.throws(() =>
      parseXunit('<testsuite><testcase name="' + ref + '"/></testsuite>'),
    );
});
test("release requirements match the specific proof kind, property, bound and clock", () => {
  const coverage = { declared: ["R"], mapping: { R: ["test"] } };
  const check = {
    id: "proof",
    name: "formal",
    task: "verify",
    verdict: "pass",
    context: {
      tasks: [
        {
          mode: "bmc",
          depth: 4,
          verdict: "PASS",
          properties: [{ name: "top.p", kind: "assert" }],
        },
      ],
    },
  };
  const evaluate = (p) =>
    evaluateRequirements(
      [{ id: "R", kind: "bmc", task: "verify", ...p }],
      coverage,
      [check],
    )[0].verdict;
  assert.equal(evaluate({ minDepth: 4, property: "top.p" }), "pass");
  assert.equal(evaluate({ minDepth: 8 }), "missing");
  assert.equal(evaluate({ kind: "prove" }), "missing");
  assert.equal(evaluate({ property: "other" }), "missing");
  assert.equal(evaluate({ kind: "timing", clock: "clk" }), "missing");
  assert.equal(
    evaluate({ kind: "prove", waiver: "deferred in Rev A" }),
    "waived",
  );
});
test("Yosys inout ports and bidirectional cell pins appear in both directions", () => {
  const model = netlistGraph({
    modules: {
      top: {
        ports: { io: { direction: "inout", bits: [2] } },
        cells: {
          buf: {
            type: "BUF",
            port_directions: { PAD: "inout" },
            connections: { PAD: [2] },
          },
        },
      },
    },
  });
  for (const id of ["y:top/port/io", "y:top/cell/buf"]) {
    const query = (relation) =>
      graphWindow(model, { object: id, relation }).items.filter(
        (e) => e.kind === "bidirectional",
      );
    assert.equal(query("fanin").length, 1);
    assert.deepEqual(query("fanin"), query("fanout"));
  }
});
test(
  "native XOR bench rejects constant-high, OR and disconnected bit mutants",
  {
    skip:
      process.env.CHIPSIM_TEST_MANUFACTURING !== "1" &&
      process.env.CHIPSIM_TEST_HDL !== "1",
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chipsim-xor-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const exec = promisify(execFile);
    await writeFile(join(root, "tb.sv"), counterTestbench);
    for (const expr of [
      "ui_in ^ uio_in",
      "8'hff",
      "ui_in | uio_in",
      "(ui_in ^ uio_in) & 8'hfe",
    ]) {
      await writeFile(
        join(root, "design.v"),
        counterRTL.replace("ui_in ^ uio_in", expr),
      );
      await exec(
        "iverilog",
        ["-g2012", "-s", "tb", "-o", "bench", "design.v", "tb.sv"],
        { cwd: root },
      );
      const run = exec("vvp", ["bench"], { cwd: root });
      if (expr === "ui_in ^ uio_in") await run;
      else await assert.rejects(run, (e) => e.stdout.includes("xor failed"));
    }
  },
);

test("artifact page reads authenticate one transfer, reject changed blocks and restart cleanly", async (t) => {
  const { Store, hash } = await import("../src/design/store.js");
  const { artifactReader } =
    await import("../src/workbench/artifact-transfer.js");
  const root = await mkdtemp(join(tmpdir(), "chipsim-transfer-scaling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "capture.bin");
  const data = Buffer.alloc(8 * 1024 * 1024, 0x53);
  await writeFile(source, data);
  const store = new Store(root),
    payload = await store.putFile(source);
  const record = await store.put("artifact", { path: "capture.bin", payload });
  const original = store.get.bind(store);
  let lookups = 0;
  store.get = async (...args) => {
    if (args[0] === record.id) lookups++;
    return original(...args);
  };
  const read = artifactReader(),
    chunks = [];
  for (let offset = 0; offset < data.length; offset += 65536) {
    const part = await read(store, { artifact: record.id, offset });
    chunks.push(Buffer.from(part.data, "base64"));
  }
  assert.equal(hash(Buffer.concat(chunks)), payload.sha256);
  assert.ok(
    lookups <= 2,
    "verifying the closure once must cover all 128 chunks",
  );
  await read(store, { artifact: record.id, offset: 0 });
  const mutated = Buffer.from(data);
  mutated[65536] ^= 1;
  await writeFile(source, mutated);
  await rename(source, store.blobPath(payload.sha256));
  await assert.rejects(
    read(store, { artifact: record.id, offset: 65536 }),
    /integrity/,
  );
  await assert.rejects(
    artifactReader()(store, { artifact: record.id, offset: 65536 }),
    /integrity/,
  );
});

test("a cached Docker image works offline; missing and mismatched images retain their setup diagnostics", async () => {
  const exec = promisify(execFile);
  const helper = new URL("../scripts/manufacturing-setup.py", import.meta.url)
    .pathname;
  await exec("python3", [
    "-c",
    `
import json,runpy,subprocess,sys
from unittest.mock import patch
ensure=runpy.run_path(sys.argv[1])['ensure_image']
image='registry/test@sha256:'+'b'*64
ok=subprocess.CompletedProcess([],0,json.dumps([{'RepoDigests':[image],'Os':'linux','Architecture':'amd64'}]))
missing=subprocess.CompletedProcess([],1,'')
with patch('subprocess.run', return_value=ok) as run:
    ensure(image)
    assert run.call_count == 1 and 'inspect' in run.call_args.args[0]
with patch('subprocess.run',side_effect=[missing,subprocess.CompletedProcess([],0),ok]) as run:
    ensure(image)
    assert run.call_args_list[1].args[0]==('docker','pull',image)
with patch('subprocess.run',side_effect=[missing,subprocess.CalledProcessError(1,'docker pull')]):
    try: ensure(image)
    except subprocess.CalledProcessError: pass
    else: raise AssertionError('Expected unavailable registry to fail')
with patch('subprocess.run',return_value=subprocess.CompletedProcess([],0,ok.stdout.replace('amd64','arm64'))):
    try: ensure(image)
    except ValueError: pass
    else: raise AssertionError('Wrong platform accepted')
`,
    helper,
  ]);
});

test("source mutation resumes a staged candidate apply before accepting another edit", async (t) => {
  const { mkdir, readFile } = await import("node:fs/promises");
  const { Store, atomic, hash } = await import("../src/design/store.js");
  const { revision, writeText } = await import("../src/workbench/files.js");
  const root = await mkdtemp(join(tmpdir(), "chipsim-apply-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "project"),
    source = join(root, "candidate");
  await mkdir(target);
  await mkdir(source);
  const store = new Store(target);
  for (const file of ["a", "b"]) {
    await writeFile(join(target, file), "base");
    await writeFile(join(source, file), "updated");
  }
  const base = await revision(target, { capture: true, store });
  const next = await revision(source, { capture: true, store });
  await atomic(join(target, ".chipsim/pending-apply.json"), {
    base: base.id,
    next: next.id,
  });
  await writeFile(join(target, "a"), "updated");
  await writeText(target, {
    path: "a",
    text: "after-recovery",
    expectedHash: hash("updated"),
  });
  assert.equal(await readFile(join(target, "b"), "utf8"), "updated");
  assert.equal(await readFile(join(target, "a"), "utf8"), "after-recovery");
  await assert.rejects(readFile(join(target, ".chipsim/pending-apply.json")), {
    code: "ENOENT",
  });
});

test("tools-only workflow names the invalid lock and stops after simulation passes", async (t) => {
  const { createWorkbench } = await import("../src/workbench/service.js");
  const root = await mkdtemp(join(tmpdir(), "chipsim-guidance-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    format: "chipsim-design",
    version: 1,
    id: "workflow",
    tasks: {
      sim: {
        adapter: "command",
        options: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    },
    targets: {
      simulation: { tasks: ["sim"], requiredChecks: ["sim:execution"] },
    },
  };
  await writeFile(join(root, "chipsim.design.json"), JSON.stringify(config));
  await writeFile(join(root, "chipsim.lock.json"), "{");
  const wb = await createWorkbench(root);
  const call = async (name, args) => {
    const r = await wb.call(name, args);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
  };
  const broken = await call("workflow_status", {});
  assert.equal(broken.nextActions[0].arguments.path, "chipsim.lock.json");
  await writeFile(
    join(root, "chipsim.lock.json"),
    JSON.stringify({ format: "chipsim-lock", version: 1, dependencies: [] }),
  );
  const job = await call("job_start", {
    target: "simulation",
    requestId: "sim",
  });
  let state;
  do {
    state = await call("job_status", { job: job.id, waitMs: 1000 });
  } while (["accepted", "queued", "running"].includes(state.state));
  assert.equal(state.ready, true);
  const current = await call("workflow_status", {});
  assert.equal(current.stage, "verified");
  assert.deepEqual(current.nextActions, []);
});

test("environment check reports a missing executable and never executes a project version probe", async (t) => {
  const { createWorkbench } = await import("../src/workbench/service.js");
  const { stat } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "chipsim-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = join(root, "version-ran");
  const tasks = {
    one: {
      adapter: "command",
      options: {
        command: process.execPath,
        versionArgs: [
          "-e",
          "require('fs').writeFileSync(" + JSON.stringify(sentinel) + ",'bad')",
        ],
      },
    },
    two: {
      adapter: "command",
      options: { command: join(root, "missing-tool") },
    },
  };
  await writeFile(
    join(root, "chipsim.design.json"),
    JSON.stringify({
      format: "chipsim-design",
      version: 1,
      id: "preflight",
      tasks,
      targets: { sim: { tasks: ["one", "two"] } },
    }),
  );
  await writeFile(
    join(root, "chipsim.lock.json"),
    JSON.stringify({ format: "chipsim-lock", version: 1, dependencies: [] }),
  );
  const result = await (
    await createWorkbench(root)
  ).call("environment_check", { target: "sim", profile: "tinytapeout-ihp-v1" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.result.targets.map((t) => t.tools[0].available),
    [true, false],
  );
  assert.equal(typeof result.result.observer.verilog.available, "boolean");
  assert.equal(typeof result.result.cache.present, "boolean");
  await assert.rejects(stat(sentinel), { code: "ENOENT" });
});
