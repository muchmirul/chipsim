import { receiveEvidence } from "./evidence-import.js";
import { artifactReader } from "./artifact-transfer.js";
import { workflowStatus } from "./workflow.js";
import metadata from "../../package.json" with { type: "json" };
import { realpath, lstat, readFile, open } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDesign,
  planDesign,
  orderTasks,
  executable,
} from "../design/project.js";
import { Store, localPath, json, hash } from "../design/store.js";
import {
  startJob,
  jobStatus,
  waitJob,
  jobLogs,
  cancelJob,
  retryJob,
} from "../design/jobs.js";
import {
  publishedArtifacts,
  inspectArtifact,
  verifyEvidence,
  exportEvidence,
} from "../design/evidence.js";
import { checksForTarget, compareRuns } from "../design/service.js";
import { adapters } from "../design/adapters.js";
import { workbenchTools, validate } from "./schema.js";
import { agentDocumentation } from "../agent/discovery.js";
import {
  fileList,
  fileSearch,
  readText,
  writeText,
  revision,
  candidateRoot,
  createCandidate,
  listCandidates,
  candidateDiff,
  applyCandidate,
  safePath,
  problem,
  withProjectLock,
} from "./files.js";
import {
  inspectModel,
  graphWindow,
  traceWindow,
  page,
  schematicLines,
} from "./inspect.js";

export const guidePath = fileURLToPath(
  new URL("../../docs/WORKBENCH_MCP.md", import.meta.url),
);
const guides = {
  connections: "AGENT_CONNECTIONS.md",
  quickstart: "AGENT_QUICKSTART.md",
  control: "AGENT_CONTROL.md",
  native: "AGENT_EXTENSIONS.md",
  workbench: "WORKBENCH_MCP.md",
  design: "DESIGN.md",
  inputs: "DESIGN_INPUTS.md",
  hdl: "HDL.md",
  debug: "HDL_DEBUG.md",
  physical: "TINYTAPEOUT.md",
  manufacturing: "MANUFACTURING.md",
  reliability: "MCP_RELIABILITY.md",
  evolution: "EVOLUTION.md",
  "evolution-objectives": "EVOLUTION_OBJECTIVES.md",
  circuit: "CONNECTED_CIRCUITS.md",
};
const starterFiles = [
  "README.md",
  "chipsim.design.json",
  "chipsim.lock.json",
  "contract.json",
  "engine.sv",
  "engine_tb.sv",
  "program.json",
  "second-program.json",
  "sim.project.json",
  "synthesis.ys",
];
export const workbenchResources = [
  ...agentDocumentation.map((name) => ({
    uri: "chipsim://docs/" + name,
    name,
    mimeType: "text/markdown",
  })),
  ...Object.entries(guides).map(([topic, file]) => ({
    uri: "chipsim://guide/" + topic,
    name: file,
    mimeType: "text/markdown",
  })),
  ...starterFiles.map((file) => ({
    uri: "chipsim://examples/programmable/" + file,
    name: "Programmable starter / " + file,
    mimeType: "text/plain",
  })),
  {
    uri: "chipsim://guide/recipes",
    name: "Design input recipes",
    mimeType: "application/json",
  },
];
const envelope = (result) => ({
  format: "chipsim-workbench-result",
  version: 1,
  ok: true,
  result,
});
export const textPage = (text, offset = 0, limit = 16384) => {
  const points = Array.from(text);
  return {
    text: points.slice(offset, offset + limit).join(""),
    offset,
    total: points.length,
    nextOffset: offset + limit < points.length ? offset + limit : null,
  };
};
const planSummary = ({ plan, snapshot }) => ({
  plan: plan.id || null,
  snapshot: snapshot.id,
  target: plan.target,
  policy: plan.policy,
  tasks: plan.tasks.map((t) => ({
    task: t.task,
    fingerprint: t.fingerprint,
    needs: t.needs,
    tools: t.tools,
    inputs: t.inputs.map(({ path, sha256, generated }) => ({
      path,
      sha256,
      generated,
    })),
  })),
});
export async function createWorkbench(path) {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory())
    throw new Error("--project requires an existing project directory");
  const readArtifact = artifactReader();
  const uri = (kind, id, candidate, benchmarkJob) => {
    const args = new URLSearchParams();
    if (candidate) args.set("candidate", candidate);
    if (benchmarkJob) args.set("benchmarkJob", benchmarkJob);
    return `chipsim://project/${kind}/${encodeURIComponent(id)}${args.size ? "?" + args : ""}`;
  };
  async function call(name, args = {}, { signal } = {}) {
    try {
      const tool = workbenchTools.find((t) => t.name === name);
      if (!tool)
        throw problem("UNKNOWN_TOOL", "Unknown workbench tool: " + name);
      try {
        validate(tool.inputSchema, args);
      } catch (e) {
        throw problem("INVALID_ARGUMENTS", e.message);
      }
      let active = await candidateRoot(root, args.candidate);
      if (args.benchmarkJob) {
        const { benchmarkInspectionProject } = await import("../benchmark/service.js");
        args = { ...args };
        active = await benchmarkInspectionProject(
          new Store(active), args.benchmarkJob, name, args,
        );
      }
      const store = new Store(active);
      const output = await perform(name, args, active, store, signal);
      if (Buffer.byteLength(JSON.stringify(output)) > 524288)
        throw problem(
          "RESPONSE_LIMIT",
          "Response exceeds 512 KiB; use a narrower query or smaller page",
        );
      return envelope(output);
    } catch (e) {
      return {
        format: "chipsim-workbench-result",
        version: 1,
        ok: false,
        error: {
          code: e.code || "WORKBENCH_ERROR",
          message: e.message,
          ...(e.details ? { details: e.details } : {}),
        },
      };
    }
  }
  async function perform(name, a, active, store, signal) {
    if (name.startsWith("benchmark_")) {
      const { prepareBenchmark, startBenchmark, benchmarkResult } =
        await import("../benchmark/service.js");
      if (name === "benchmark_prepare") {
        const prepared = await prepareBenchmark(active, a);
        return {
          ...prepared,
          candidateResource: uri(
            "benchmark-baseline",
            prepared.context,
            a.candidate,
          ),
        };
      }
      if (name === "benchmark_start") return startBenchmark(active, a);
      return benchmarkResult(store, a.job);
    }
    if (
      [
        "manufacturing_profiles",
        "environment_setup",
        "project_bootstrap",
        "release_status",
        "release_package",
      ].includes(name)
    ) {
      const { manufacturingTool } = await import("../manufacturing/service.js");
      return manufacturingTool(active, name, a);
    }
    if (name === "evidence_import") return receiveEvidence(active, store, a);
    if (name === "environment_check") {
      const result = {
        adapters: Object.keys(adapters),
        targets: [],
        observer: await (await import("../hdl/debug/tools.js")).debugTools(),
      };
      if (a.target) {
        const { config } = await loadDesign(active);
        for (const id of orderTasks(config, a.target)) {
          const definition = config.tasks[id],
            profile = config.tools?.[definition.tool];
          const entry = { task: id, adapter: definition.adapter, tools: [] };
          try {
            const command = profile?.command || definition.options?.command;
            const commands = command
              ? [[command]]
              : await adapters[definition.adapter].tools(definition, active);
            for (const [command] of commands) {
              const path = await executable(command);
              entry.tools.push({
                command,
                path: path || null,
                available: !!path,
              });
            }
          } catch (error) {
            entry.diagnostic = error.message;
          }
          result.targets.push(entry);
        }
      }
      if (a.profile) {
        const { manufacturingProfile } =
          await import("../manufacturing/profiles.js");
        const p = await manufacturingProfile(a.profile);
        const { homedir } = await import("node:os");
        const cache = join(
          process.env.CHIPSIM_MANUFACTURING_CACHE ||
            join(homedir(), ".cache/chipsim/manufacturing"),
          p.digest,
        );
        result.cache = {
          profile: p.id,
          path: cache,
          present:
            (await lstat(cache).catch(() => null))?.isDirectory() || false,
        };
      }
      return result;
    }
    if (name === "artifact_read") return readArtifact(store, a);
    if (name === "workflow_status") return workflowStatus(active, a);
    if (name === "resource_read") return resource(a.uri, a.candidate);
    if (name === "project") {
      let config, diagnostic;
      try {
        config = (await loadDesign(active)).config;
      } catch (e) {
        diagnostic = e.message;
      }
      const current = await revision(active);
      return {
        serverVersion: metadata.version,
        toolInventorySha256: hash(JSON.stringify(workbenchTools)),
        root: active,
        candidate: a.candidate || null,
        id: config?.id,
        name: config?.name,
        engineering: config?.engineering || null,
        revision: current.id,
        fileCount: current.inputs.length,
        targets: config?.targets || {},
        diagnostic,
        capabilities: {
          adapters: Object.keys(adapters),
          fileEditing: "UTF-8/CAS",
          candidates: true,
          inspection: [
            "elaborated-rtl",
            "recorded-waveform",
            "synthesized-module-definitions",
          ],
          interactiveFrontend: "terminal",
          nextState:
            "Only explicit connected-circuit contracts support hypothetical evaluation; RTL/netlist queries are static or recorded",
        },
        guide: "chipsim://guide/workbench",
      };
    }
    if (name === "file_list") return fileList(active, a);
    if (name === "file_search") return fileSearch(active, a);
    if (name === "file_read") {
      const { text, ...meta } = await readText(active, a.path);
      return {
        ...meta,
        ...textPage(text, a.offset, a.limit),
        resource: uri("files", a.path, a.candidate),
      };
    }
    if (name === "file_write") return writeText(active, a);
    if (name === "candidate_create")
      return createCandidate(root, a.label, a.candidate, a.requestId);
    if (name === "candidate_list") return listCandidates(root, a.candidate, a);
    if (name === "candidate_diff") return candidateDiff(root, a);
    if (name === "candidate_apply") return applyCandidate(root, a);
    if (name === "revision") {
      const r = await withProjectLock(active, () =>
        revision(active, { capture: true }),
      );
      return { revision: r.id, fileCount: r.inputs.length };
    }
    if (name === "validate" || name === "plan")
      return withProjectLock(active, async () => ({
        valid: true,
        ...planSummary(
          await planDesign(active, a.target, {
            capture: name === "plan",
            probe: name === "plan",
          }),
        ),
      }));
    if (name === "job_start")
      return startJob(active, a.target, {
        requestId: a.requestId,
        reuse: a.reuse ?? true,
      });
    if (name === "job_status") {
      if (!!a.job === !!a.requestId)
        throw new Error("Specify exactly one of job or requestId");
      let id = a.job;
      if (a.requestId) {
        const { identity } = await import("../design/store.js");
        const binding = await json(
          join(store.root, "requests", identity(a.requestId) + ".json"),
        ).catch((e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
        if (!binding) return { state: "unknown" };
        id = binding.id;
      }
      return a.waitMs
        ? waitJob(store, id, { timeoutMs: a.waitMs, signal })
        : jobStatus(store, id);
    }
    if (name === "job_logs") return jobLogs(store, a.job, a);
    if (name === "job_cancel") return cancelJob(store, a.job);
    if (name === "job_retry") return retryJob(store, a.job);
    if (name === "artifacts") {
      const records = a.run
        ? await Promise.all(
            (await verifyEvidence(store, a.run)).artifacts.map((id) =>
              store.get(id, "artifact"),
            ),
          )
        : await publishedArtifacts(store);
      return page(
        records.map((r) => ({
          id: r.id,
          path: r.path,
          kind: r.kind,
          bytes: r.payload.bytes,
          snapshot: r.snapshot,
          resource: uri("artifacts", r.id, a.candidate, a.benchmarkJob),
        })),
        a.offset,
        a.limit,
      );
    }
    if (name === "evidence") return inspectArtifact(store, a.id, a);
    if (name === "checks") return checksForTarget(active, a.target, a.run);
    if (name === "compare")
      return compareRuns(
        new Store(await candidateRoot(root, a.leftCandidate || a.candidate)),
        a.left,
        a.right,
        new Store(await candidateRoot(root, a.rightCandidate || a.candidate)),
      );
    if (name === "differences") {
      const artifact = await verifyEvidence(store, a.artifact);
      if (artifact.format !== "chipsim-artifact")
        throw problem("UNSUPPORTED_ARTIFACT", "Expected comparison artifact");
      const report = await json(store.blobPath(artifact.payload.sha256));
      if (
        report.format !== "chipsim-hdl-comparison" ||
        report.version !== 1 ||
        !Array.isArray(report.differences)
      )
        throw problem(
          "UNSUPPORTED_ARTIFACT",
          "Expected version-1 mapped HDL comparison report",
        );
      const { differences, ...context } = report;
      return {
        artifact: a.artifact,
        ...context,
        ...page(differences, a.offset, a.limit),
      };
    }
    if (name === "export") {
      const destination = await safePath(active, a.destination, true);
      return {
        ...(await exportEvidence(store, a.id, destination)),
        destination,
      };
    }
    const model = await inspectModel(store, a.artifact);
    if (name === "hardware")
      return { artifact: a.artifact, ...graphWindow(model, a) };
    if (name === "trace")
      return { artifact: a.artifact, ...traceWindow(model, a) };
    if (name === "source") {
      const source = model.sources.find((s) => s.id === a.source);
      if (!source)
        throw problem(
          "UNKNOWN_SOURCE",
          "Source ID is not captured in this artifact",
        );
      let sourcePath = isAbsolute(source.path)
        ? relative(active, source.path)
        : source.path;
      if (model.artifact.snapshot) {
        const snapshot = await store.get(
            model.artifact.snapshot,
            "input-snapshot",
          ),
          task = snapshot.config?.tasks?.[model.artifact.producer?.task];
        // Recording paths are relative to the HDL manifest, not the design
        // root. Use the captured task, never the possibly edited live manifest.
        sourcePath = null;
        if (task?.adapter === "hdl" && !isAbsolute(source.path))
          try {
            sourcePath = join(
              dirname(localPath(task.options?.project)),
              localPath(source.path),
            );
          } catch {
            /* Source origins that cannot be mapped safely remain unknown. */
          }
        if (
          sourcePath &&
          !model.artifact.inputs?.some((input) => input.path === sourcePath)
        )
          sourcePath = null;
      }
      let current = null;
      try {
        if (sourcePath) current = (await readText(active, sourcePath)).sha256;
      } catch {
        /* absent or outside project */
      }
      return {
        artifact: a.artifact,
        source: source.id,
        path: source.path,
        currentPath: sourcePath,
        sha256: source.sha256,
        currentHash: current,
        stale: current === null ? "unknown" : current !== source.sha256,
        ...textPage(source.text, a.offset, a.limit),
      };
    }
    if (name === "snapshot") {
      const columns = a.columns ?? 120,
        rows = a.rows ?? 40,
        view = a.view ?? "schematic";
      let text,
        command = null;
      if (model.recording) {
        const { TuiState } = await import("../tui/state.js");
        const { screenText } = await import("../tui/render.js");
        const { selectDebugObject } = await import("../tui/debug-state.js");
        const state = new TuiState();
        await state.loadDebugFile(
          store.blobPath(model.artifact.payload.sha256),
        );
        if ((a.at ?? 0) >= model.recording.data.events.length)
          throw problem("EVENT_RANGE", "Event index outside capture");
        if (a.object && !model.recording.objects.has(a.object))
          throw problem("UNKNOWN_OBJECT", "Unknown object ID");
        state.seek(a.at ?? 0);
        if (a.object) selectDebugObject(state, a.object);
        state.setView(view);
        state.columns = columns;
        state.rows = rows;
        text = screenText(state, { color: false });
        command = [
          "chipsim",
          "--hdl-debug",
          store.blobPath(model.artifact.payload.sha256),
          "--at-event",
          String(a.at ?? 0),
          "--view",
          view,
        ];
      } else if (model.abstraction === "synthesized-module-definitions") {
        const { TuiState } = await import("../tui/state.js");
        const { screenText } = await import("../tui/render.js");
        const state = new TuiState();
        await state.loadNetlistFile(
          store.blobPath(model.artifact.payload.sha256),
        );
        if (a.object && !model.objects.some((o) => o.id === a.object))
          throw problem("UNKNOWN_OBJECT", "Unknown netlist object ID");
        state.netlistSelection = a.object || state.netlistSelection;
        state.columns = columns;
        state.rows = rows;
        text = screenText(state);
        command = [
          "chipsim",
          "--netlist",
          store.blobPath(model.artifact.payload.sha256),
        ];
      } else
        text = [
          model.abstraction,
          "Recorded waveform; use trace queries for values",
          ...schematicLines(model, { object: a.object, limit: rows - 2 }),
        ]
          .map((line) => line.slice(0, columns))
          .join("\n");
      return {
        artifact: a.artifact,
        text,
        command,
        columns,
        rows,
        abstraction: model.abstraction,
      };
    }
    throw problem("UNKNOWN_TOOL", name);
  }
  async function resource(value, candidate) {
    const parsed = new URL(value);
    if (parsed.protocol !== "chipsim:")
      throw new Error("Expected chipsim resource URI");
    if (
      parsed.host === "docs" &&
      agentDocumentation.includes(parsed.pathname.slice(1))
    )
      return {
        uri: value,
        mimeType: "text/markdown",
        text: await readFile(
          new URL("../../docs/" + parsed.pathname.slice(1), import.meta.url),
          "utf8",
        ),
      };
    if (parsed.host === "guide" && parsed.pathname === "/recipes") {
      const { designGuide } = await import("../design/guide.js");
      for (const key of parsed.searchParams.keys())
        if (key !== "topic") throw new Error("Unknown recipe parameter");
      const topic = parsed.searchParams.get("topic") || "overview";
      if (topic.length > 128) throw new Error("Recipe topic exceeds limit");
      return {
        uri: value,
        mimeType: "application/json",
        text: JSON.stringify(designGuide(topic)),
      };
    }
    if (
      parsed.host === "guide" &&
      Object.hasOwn(guides, parsed.pathname.slice(1))
    )
      return {
        uri: value,
        mimeType: "text/markdown",
        text: await readFile(
          new URL(
            "../../docs/" + guides[parsed.pathname.slice(1)],
            import.meta.url,
          ),
          "utf8",
        ),
      };
    if (
      parsed.host === "examples" &&
      parsed.pathname.startsWith("/programmable/")
    ) {
      const file = parsed.pathname.slice("/programmable/".length);
      if (!starterFiles.includes(file))
        throw new Error("Unknown starter resource");
      return {
        uri: value,
        mimeType: "text/plain",
        text: await readFile(
          new URL(
            "../../examples/workbench/programmable/" + file,
            import.meta.url,
          ),
          "utf8",
        ),
      };
    }
    if (parsed.host === "schema" && parsed.pathname === "/tools")
      return {
        uri: value,
        mimeType: "application/json",
        text: JSON.stringify(workbenchTools),
      };
    if (parsed.host !== "project")
      throw new Error("Unknown resource authority");
    const [kind, ...parts] = parsed.pathname.slice(1).split("/");
    const id = decodeURIComponent(parts.join("/"));
    const args = {};
    for (const [key, val] of parsed.searchParams) {
      if (!["candidate", "offset", "limit", "benchmarkJob"].includes(key))
        throw new Error("Unknown resource parameter");
      args[key] = ["candidate", "benchmarkJob"].includes(key)
        ? val
        : Number(val);
    }
    if (candidate && args.candidate && args.candidate !== candidate)
      throw problem(
        "CANDIDATE_CONFLICT",
        "Candidate argument and resource URI disagree",
      );
    if (candidate) args.candidate = candidate;
    if (kind === "benchmark-baseline") {
      const store = new Store(await candidateRoot(root, args.candidate));
      const context = await store.get(id, "benchmark-context");
      const entry = context.inputs.find(
        (e) => e.path === "assets/" + context.definition.candidate,
      );
      if (!entry || entry.bytes > 65536)
        throw Error("Invalid benchmark baseline");
      await store.verifyBlob(entry);
      return {
        uri: value,
        mimeType: "text/plain",
        text: await readFile(store.blobPath(entry.sha256), "utf8"),
      };
    }
    const response =
      kind === "files"
        ? await call("file_read", { ...args, path: localPath(id) })
        : kind === "artifacts"
          ? await call("evidence", { ...args, id })
          : id === "" && kind === "status"
            ? await call("project", args)
            : null;
    if (!response) throw new Error("Unknown resource");
    return {
      uri: value,
      mimeType: "application/json",
      text: JSON.stringify(response),
    };
  }
  return { root, call, resource, tools: workbenchTools };
}
