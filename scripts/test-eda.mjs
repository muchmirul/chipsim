#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJob, waitJob } from "../src/design/jobs.js";
import { Store, json } from "../src/design/store.js";
import {
  verifyEvidence,
  exportEvidence,
  importEvidence,
} from "../src/design/evidence.js";
import { dependencyIdentity } from "../src/design/project.js";

const args = process.argv.slice(2);
if (args.some((a) => !["--core", "--digital"].includes(a)))
  throw new Error("Usage: npm run test:eda -- [--core|--digital]");
const root = await mkdtemp(join(tmpdir(), "chipsim-eda-"));
const source = new URL("../examples/", import.meta.url);
async function run(path, target, ready = true) {
  const job = await startJob(path, target);
  const result = await waitJob(new Store(path), job.id, { timeoutMs: 1800000 });
  assert.equal(result.state, "completed", JSON.stringify(result));
  if (ready) assert.equal(result.ready, true, JSON.stringify(result));
  await verifyEvidence(new Store(path), result.run);
  console.log(`PASS ${target}: ${result.run}`);
  return result;
}
let success = false;
try {
  const peripheral = join(root, "peripheral");
  await cp(new URL("design/peripheral", source), peripheral, {
    recursive: true,
    filter: (path) => !path.split("/").includes(".chipsim"),
  });
  const first = await run(peripheral, "simulation");
  await exportEvidence(new Store(peripheral), first.run, join(root, "bundle"));
  const imported = new Store(join(root, "imported"));
  await importEvidence(imported, join(root, "bundle"));
  await verifyEvidence(imported, first.run);
  const vhdl = join(root, "vhdl");
  await cp(new URL("hdl", source), vhdl, { recursive: true });
  await writeFile(
    join(vhdl, "chipsim.design.json"),
    JSON.stringify({
      format: "chipsim-design",
      version: 1,
      id: "vhdl",
      tasks: {
        sim: {
          adapter: "hdl",
          options: { project: "adder-vhdl.project.json" },
        },
      },
      targets: { sim: { tasks: ["sim"], requiredChecks: ["sim:simulation"] } },
    }),
  );
  await writeFile(
    join(vhdl, "chipsim.lock.json"),
    '{"format":"chipsim-lock","version":1,"dependencies":[]}',
  );
  await run(vhdl, "sim");
  if (!args.includes("--core")) {
    await run(peripheral, "generation");
    await run(peripheral, "verification");
    const soc = join(root, "soc");
    await cp(new URL("design/soc", source), soc, {
      recursive: true,
      filter: (path) => !path.split("/").includes(".chipsim"),
    });
    await run(soc, "simulation");
    await run(soc, "software");
    if (!args.includes("--digital")) {
      if (!process.env.CHIPSIM_ORFS_ROOT)
        throw new Error(
          "Full physical acceptance requires CHIPSIM_ORFS_ROOT pointing to an installed ORFS flow directory; no physical checks were skipped silently.",
        );
      const config = await json(join(peripheral, "chipsim.design.json"));
      config.tasks.physical.options.flow = process.env.CHIPSIM_ORFS_ROOT;
      await writeFile(
        join(peripheral, "chipsim.design.json"),
        JSON.stringify(config),
      );
      await writeFile(
        join(peripheral, "chipsim.lock.json"),
        JSON.stringify({
          format: "chipsim-lock",
          version: 1,
          dependencies: [
            {
              path: process.env.CHIPSIM_ORFS_ROOT,
              sha256: await dependencyIdentity(process.env.CHIPSIM_ORFS_ROOT),
              tasks: ["physical"],
            },
          ],
        }),
      );
      await run(peripheral, "asic", false);
    }
  }
  success = true;
} finally {
  if (success) await rm(root, { recursive: true, force: true });
  else console.error("Retained failing EDA evidence: " + root);
}
