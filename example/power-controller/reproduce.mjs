#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const source = dirname(fileURLToPath(import.meta.url));
const installation = resolve(process.env.CHIPSIM_ROOT || join(source, "../.."));
const args = process.argv.slice(2);
let output, cache;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log(
      "node example/power-controller/reproduce.mjs --out NEW_DIRECTORY [--cache CACHE_ROOT]",
    );
    process.exit(0);
  }
  if (!["--out", "--cache"].includes(args[i]) || !args[i + 1])
    throw Error("Expected --out NEW_DIRECTORY [--cache CACHE_ROOT]");
  if (args[i] === "--out") output = resolve(args[++i]);
  else cache = resolve(args[++i]);
}
if (!output) throw Error("--out required");
if (cache) process.env.CHIPSIM_MANUFACTURING_CACHE = cache;
const { runWorkflow } = await import(
  pathToFileURL(join(installation, "extensions/mcp/workflow.mjs"))
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
await runWorkflow("prepare", {
  project: output,
  profile: "tinytapeout-ihp-v1",
  metadata: join(source, "metadata.json"),
  state: output + ".prepare.json",
});
const { Client } = await import(
  pathToFileURL(
    join(
      installation,
      "extensions/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  )
);
const { StdioClientTransport } = await import(
  pathToFileURL(
    join(
      installation,
      "extensions/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
    ),
  )
);
const client = new Client(
  { name: "power-controller-source", version: "1" },
  { capabilities: {} },
);
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        join(installation, "scripts/chipsim.mjs"),
        "mcp",
        "--project",
        output,
      ],
      stderr: "pipe",
    }),
  );
  for (const path of [
    "src/project.v",
    "src/config.json",
    "test/tb.sv",
    "acceptance.json",
    "docs/requirements.md",
    "docs/info.md",
    "docs/THIRD_PARTY_NOTICES.md",
    "docs/licenses/IHP-Apache-2.0.txt",
  ]) {
    const r = (
      await client.callTool({ name: "chipsim_file_read", arguments: { path } })
    ).structuredContent;
    if (!r.ok && r.error.code !== "ENOENT")
      throw Error(JSON.stringify(r.error));
    const w = (
      await client.callTool({
        name: "chipsim_file_write",
        arguments: {
          path,
          text: await readFile(join(source, path), "utf8"),
          expectedHash: r.ok ? r.result.sha256 : null,
        },
      })
    ).structuredContent;
    if (!w.ok) throw Error(JSON.stringify(w.error));
  }
} finally {
  await client.close();
}
await runWorkflow("run", {
  project: output,
  target: "simulation",
  state: output + ".simulation.json",
});
const release = await runWorkflow("run", {
  project: output,
  target: "release",
  state: output + ".release.json",
});
await runWorkflow("deliver", {
  project: output,
  run: release.results.run.run,
  out: join(output, "delivery"),
  state: output + ".delivery.json",
});
console.log("Verified local handoff:", join(output, "delivery"));
