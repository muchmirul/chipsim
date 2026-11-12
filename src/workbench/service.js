import { realpath, lstat, readFile } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDesign, planDesign } from "../design/project.js";
import { Store, localPath, json } from "../design/store.js";
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
  const uri = (kind, id, candidate) =>
    `chipsim://project/${kind}/${encodeURIComponent(id)}${candidate ? "?candidate=" + candidate : ""}`;
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
      const active = await candidateRoot(root, args.candidate),
        store = new Store(active);
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
    if (name === "project") {
      let config, diagnostic;
      try {
        config = (await loadDesign(active)).config;
      } catch (e) {
        diagnostic = e.message;
      }
      const current = await revision(active);
      return {
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
    if (name === "candidate_create") return createCandidate(root, a.label);
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
    if (name === "job_status")
      return a.waitMs
        ? waitJob(store, a.job, { timeoutMs: a.waitMs, signal })
        : jobStatus(store, a.job);
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
          resource: uri("artifacts", r.id, a.candidate),
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
  async function resource(value) {
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
      if (!["candidate", "offset", "limit"].includes(key))
        throw new Error("Unknown resource parameter");
      args[key] = key === "candidate" ? val : Number(val);
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
