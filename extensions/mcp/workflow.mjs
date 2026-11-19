#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  readFile,
  writeFile,
  rename,
  mkdir,
  open,
  unlink,
  realpath,
  stat,
  lstat,
} from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
const digest = (b) => createHash("sha256").update(b).digest("hex");
const readJSON = async (p) => JSON.parse(await readFile(p, "utf8"));
// Transport-neutral byte retrieval shared by the official SDK helper and fault
// injection tests. Every resumed prefix is verified against immutable MCP bytes.
export async function downloadArtifact(
  call,
  artifact,
  target,
  progress = async () => {},
  interrupted = () => false,
) {
  const partial = target + ".partial";
  for (const path of [target, partial]) {
    const info = await lstat(path).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (info && !info.isFile())
      throw Error("Expected regular download file: " + path);
  }
  const first = await call("artifact_read", {
    artifact: artifact.id,
    offset: 0,
    limit: 65536,
  });
  const existing = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (existing) {
    const hash = createHash("sha256");
    try {
      for await (const data of existing.createReadStream({ autoClose: false }))
        hash.update(data);
      if (
        (await existing.stat()).size !== artifact.bytes ||
        hash.digest("hex") !== first.sha256
      )
        throw Error("Conflicting destination: " + target);
    } finally {
      await existing.close();
    }
    return {
      artifact: artifact.id,
      sha256: first.sha256,
      bytes: artifact.bytes,
    };
  }
  const handle = await open(
    partial,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
  );
  const hash = createHash("sha256");
  let position = 0;
  try {
    const oldLength = (await handle.stat()).size;
    for (;;) {
      if (interrupted())
        throw Error("Download interrupted; resume with the same journal");
      const p =
        position === 0
          ? first
          : await call("artifact_read", {
              artifact: artifact.id,
              offset: position,
              limit: 65536,
            });
      const b = Buffer.from(p.data, "base64");
      if (
        (!b.length && artifact.bytes !== 0) ||
        digest(b) !== p.chunkSha256 ||
        p.sha256 !== first.sha256
      )
        throw Error("Artifact integrity mismatch");
      const overlap = Math.min(b.length, Math.max(0, oldLength - position));
      const prefix = Buffer.alloc(overlap);
      if (
        overlap &&
        (await handle.read(prefix, 0, overlap, position)).bytesRead !== overlap
      )
        throw Error("Partial download differs");
      if (!prefix.equals(b.subarray(0, overlap)))
        throw Error("Partial download differs");
      if (overlap < b.length) await handle.writeFile(b.subarray(overlap));
      hash.update(b);
      position += b.length;
      if (p.nextOffset !== null && p.nextOffset !== position)
        throw Error("Invalid artifact cursor");
      await progress({
        artifact: artifact.id,
        sha256: first.sha256,
        verifiedBytes: position,
        totalBytes: artifact.bytes,
      });
      if (p.nextOffset === null) break;
    }
    if (
      oldLength > position ||
      position !== artifact.bytes ||
      hash.digest("hex") !== first.sha256
    )
      throw Error("Complete artifact mismatch");
  } finally {
    await handle.close();
  }
  const { link } = await import("node:fs/promises");
  await link(partial, target);
  await unlink(partial);
  return { artifact: artifact.id, sha256: first.sha256, bytes: position };
}
export async function runWorkflow(operation, options) {
  const journal = resolve(options.state || options.project + ".workflow.json");
  if (operation !== "resume") {
    if (!options.project) throw Error("--project required");
    const root = await realpath(options.project),
      rel = relative(root, journal);
    if (!rel.startsWith("../") && !isAbsolute(rel))
      throw Error("Workflow journal must be outside project inputs");
    const required = {
      prepare: ["profile", "metadata"],
      run: ["target"],
      deliver: ["run", "out"],
    }[operation];
    if (!required || required.some((k) => !options[k]))
      throw Error("Missing required workflow arguments");
  }
  const lock = await open(journal + ".lock", "wx");
  let client,
    state,
    active = null,
    interrupted = false;
  const stop = () => {
    interrupted = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const save = async () => {
    const temp = journal + ".tmp";
    await writeFile(temp, JSON.stringify(state, null, 2) + "\n");
    await rename(temp, journal);
  };
  try {
    if (operation === "resume") {
      state = await readJSON(journal);
      if (
        state.version !== 1 ||
        !["prepare", "run", "deliver"].includes(state.operation)
      )
        throw Error("Unsupported workflow journal");
      if (options.project && (await realpath(options.project)) !== state.root)
        throw Error("Journal project differs");
    } else {
      if (!["prepare", "run", "deliver"].includes(operation))
        throw Error("Expected prepare, run, deliver or resume");
      const root = await realpath(options.project);
      state = {
        version: 1,
        operation,
        root,
        options: { ...options, project: root },
        requests: {},
        results: {},
        projectIdentity: await stat(root).then((s) => ({
          dev: s.dev,
          ino: s.ino,
        })),
        logs: {},
        downloads: {},
        cache: process.env.CHIPSIM_MANUFACTURING_CACHE || null,
      };
      if (operation === "prepare")
        state.metadata = await readJSON(options.metadata);
      const h = await open(journal, "wx");
      await h.close();
      await save();
    }
    if ((await realpath(state.root)) !== state.root)
      throw Error("Project root identity changed");
    const rootStat = await stat(state.root);
    if (
      state.projectIdentity &&
      (state.projectIdentity.dev !== rootStat.dev ||
        state.projectIdentity.ino !== rootStat.ino)
    )
      throw Error("Project directory was replaced");
    const journalRelative = relative(state.root, journal);
    if (!journalRelative.startsWith("../") && !isAbsolute(journalRelative))
      throw Error("Workflow journal must be outside project inputs");
    state.logs ||= {};
    state.downloads ||= {};
    const installation = fileURLToPath(new URL("../../", import.meta.url));
    client = new Client(
      { name: "chipsim-workflow", version: "1" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(installation, "scripts/chipsim.mjs"),
        "mcp",
        "--project",
        state.root,
      ],
      env: {
        ...process.env,
        ...(Object.hasOwn(state, "cache")
          ? { CHIPSIM_MANUFACTURING_CACHE: state.cache || undefined }
          : {}),
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (b) => process.stderr.write(b));
    await client.connect(transport);
    const call = async (name, args = {}) => {
      const r = (
        await client.callTool(
          { name: "chipsim_" + name, arguments: args },
          undefined,
          { timeout: 60000 },
        )
      ).structuredContent;
      if (!r?.ok) throw Error(JSON.stringify(r?.error || r));
      return r.result;
    };
    const job = async (key, tool, args) => {
      state.requests[key] ||= randomUUID();
      await save();
      const accepted = await call(tool, {
        ...args,
        requestId: state.requests[key],
      });
      active = accepted.id;
      let cancellationRequested = false;
      for (;;) {
        if (interrupted && !cancellationRequested) {
          await call("job_cancel", { job: active });
          cancellationRequested = true;
        }
        const s = await call("job_status", { job: active, waitMs: 10000 });
        const logKey = s.id + ":" + s.generation;
        const log = (state.logs[logKey] ||= {
          cursor: 0,
          text: "",
          truncated: false,
        });
        let page;
        do {
          page = await call("job_logs", {
            job: s.id,
            offset: log.cursor,
            limit: 16384,
          });
          if (page.cursor < log.cursor)
            throw Error("Job log cursor moved backwards");
          log.cursor = page.cursor;
          const text = log.text + page.text;
          log.truncated ||= text.length > 16384;
          log.text = text.slice(-16384);
          await save();
        } while (page.nextOffset !== null);
        state.results[key] = s;
        await save();
        if (
          ["completed", "failed", "cancelled", "interrupted"].includes(s.state)
        ) {
          active = null;
          if (s.state !== "completed" || !s.ready)
            throw Error(
              "Job requires inspection or explicit retry: " + JSON.stringify(s),
            );
          return s;
        }
      }
    };
    const o = state.options;
    if (state.operation === "prepare") {
      const environment = await job("setup", "environment_setup", {
        profile: o.profile,
      });
      if (interrupted) throw Error("Interrupted before bootstrap");
      if (!state.results.bootstrap) {
        state.requests.bootstrap ||= randomUUID();
        state.bootstrapPending = true;
        await save();
        state.results.bootstrap = await call("project_bootstrap", {
          requestId: state.requests.bootstrap,
          profile: o.profile,
          environment: environment.run,
          metadata: state.metadata,
        });
        state.bootstrapPending = false;
        await save();
      }
    } else if (state.operation === "run") {
      if (!state.requests.run) await call("validate", { target: o.target });
      await job("run", "job_start", { target: o.target, reuse: false });
    } else {
      const ready = await call("release_status", { run: o.run });
      if (!ready.ready)
        throw Error("Release blocked: " + JSON.stringify(ready.blockers));
      const packaged = await job("package", "release_package", { run: o.run });
      const out = resolve(o.out);
      await mkdir(out, { recursive: true });
      const artifacts = [];
      let offset = 0;
      do {
        const p = await call("artifacts", {
          run: packaged.run,
          offset,
          limit: 200,
        });
        artifacts.push(...p.items);
        offset = p.nextOffset;
      } while (offset !== null);
      for (const name of [
        "submission.zip",
        "evidence.zip",
        "release-manifest.json",
        "SHA256SUMS",
        "archive-validation.xml",
      ]) {
        if (interrupted)
          throw Error(
            "Interrupted during downloads; resume with the same journal",
          );
        const a = artifacts.find((a) => a.path === name);
        if (!a) throw Error("Missing artifact: " + name);
        const result = await downloadArtifact(
          call,
          a,
          join(out, name),
          async (progress) => {
            state.downloads[name] = progress;
            await save();
          },
          () => interrupted,
        );
        state.results[name] = result;
        await save();
      }
    }
    state.complete = true;
    await save();
    return state;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      await client?.close();
    } finally {
      await lock.close();
      await unlink(journal + ".lock");
    }
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [operation, ...args] = process.argv.slice(2),
    options = {};
  if (!operation || operation === "--help") {
    console.log(
      "workflow.mjs prepare --project DIR --profile ID --metadata FILE --state JOURNAL\nworkflow.mjs run --project DIR --target TARGET --state JOURNAL\nworkflow.mjs deliver --project DIR --run RUN --out DIR --state JOURNAL\nworkflow.mjs resume --state JOURNAL\nUse a new journal per operation. Requires installed MCP SDK. Setup explicitly installs pinned tools.",
    );
  } else {
    try {
      for (let i = 0; i < args.length; i += 2) {
        if (
          !/^--(project|profile|metadata|state|target|run|out)$/.test(
            args[i],
          ) ||
          !args[i + 1]
        )
          throw Error("Invalid arguments");
        options[args[i].slice(2)] = args[i + 1];
      }
      if (!options.state && !options.project)
        throw Error("Supply --state or --project");
      console.log(
        JSON.stringify(await runWorkflow(operation, options), null, 2),
      );
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    }
  }
}
