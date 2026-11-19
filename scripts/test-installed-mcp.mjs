// Exercise the distribution's own server, dependency lock and detached worker.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runtimeIdentity, initDesign } from "../src/design/project.js";
import { Client } from "../extensions/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../extensions/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
const exec = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "chipsim-installed-mcp-"));
const project = join(root, "project");
const connections = [];
async function connect(location) {
  const client = new Client({ name: "distribution-check", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        join(location, "scripts/chipsim.mjs"),
        "mcp",
        "--project",
        project,
      ],
      stderr: "pipe",
      env: { ...process.env },
    }),
  );
  connections.push(client);
  return async (name, args = {}) => {
    const reply = (
      await client.callTool({ name: "chipsim_" + name, arguments: args })
    ).structuredContent;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.result;
  };
}
async function finish(call, id) {
  for (;;) {
    const j = await call("job_status", { job: id, waitMs: 5000 });
    if (["failed", "cancelled", "completed", "interrupted"].includes(j.state))
      return j;
  }
}
try {
  const packed = JSON.parse(
    (
      await exec("npm", ["pack", "--json", "--pack-destination", root], {
        cwd: source,
      })
    ).stdout,
  )[0];
  await exec("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--prefix",
    root,
    join(root, packed.filename),
  ]);
  const installed = join(root, "node_modules", "chipsim");
  await exec("npm", [
    "ci",
    "--ignore-scripts",
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
    "--prefix",
    join(installed, "extensions/mcp"),
  ]);
  const module = await import(
    pathToFileURL(join(installed, "src/design/project.js"))
  );
  assert.deepEqual(await module.runtimeIdentity(), await runtimeIdentity());
  await mkdir(project);
  await initDesign(project);
  const checkoutCall = await connect(source),
    tarballCall = await connect(installed);
  assert.equal(
    (await checkoutCall("project")).toolInventorySha256,
    (await tarballCall("project")).toolInventorySha256,
  );
  assert.deepEqual(
    await tarballCall("manufacturing_profiles"),
    await checkoutCall("manufacturing_profiles"),
  );
  const file = await checkoutCall("file_read", { path: "chipsim.design.json" });
  const config = JSON.parse(file.text);
  config.tasks = {
    ok: {
      adapter: "command",
      options: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    },
  };
  config.targets = {
    simulation: { tasks: ["ok"], requiredChecks: ["ok:execution"] },
  };
  await checkoutCall("file_write", {
    path: file.path,
    text: JSON.stringify(config),
    expectedHash: file.sha256,
  });
  const job = await checkoutCall("job_start", {
    target: "simulation",
    requestId: "distribution",
  });
  assert.equal((await finish(checkoutCall, job.id)).ready, true);
  await tarballCall("job_retry", { job: job.id });
  assert.equal((await finish(tarballCall, job.id)).ready, true);
  await appendFile(
    join(installed, "src/design/adapters.js"),
    "\n// distribution identity control\n",
  );
  assert.notEqual(
    (await module.runtimeIdentity()).sha256,
    (await runtimeIdentity()).sha256,
  );
  await tarballCall("job_retry", { job: job.id });
  const changed = await finish(tarballCall, job.id);
  assert.equal(changed.state, "interrupted");
  assert.equal(changed.ready, false);
  assert.match(changed.error, /runtime changed since snapshot/);
  const { profiles } = await tarballCall("manufacturing_profiles");
  assert.ok(profiles.every((profile) => profile.status === "candidate"));
  console.log(
    "PASS checkout/package identity, installed stdio schemas, snapshot retry and adapter-change control",
  );
} finally {
  await Promise.all(connections.map((c) => c.close()));
  await rm(root, { recursive: true, force: true });
}
