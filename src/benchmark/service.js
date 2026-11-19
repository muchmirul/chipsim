import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { realpath, readdir, readFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
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
import { safePath, problem } from "../workbench/files.js";

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
    candidateHash: inputs.find(
      (i) => i.path === "assets/" + definition.candidate,
    ).sha256,
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
    Buffer.from(content).toString() !== content
  )
    throw problem(
      "INVALID_ARGUMENTS",
      "Expected a UTF-8 candidate of up to 64 KiB",
      {
        retryable: false,
      },
    );
  if (hash(content) !== candidateHash)
    throw problem(
      "CANDIDATE_HASH_MISMATCH",
      "Candidate bytes do not match candidateHash",
      {
        retryable: false,
      },
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

// Derive proof diagnostics from the verified native run, not an optimizer penalty
// or an EQY FAIL marker alone (EQY also writes FAIL for an exhausted strategy).
async function proofSummary(store, run, declaration) {
  const snapshot = await store.get(run.snapshot, "input-snapshot");
  const required = run.readiness.required || [];
  const declarations = required.filter(({ name }) => {
    const [task, check] = name.split(":");
    const adapter = snapshot.config.tasks[task]?.adapter;
    return (
      (adapter === "eqy" && check === "equivalence") ||
      (adapter === "sby" && check === "formal")
    );
  });
  // Weighted workflows put their proof in the evaluation target rather than a separate stage.
  if (!declaration && !declarations.length) return undefined;
  const proofs = await Promise.all(
    declarations
      .filter((r) => r.check && run.checks.includes(r.check))
      .map((r) => store.get(r.check, "check")),
  );
  const diagnostics = [],
    statuses = new Map(),
    traces = [],
    failed = new Set();
  for (const id of run.artifacts) {
    const a = await store.get(id, "artifact");
    const task = a.producer.task;
    const proof = proofs.find(
      (p) =>
        p.subject.task === task && p.producer.attempt === a.producer.attempt,
    );
    if (!proof || a.producer.job !== run.job) continue;
    const path = a.path;
    if (
      !/(?:^|\/)(?:PASS|FAIL|ERROR|UNKNOWN|status|trace[^/]*\.(?:vcd|yw)|tool\.log|execution\.json)$/.test(
        path,
      )
    )
      continue;
    const ref = { task, path, artifact: id };
    if (path.endsWith("/status") && a.payload.bytes <= 128) {
      ref.status = (await readFile(store.blobPath(a.payload.sha256), "utf8"))
        .trim()
        .split(/\s+/, 1)[0];
      statuses.set(`${task}:${dirname(path)}`, ref.status);
    }
    if (path.endsWith("/FAIL") && proof.evidence.includes(id)) failed.add(task);
    if (a.payload.bytes && /(?:^|\/)trace[^/]*\.(?:vcd|yw)$/.test(path))
      traces.push({ ref, proof });
    diagnostics.push(ref);
  }
  const witness = traces.find(({ ref, proof }) =>
    proof.name === "equivalence"
      ? failed.has(ref.task) &&
        statuses.get(`${ref.task}:${dirname(ref.path)}`) === "FAIL"
      : proof.context?.tasks?.some(
          (t) =>
            ["prove", "bmc"].includes(t.mode) &&
            t.verdict === "FAIL" &&
            t.counterexamples.includes(ref.path),
        ),
  );
  const proven =
    run.readiness.ready &&
    proofs.length > 0 &&
    proofs.length === declarations.length &&
    proofs.every((p) => p.verdict === "pass");
  // Bound the summary; the complete native inventory is available via artifacts({run, benchmarkJob}).
  diagnostics.sort(
    (a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path),
  );
  function priority(ref) {
    if (ref === witness?.ref) return 0;
    if (/\/(FAIL|ERROR)$/.test(ref.path) || ref.status === "FAIL") return 1;
    if (/\.(vcd|yw)$/.test(ref.path) || ref.path === "tool.log") return 2;
    return 3;
  }
  return {
    ...declaration,
    required: true,
    status: proven ? "proven" : "not-proven",
    verdict: proven ? "proven" : witness ? "counterexample" : "not-proven",
    run: run.id,
    diagnostics: diagnostics.slice(0, 32),
  };
}

async function verifiedBenchmark(store, job) {
  const state = await jobStatus(store, job);
  const details = { job, state: state.state, retryable: false };
  const unavailable = (message) =>
    problem("BENCHMARK_UNAVAILABLE", message, details);
  if (state.target !== target) throw unavailable("Not a benchmark job");
  if (["accepted", "queued", "running"].includes(state.state))
    throw problem("BENCHMARK_PENDING", "Benchmark is still " + state.state, {
      ...details,
      retryable: true,
    });
  if (!["completed", "failed"].includes(state.state) || !state.run)
    throw unavailable("Benchmark measurement unavailable: " + state.state);
  const run = await verifyEvidence(store, state.run);
  const snapshot = await store.get(run.snapshot, "input-snapshot");
  const binding = snapshot.config.benchmark;
  if (
    run.job !== job ||
    run.target !== target ||
    run.state !== state.state ||
    !binding
  )
    throw unavailable("Benchmark run identity mismatch");
  const context = await store.get(binding.context, "benchmark-context");
  for (const id of run.artifacts) {
    const a = await store.get(id, "artifact");
    if (
      a.kind !== "benchmark-result" ||
      a.path !== "result.json" ||
      a.producer.job !== job ||
      a.producer.task !== "evaluate"
    )
      continue;
    const report = await json(store.blobPath(a.payload.sha256));
    if (report.candidate !== "rtl-" + binding.candidateHash)
      throw unavailable("Benchmark report belongs to another candidate");
    if (
      !report.evidence?.run ||
      (!context.weighted && !report.report_evidence?.artifact)
    )
      throw unavailable("Benchmark has no captured stage or report evidence");
    const nestedRoot = join(
      store.root,
      "jobs",
      job,
      "work",
      a.producer.attempt,
      ".chipsim",
      "benchmark",
      "attempts",
    );
    const directory = await realpath(report.evidence.project);
    if (
      dirname(directory) !== nestedRoot ||
      !/^[a-f0-9-]{36}$/.test(relative(nestedRoot, directory))
    )
      throw unavailable("Benchmark evidence outside measured workspace");
    const nested = new Store(directory),
      runs = new Map();
    const seen = new Set(),
      blobs = new Set();
    async function verify(ref) {
      if (ref.project !== directory)
        throw unavailable("Benchmark stage project mismatch");
      if (!runs.has(ref.run)) {
        await verifyEvidence(nested, ref.run, seen, blobs);
        runs.set(ref.run, await nested.get(ref.run, "run"));
      }
      const r = runs.get(ref.run);
      if (
        r.job !== ref.job ||
        (ref.artifact && !r.artifacts.includes(ref.artifact))
      )
        throw unavailable("Benchmark stage producer mismatch");
      return r;
    }
    const evidenceRun = await verify(report.evidence);
    if (report.report_evidence) await verify(report.report_evidence);
    const stages = {};
    for (const [name, ref] of Object.entries(report.stages || {})) {
      if (!ref.run) continue;
      const r = await verify(ref);
      if (r.target !== name)
        throw unavailable("Benchmark stage target mismatch");
      stages[name] = {
        job: r.job,
        run: r.id,
        state: r.state,
        ready: r.readiness.ready,
      };
    }
    const recipe = context.definition.formal;
    const required = context.formal || recipe?.required;
    let formal = report.formal;
    const proofRun = stages[recipe?.target]?.run;
    if (context.weighted) {
      formal = await proofSummary(nested, evidenceRun);
    } else if (required && proofRun) {
      formal = await proofSummary(nested, runs.get(proofRun), {
        ...formal,
        required: true,
      });
    } else if (formal) {
      formal = { ...formal, verdict: "not-run", diagnostics: [] };
    }
    const proofMissing =
      (required || formal?.required) && formal?.verdict !== "proven";
    // A prior scored behavior mismatch does not need a proof to be a rejection.
    // Passing samples followed by missing or failed required proof is diagnostic only.
    const measured =
      run.state === "completed" &&
      run.readiness.ready &&
      ["passed", "failed"].includes(report.status) &&
      !(
        proofMissing &&
        (context.weighted || proofRun || report.status === "passed")
      );
    const metrics = { ...report.metrics };
    if (!measured) delete metrics.combined_score;
    const result = {
      ...binding,
      job,
      jobState: run.state,
      run: run.id,
      artifact: id,
      measured,
      accepted:
        measured &&
        report.status === "passed" &&
        !proofMissing &&
        evidenceRun.readiness.ready,
      score: measured ? metrics.combined_score : null,
      metrics,
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
      formal,
      evidence: { ...report.evidence, benchmarkJob: job },
      ...(report.report_evidence && {
        reportEvidence: { ...report.report_evidence, benchmarkJob: job },
      }),
      stages,
    };
    return { result, runs, directory };
  }
  throw unavailable("Missing captured benchmark result");
}

export async function benchmarkResult(store, job) {
  return (await verifiedBenchmark(store, job)).result;
}

export async function benchmarkInspectionProject(store, job, name, args) {
  const { result, directory, runs } = await verifiedBenchmark(store, job);
  if (name === "artifacts") {
    // Without an explicit stage default to the selected evidence run, never the whole store.
    args.run ??= result.evidence.run;
    if (runs.has(args.run)) return directory;
  } else {
    const id = args.artifact || args.id;
    for (const r of runs.values()) {
      if (
        r.artifacts.includes(id) ||
        (name === "evidence" &&
          (r.id === id || r.checks.includes(id) || r.attempts.includes(id)))
      )
        return directory;
    }
  }
  throw problem(
    "BENCHMARK_SCOPE",
    "Evidence does not belong to the requested benchmark stages",
  );
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
