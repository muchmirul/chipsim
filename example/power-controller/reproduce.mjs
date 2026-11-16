#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Rebuild the example solely through the official ChipSim MCP stdio tools.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const source = dirname(fileURLToPath(import.meta.url));
const installation = resolve(process.env.CHIPSIM_ROOT || join(source, "../.."));
const args = process.argv.slice(2);
let output, cache;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log(
      "node example/power-controller/reproduce.mjs --out NEW_DIRECTORY [--cache CACHE_ROOT]\nNeeds Node 22.13+, Python 3.11/3.12, Docker, and npm ci --prefix extensions/mcp.\nRuns pinned setup, bootstrap, RTL tests, physical release, native archive validation, and verified MCP downloads.",
    );
    process.exit(0);
  }
  if (!["--out", "--cache"].includes(args[i]) || !args[i + 1])
    throw new Error("Use --out NEW_DIRECTORY [--cache CACHE_ROOT]");
  if (args[i] === "--out") output = resolve(args[++i]);
  else cache = resolve(args[++i]);
}
if (!output) throw new Error("--out must name a new working directory");
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
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Never replace a previous project or its evidence.
const transcript = output + ".mcp.jsonl";
const client = new Client(
  { name: "chipsim-power-controller-reproduction", version: "1.0.0" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(installation, "scripts/chipsim.mjs"), "mcp", "--project", output],
  env: {
    ...process.env,
    ...(cache ? { CHIPSIM_MANUFACTURING_CACHE: cache } : {}),
  },
  stderr: "pipe",
});
let serverErrors = "",
  interrupted = false,
  activeJob = null;
transport.stderr?.on("data", (b) => {
  serverErrors = (serverErrors + b).slice(-8192);
});
process.on("SIGINT", () => {
  interrupted = true;
});
process.on("SIGTERM", () => {
  interrupted = true;
});
const digest = (b) => createHash("sha256").update(b).digest("hex");
async function call(name, arguments_ = {}) {
  const response = await client.callTool(
    { name: "chipsim_" + name, arguments: arguments_ },
    undefined,
    { timeout: 60000 },
  );
  const r = response.structuredContent;
  const brief =
    name === "artifact_read" && r?.ok
      ? { ...r, result: { ...r.result, data: undefined } }
      : ["file_read", "file_write", "resource_read"].includes(name) && r?.ok
        ? {
            ok: true,
            result: {
              path: r.result.path,
              sha256: r.result.sha256,
              uri: r.result.uri,
            },
          }
        : r;
  await appendFile(
    transcript,
    JSON.stringify({
      at: new Date().toISOString(),
      tool: name,
      arguments:
        name === "file_write"
          ? {
              path: arguments_.path,
              expectedHash: arguments_.expectedHash,
              textSha256: digest(arguments_.text),
            }
          : arguments_,
      result: brief,
    }) + "\n",
  );
  if (!r?.ok) throw new Error(JSON.stringify(r) + "\n" + serverErrors);
  return r.result;
}
async function replace(path, text) {
  const previous = await call("file_read", { path });
  return call("file_write", { path, text, expectedHash: previous.sha256 });
}
async function finish(job) {
  activeJob = job.id;
  let requested = false,
    previous = "";
  for (;;) {
    if (interrupted && !requested) {
      await call("job_cancel", { job: job.id });
      requested = true;
    }
    const state = await call("job_status", { job: job.id, waitMs: 10000 });
    const progress =
      state.state +
      " " +
      Object.entries(state.tasks || {})
        .map(([key, value]) => key + ":" + value.state)
        .join(" ");
    if (progress !== previous) {
      console.log(job.id, progress);
      previous = progress;
    }
    if (
      ["completed", "failed", "cancelled", "interrupted"].includes(state.state)
    ) {
      activeJob = null;
      if (state.state !== "completed" || !state.ready)
        throw new Error("Managed job did not pass: " + JSON.stringify(state));
      return state;
    }
  }
}
async function download(artifact, destination) {
  const chunks = [];
  let offset = 0,
    expected;
  do {
    const part = await call("artifact_read", {
      artifact: artifact.id,
      offset,
      limit: 65536,
    });
    const bytes = Buffer.from(part.data, "base64");
    if (digest(bytes) !== part.chunkSha256)
      throw new Error("MCP chunk checksum mismatch");
    if (expected && expected !== part.sha256)
      throw new Error("Artifact identity changed between chunks");
    expected = part.sha256;
    chunks.push(bytes);
    offset = part.nextOffset;
  } while (offset !== null);
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== artifact.bytes || digest(bytes) !== expected)
    throw new Error("Complete artifact checksum mismatch");
  await writeFile(destination, bytes, { flag: "wx" });
  return { artifact: artifact.id, sha256: expected, bytes: bytes.length };
}
try {
  await client.connect(transport);
  await call("resource_read", { uri: "chipsim://guide/connections" });
  await call("resource_read", { uri: "chipsim://guide/workbench" });
  const metadata = JSON.parse(
    await readFile(join(source, "metadata.json"), "utf8"),
  );
  const environment = await finish(
    await call("environment_setup", {
      profile: "tinytapeout-ihp-v1",
      requestId: "power-controller-environment-v1",
    }),
  );
  if (interrupted) throw new Error("Cancelled before bootstrap");
  await call("project_bootstrap", {
    profile: "tinytapeout-ihp-v1",
    environment: environment.run,
    metadata,
  });
  const files = [
    "src/project.v",
    "src/config.json",
    "test/tb.sv",
    "acceptance.json",
    "docs/requirements.md",
    "docs/info.md",
    "docs/THIRD_PARTY_NOTICES.md",
    "docs/licenses/IHP-Apache-2.0.txt",
  ];
  for (const file of files) {
    const text = await readFile(join(source, file), "utf8");
    if (
      [
        "src/project.v",
        "src/config.json",
        "test/tb.sv",
        "acceptance.json",
        "docs/requirements.md",
        "docs/info.md",
      ].includes(file)
    )
      await replace(file, text);
    else await call("file_write", { path: file, text, expectedHash: null });
  }
  await call("validate", { target: "release" });
  const simulation = await finish(
    await call("job_start", {
      target: "simulation",
      requestId: "power-controller-simulation-v1",
      reuse: false,
    }),
  );
  if (interrupted) throw new Error("Cancelled before physical implementation");
  const release = await finish(
    await call("job_start", {
      target: "release",
      requestId: "power-controller-release-v1",
      reuse: false,
    }),
  );
  const readiness = await call("release_status", { run: release.run });
  if (!readiness.ready)
    throw new Error("Release blocked: " + JSON.stringify(readiness));
  if (interrupted) throw new Error("Cancelled before packaging");
  const packaged = await finish(
    await call("release_package", {
      run: release.run,
      requestId: "power-controller-package-v1",
    }),
  );
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
  const delivery = join(output, "delivery");
  await mkdir(delivery);
  const downloads = {};
  for (const name of [
    "submission.zip",
    "evidence.zip",
    "release-manifest.json",
    "SHA256SUMS",
    "archive-validation.xml",
  ]) {
    const artifact = artifacts.find((a) => a.path === name);
    if (!artifact) throw new Error("Missing delivery artifact: " + name);
    downloads[name] = await download(artifact, join(delivery, name));
  }
  const summary = {
    profile: "tinytapeout-ihp-v1",
    environmentRun: environment.run,
    simulationRun: simulation.run,
    releaseRun: release.run,
    packageRun: packaged.run,
    required: readiness.required,
    downloads,
  };
  await writeFile(
    join(delivery, "run-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log("Verified Tiny Tapeout handoff files:", delivery);
  console.log("Manufacturer submission and acceptance remain external.");
} catch (error) {
  console.error(error.message);
  console.error(
    "Preserved project:",
    output,
    activeJob ? "active job: " + activeJob : "",
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
