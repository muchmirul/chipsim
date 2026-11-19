import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { realpath, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Store, hash, identity, json } from "../design/store.js";
import {
  startCapturedJob,
  jobStatus,
  listJobs,
  cancelJob,
  waitJob,
} from "../design/jobs.js";
import { verifyEvidence } from "../design/evidence.js";
import { runtimeIdentity, toolIdentity } from "../design/project.js";
import { safePath } from "../workbench/files.js";

const run = promisify(execFile);
const runner = fileURLToPath(new URL("./runner.py", import.meta.url));
const target = "benchmark-evaluate";

export async function prepareBenchmark(root, { benchmark, formal = false }) {
  if (!["alu8", "counter"].includes(benchmark)) await safePath(root, benchmark);
  const { stdout } = await run(
    "python3",
    ["-B", runner, "prepare", root, benchmark, String(formal)],
    { maxBuffer: 2 ** 20, timeout: 30000 },
  );
  const { definition, assets, weighted, evaluator } = JSON.parse(stdout);
  const store = new Store(root);
  const inputs = [];
  for (const file of definition.files) {
    const source = await safePath(assets, file);
    const payload = await store.putFile(source);
    if (definition.sha256 && definition.sha256[file] !== payload.sha256)
      throw new Error("Benchmark input changed during preparation");
    inputs.push({ path: "assets/" + file, ...payload });
  }
  const context = await store.put("benchmark-context", {
    definition,
    weighted,
    formal,
    evaluator,
    inputs,
    runtime: await runtimeIdentity(),
  });
  const prefix = ["alu8", "counter"].includes(benchmark)
    ? ""
    : relative(root, assets);
  return {
    context: context.id,
    candidatePath: join(prefix, definition.candidate),
    fixedHashes: Object.fromEntries(
      inputs
        .filter((i) => i.path !== "assets/" + definition.candidate)
        .map((i) => [join(prefix, i.path.slice(7)), i.sha256]),
    ),
  };
}

export function startBenchmark(root, args) {
  const { requestId, content, candidateHash, context } = args;
  if (
    Buffer.byteLength(content) > 65536 ||
    content.includes("\0") ||
    hash(content) !== candidateHash ||
    Buffer.from(content).toString() !== content
  )
    throw new Error(
      "Expected UTF-8 candidate of up to 64 KiB matching candidateHash",
    );
  const store = new Store(root);
  return startCapturedJob(root, target, {
    requestId,
    reuse: false,
    requestKey: identity({ context, candidateHash }),
    prepare: async () => {
      const frozen = await store.get(context, "benchmark-context");
      const runtime = await runtimeIdentity();
      if (identity(runtime) !== identity(frozen.runtime))
        throw new Error("ChipSim changed since benchmark preparation");
      const settings = {
        definition: frozen.definition,
        evaluator: frozen.evaluator,
        weighted: frozen.weighted,
        formal: frozen.formal,
      };
      const inputs = [
        ...frozen.inputs,
        {
          path: "proposal.rtl",
          ...(await store.putBytes(Buffer.from(content))),
        },
        {
          path: "benchmark.json",
          ...(await store.putBytes(Buffer.from(JSON.stringify(settings)))),
        },
      ];
      const definition = {
        adapter: "command",
        options: {
          command: "python3",
          args: ["-B", runner, "evaluate", process.execPath],
        },
        timeoutMs: ((frozen.definition.timeout || 300) + 30) * 1000,
        outputs: [{ path: "result.json", kind: "benchmark-result" }],
      };
      const config = {
        id: target,
        tasks: { evaluate: definition },
        benchmark: { context, candidateHash, requestId },
      };
      const snapshot = await store.put("input-snapshot", {
        config,
        inputs,
        runtime,
        lock: {},
      });
      const base = {
        task: "evaluate",
        definition,
        profile: {},
        inputs,
        tools: [await toolIdentity("python3", ["--version"])],
        dependencies: [],
        runtime,
      };
      const plan = await store.put("execution-plan", {
        projectId: target,
        target,
        snapshot: snapshot.id,
        policy: {
          tasks: ["evaluate"],
          requiredChecks: ["evaluate:execution", "evaluate:outputs"],
        },
        tasks: [{ ...base, needs: [], fingerprint: identity(base) }],
      });
      return { root, store, snapshot, plan };
    },
  });
}

export async function benchmarkResult(store, job) {
  const state = await jobStatus(store, job);
  if (state.target !== target || state.state !== "completed" || !state.ready)
    throw new Error("Benchmark measurement unavailable: " + state.state);
  const run = await verifyEvidence(store, state.run);
  const snapshot = await store.get(run.snapshot, "input-snapshot");
  const binding = snapshot.config.benchmark;
  if (run.job !== job || !binding)
    throw new Error("Benchmark run identity mismatch");
  for (const id of run.artifacts) {
    const a = await store.get(id, "artifact");
    if (
      a.kind !== "benchmark-result" ||
      a.producer.job !== job ||
      a.producer.task !== "evaluate"
    )
      continue;
    const report = await json(store.blobPath(a.payload.sha256));
    const workspace = join(store.root, "jobs", job, "work", a.producer.attempt);
    const nestedRoot = await realpath(
      join(workspace, ".chipsim", "benchmark", "attempts"),
    );
    const records = [
      ...Object.values(report.stages || {}),
      report.report_evidence,
      report.evidence,
    ].filter((r) => r?.run);
    if (!report.evidence?.run || !records.length)
      throw new Error("Benchmark has no measured stage evidence");
    const seen = new Set(),
      blobs = new Set();
    for (const ref of records) {
      const directory = await realpath(ref.project);
      if (!directory.startsWith(nestedRoot + "/"))
        throw new Error("Benchmark evidence outside measured workspace");
      const nested = new Store(directory);
      await verifyEvidence(nested, ref.run, seen, blobs);
      const nativeRun = await nested.get(ref.run, "run");
      if (
        nativeRun.job !== ref.job ||
        (ref.artifact && !nativeRun.artifacts.includes(ref.artifact))
      )
        throw new Error("Benchmark stage producer mismatch");
    }
    return {
      ...binding,
      job,
      run: run.id,
      artifact: id,
      accepted: report.status === "passed",
      score: report.metrics.combined_score,
      metrics: report.metrics,
      units: report.metric_units || {
        [report.objective.metric]: report.objective.unit,
      },
      feedback: [
        report.message,
        ...(report.diagnostics || []).map((d) => d.message),
        ...(report.cases || []).slice(0, 2).map((c) => JSON.stringify(c)),
      ]
        .join("\n")
        .slice(0, 4000),
      formal: report.formal,
      evidence: { ...report.evidence, benchmarkJob: job },
      stages: Object.fromEntries(
        Object.entries(report.stages || {}).map(([name, record]) => [
          name,
          { run: record.run, ready: record.ready },
        ]),
      ),
    };
  }
  throw new Error("Missing captured benchmark result");
}

// Nested stage workers are durable and can outlive their Python caller.
export async function stopBenchmarkStages(workspace) {
  if (!workspace) return;
  const dir = join(workspace, ".chipsim", "benchmark", "attempts");
  const entries = await readdir(dir, { withFileTypes: true }).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const nested = new Store(join(dir, entry.name));
    for (const job of await listJobs(nested)) {
      if (["accepted", "queued", "running"].includes(job.state)) {
        await cancelJob(nested, job.id);
        await waitJob(nested, job.id);
      }
    }
  }
}
