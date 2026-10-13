import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  stat,
  rm,
  cp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { designCommand } from "../src/design/cli.js";
import { readProject } from "../src/hdl/run.js";
import { Store } from "../src/design/store.js";
import { verifyEvidence } from "../src/design/evidence.js";

const cli = new URL("../scripts/chipsim.mjs", import.meta.url).pathname;
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "chipsim guide "));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("input guidance works without a project or tools and returns real installed starter paths", async (t) => {
  const cwd = await temporary(t);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [cli, "design", "guide"],
    {
      cwd,
      env: { ...process.env, PATH: cwd },
    },
  );
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.guide.optional, true);
  assert.equal(result.guide.version, 1);
  assert.deepEqual(await readdir(cwd), []);
  const { starter, workflows, documentation } = result.guide;
  for (const file of starter.files)
    assert.ok((await stat(join(starter.directory, file))).isFile());
  for (const path of Object.values(documentation))
    assert.ok((await stat(path)).isFile());
  const project = await readProject(
    join(starter.directory, "sim.project.json"),
  );
  assert.equal(project.top, "counter_tb");
  for (const workflow of workflows) {
    const detail = await designCommand(workflow.command);
    assert.equal(detail.exitCode, 0);
    assert.ok(
      detail.result.guide.recipe.minimumInputs.every((i) => i.whenMissing),
    );
    if (detail.result.guide.recipe.example)
      assert.ok((await stat(detail.result.guide.recipe.example)).isDirectory());
  }
  const invalid = await designCommand(["design", "guide", "no-such-topic"]);
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.result.diagnostics[0].message, /Unknown guide topic/);
  assert.equal(
    (await designCommand(["design", "guide", "rtl", "extra"])).exitCode,
    2,
  );
});

test(
  "minimal guided RTL produces verified waveforms and catches a faulty DUT",
  {
    skip: process.env.CHIPSIM_TEST_HDL !== "1",
  },
  async (t) => {
    const root = join(await temporary(t), "new chip");
    const guide = (await designCommand(["design", "guide", "rtl"])).result
      .guide;
    await cp(guide.starter.directory, root, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const store = new Store(root);
    const execute = () =>
      designCommand([
        "design",
        "run",
        "--project",
        root,
        "--target",
        "simulation",
        "--wait",
        "--timeout-ms",
        "30000",
      ]);
    const good = await execute();
    assert.equal(good.exitCode, 0, JSON.stringify(good.result));
    assert.equal(good.result.job.ready, true);
    const run = await verifyEvidence(store, good.result.job.run);
    const artifacts = await Promise.all(
      run.artifacts.map((id) => store.get(id)),
    );
    assert.ok(artifacts.some((a) => a.path === "out/waveform.json"));
    assert.ok(artifacts.some((a) => a.path.endsWith("trace.vcd")));
    const dut = join(root, "counter.v");
    await writeFile(
      dut,
      (await readFile(dut, "utf8")).replace("count + 4'd1", "count + 4'd2"),
    );
    const bad = await execute();
    assert.equal(bad.exitCode, 1, JSON.stringify(bad.result));
    assert.equal(bad.result.job.ready, false);
    const failed = await verifyEvidence(store, bad.result.job.run);
    const checks = await Promise.all(failed.checks.map((id) => store.get(id)));
    assert.ok(
      checks.some((c) => c.name === "simulation" && c.verdict === "fail"),
    );
    const retained = await Promise.all(
      failed.artifacts.map((id) => store.get(id)),
    );
    assert.ok(retained.some((a) => a.path === "out/waveform.json"));
  },
);
