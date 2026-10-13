#!/usr/bin/env node
// Real ORFS/KLayout acceptance, optionally including the real OpenROAD-MCP
// server. Native rule violations are evidence, not harness errors; unsupported
// or unreadable reports are harness errors. No missing tools are skipped.
import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startJob, waitJob } from "../src/design/jobs.js";
import { Store, json } from "../src/design/store.js";
import { dependencyIdentity } from "../src/design/project.js";
import { verifyEvidence } from "../src/design/evidence.js";
const args = process.argv.slice(2);
if (args.some((a) => a !== "--mcp"))
  throw new Error("Usage: node scripts/test-physical.mjs [--mcp]");
if (!process.env.CHIPSIM_ORFS_ROOT)
  throw new Error("Set CHIPSIM_ORFS_ROOT to the installed ORFS flow directory");
if (args.includes("--mcp") && !process.env.CHIPSIM_MCP_ROOT)
  throw new Error(
    "Set CHIPSIM_MCP_ROOT to the pinned server installation directory",
  );
const root = await mkdtemp(join(tmpdir(), "chipsim-physical-"));
let success = false;
try {
  await cp(new URL("../examples/design/peripheral", import.meta.url), root, {
    recursive: true,
    filter: (p) => !p.split("/").includes(".chipsim"),
  });
  const config = await json(join(root, "chipsim.design.json"));
  config.tasks.physical.options.flow = process.env.CHIPSIM_ORFS_ROOT;
  const dependencies = [
    {
      path: process.env.CHIPSIM_ORFS_ROOT,
      sha256: await dependencyIdentity(process.env.CHIPSIM_ORFS_ROOT),
      tasks: ["physical"],
    },
  ];
  if (args.includes("--mcp")) {
    config.targets.asic.tasks = ["inspect-physical"];
    config.targets.asic.requiredChecks.push(
      "inspect-physical:mcp",
      "inspect-physical:outputs",
    );
    dependencies.push({
      path: process.env.CHIPSIM_MCP_ROOT,
      sha256: await dependencyIdentity(process.env.CHIPSIM_MCP_ROOT),
      tasks: ["inspect-physical"],
    });
  }
  await writeFile(join(root, "chipsim.design.json"), JSON.stringify(config));
  await writeFile(
    join(root, "chipsim.lock.json"),
    JSON.stringify({ format: "chipsim-lock", version: 1, dependencies }),
  );
  const store = new Store(root),
    job = await startJob(root, "asic");
  console.log("Physical evidence: " + root + " job " + job.id);
  const state = await waitJob(store, job.id, { timeoutMs: 1800000 });
  assert.equal(state.state, "completed", JSON.stringify(state));
  const run = await verifyEvidence(store, state.run);
  const checks = await Promise.all(
    run.checks.map((id) => store.get(id, "check")),
  );
  for (const name of ["timing", "drc", "lvs"]) {
    const c = checks.find((c) => c.name === name);
    assert.ok(["pass", "fail"].includes(c?.verdict), JSON.stringify(c));
    assert.ok(c.evidence.length, "Expected native report evidence");
    console.log(name + ": " + c.verdict + " " + JSON.stringify(c.metrics));
  }
  if (args.includes("--mcp"))
    assert.equal(checks.find((c) => c.name === "mcp")?.verdict, "pass");
  assert.equal(
    state.ready,
    run.readiness.required.every((r) => r.verdict === "pass"),
  );
  console.log(
    "PASS native physical reports, artifact integrity and readiness; ready=" +
      state.ready,
  );
  success = true;
} finally {
  if (success && !process.env.CHIPSIM_KEEP_EDA)
    await rm(root, { recursive: true, force: true });
  else console.log("Retained physical evidence: " + root);
}
