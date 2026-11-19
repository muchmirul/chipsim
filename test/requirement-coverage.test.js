import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJob, waitJob } from "../src/design/jobs.js";
import { executable } from "../src/design/project.js";
import { checksForTarget } from "../src/design/service.js";
import { Store } from "../src/design/store.js";
import { summarizeRequirementEvidence } from "../src/manufacturing/coverage.js";

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(
    new URL("../examples/workbench/programmable/", import.meta.url),
    root,
    {
      recursive: true,
      filter: (path) => !path.endsWith("/.chipsim"),
    },
  );
  const file = join(root, "chipsim.design.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  const save = () => writeFile(file, JSON.stringify(config));
  const store = new Store(root);
  const run = async (target) => {
    const job = await startJob(root, target, { reuse: false });
    const state = await waitJob(store, job.id, { timeoutMs: 30000 });
    assert.equal(state.state, "completed", JSON.stringify(state));
    return checksForTarget(root, target, state.run);
  };
  return { root, store, config, save, run };
}

test("ready image has no simulation or requirement evidence; coverage stays with its run", async (t) => {
  const { root, config, save, run } = await project(t);
  config.targets.image = {
    tasks: ["image"],
    requiredChecks: ["image:program-validation"],
  };
  await save();
  assert.equal(
    (await checksForTarget(root, "image")).requirementCoverage.status,
    "unavailable",
  );
  const image = await run("image");
  assert.equal(image.ready, true);
  assert.ok(!image.checks.some((c) => c.name === "simulation"));
  assert.deepEqual(image.requirementResults, []);
  assert.deepEqual(image.requirementCoverage, {
    status: "unverified",
    declared: 1,
    covered: [],
    unverified: ["FIXED-HARDWARE-TWO-PROGRAMS"],
  });
  config.engineering.requirements = [];
  await save();
  const next = await run("image");
  assert.equal(next.requirementCoverage.status, "not-declared");
  assert.deepEqual(
    (await checksForTarget(root, "image", image.run)).requirementCoverage,
    image.requirementCoverage,
  );
});

test("a mapped native equivalence result covers only the captured policy and evidence", async (t) => {
  if (!(await executable("eqy")) || !(await executable("yosys")))
    return t.skip("requires EQY and Yosys");
  const { root, store, config, save, run } = await project(t);
  const id = "IDENTITY",
    task = "equiv";
  config.engineering.requirements = [{ id }];
  await writeFile(
    join(root, "gold.v"),
    "module dut(input a, output y); assign y = a; endmodule",
  );
  await writeFile(
    join(root, "gate.v"),
    "module dut(input a, output y); assign y = ~~a; endmodule",
  );
  await writeFile(
    join(root, "identity.eqy"),
    "[gold]\nread_verilog gold.v\nprep -top dut\n[gate]\nread_verilog gate.v\nprep -top dut\n[strategy simple]\nuse sat\ndepth 1\n",
  );
  config.tasks[task] = {
    adapter: "eqy",
    inputs: ["gold.v", "gate.v", "identity.eqy"],
    options: { config: "identity.eqy" },
  };
  config.targets.proof = {
    tasks: [task],
    requiredChecks: ["equiv:equivalence"],
    evidencePolicy: [{ id, kind: "equivalence", task }],
  };
  await save();
  const proof = await run("proof");
  assert.equal(proof.ready, true);
  assert.deepEqual(proof.requirementCoverage, {
    status: "covered",
    declared: 1,
    covered: [id],
    unverified: [],
  });
  const [{ check, verdict }] = proof.requirementResults;
  assert.equal(verdict, "pass");
  const [marker] = (await store.get(check, "check")).evidence;
  const artifact = await store.get(marker, "artifact");
  assert.equal(artifact.path, "out/PASS");
  await store.verifyBlob(artifact.payload);

  // A waiver satisfies readiness policy, but is not evidence for an ID.
  config.targets.proof.evidencePolicy[0].waiver = "Deferred";
  await save();
  const reread = await checksForTarget(root, "proof", proof.run);
  assert.equal(reread.requirementResults[0].verdict, "waived");
  assert.deepEqual(reread.requirementCoverage, proof.requirementCoverage);
  const waived = await run("proof");
  assert.equal(waived.ready, true);
  assert.deepEqual(waived.requirementCoverage.unverified, [id]);

  // A corrupt artifact invalidates the evidence even though it was once covered.
  await rm(store.blobPath(artifact.payload.sha256));
  const invalid = await checksForTarget(root, "proof", proof.run);
  assert.equal(invalid.ready, false);
  assert.equal(invalid.requirementCoverage.status, "unavailable");
});

test("one passed rule does not cover missing or waived obligations for the same ID", () => {
  const report = summarizeRequirementEvidence(
    [{ id: "A" }, { id: "B" }, { id: "C" }],
    [
      { id: "A", verdict: "pass", check: "a" },
      { id: "B", verdict: "pass", check: "b" },
      { id: "B", verdict: "missing" },
      { id: "C", verdict: "waived" },
    ],
  );
  assert.deepEqual(report, {
    status: "partial",
    declared: 3,
    covered: ["A"],
    unverified: ["B", "C"],
  });
});
