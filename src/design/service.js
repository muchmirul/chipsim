import { loadDesign, planDesign } from "./project.js";
import { listJobs, evaluateChecks } from "./jobs.js";
import { verifyEvidence } from "./evidence.js";

export async function projectSummary(
  path,
  {
    freshness = true,
    target,
    latestOnly = false,
    runId,
    targetPlans = new Map(),
  } = {},
) {
  const { config, store } = await loadDesign(path);
  if (target && !config.targets[target])
    throw new Error("Unknown target " + target);
  const jobs = await listJobs(store),
    runs = (await store.list("run"))
      .sort((a, b) => (b.created || "").localeCompare(a.created || ""))
      .filter((r) => (runId ? r.id === runId : !target || r.target === target));
  const errors = [];
  if (latestOnly) runs.splice(1);
  if (freshness)
    for (const targetName of target ? [target] : Object.keys(config.targets)) {
      try {
        targetPlans.set(
          targetName,
          (await planDesign(path, targetName, { capture: false, probe: false }))
            .plan,
        );
      } catch (e) {
        errors.push(targetName + ": " + e.message);
      }
    }
  const summaries = [];
  for (const run of runs) {
    let valid = true,
      error;
    try {
      await verifyEvidence(store, run.id);
    } catch (e) {
      valid = false;
      error = e.message;
    }
    let stale = run.provenance === "unknown" ? "unknown" : false;
    const tasks = [];
    if (run.plan && valid) {
      const old = await store.get(run.plan, "execution-plan"),
        current = targetPlans.get(run.target);
      const changed = new Set();
      for (const task of old.tasks) {
        const now = current?.tasks.find((t) => t.task === task.task);
        const outdated =
          freshness &&
          (!now ||
            now.fingerprint !== task.fingerprint ||
            task.needs.some((d) => changed.has(d)));
        if (outdated) changed.add(task.task);
        tasks.push({ task: task.task, stale: outdated });
      }
      stale = freshness && (!current || tasks.some((t) => t.stale));
    }
    summaries.push({ ...run, valid, error, stale, taskFreshness: tasks });
  }
  return {
    project: { id: config.id, name: config.name },
    targets: Object.keys(config.targets),
    jobs: jobs.filter((j) => !target || j.target === target),
    runs: summaries,
    errors,
  };
}

export async function checksForTarget(path, target, runId, existingSummary) {
  const { config, store } = await loadDesign(path);
  if (!config.targets[target]) throw new Error("Unknown target " + target);
  const summary =
    existingSummary ||
    (await projectSummary(path, { target, latestOnly: !runId, runId }));
  const run = runId
    ? summary.runs.find((r) => r.id === runId)
    : summary.runs.find((r) => r.target === target);
  if (run && run.target !== target)
    throw new Error("Selected run belongs to target " + run.target);
  if (runId && !run) throw new Error("Unknown run " + runId);
  if (!run?.plan)
    return {
      ready: false,
      reason: "No captured run for target",
      required: (config.targets[target]?.requiredChecks || []).map((name) => ({
        name,
        verdict: "missing",
      })),
    };
  if (!run.valid)
    return {
      ready: false,
      run: run.id,
      reason: run.error,
      required: (config.targets[target].requiredChecks || []).map((name) => ({
        name,
        verdict: "invalid",
      })),
    };
  const plan = await store.get(run.plan, "execution-plan");
  const attempts = await Promise.all(
    run.attempts.map((id) => store.get(id, "attempt")),
  );
  const currentPolicy = config.targets[run.target];
  if (!currentPolicy) return { ready: false, reason: "Target was removed" };
  const evaluated = await evaluateChecks(
    store,
    { ...plan, policy: currentPolicy },
    attempts,
  );
  for (const required of evaluated.required) {
    const task = required.name.slice(0, required.name.indexOf(":"));
    if (run.taskFreshness.find((t) => t.task === task)?.stale)
      required.verdict = "stale";
    if (!run.valid) required.verdict = "invalid";
  }
  return {
    ...evaluated,
    run: run.id,
    ready:
      run.valid &&
      run.state === "completed" &&
      evaluated.required.length > 0 &&
      evaluated.required.every((r) => r.verdict === "pass"),
  };
}

// Compact agent control-loop state, scoped to one target. In particular, no
// version command is executed and no input snapshot is published by this query.
export async function targetStatus(path, target) {
  const { root, config } = await loadDesign(path),
    targetPlans = new Map();
  const summary = await projectSummary(path, {
    target,
    latestOnly: true,
    targetPlans,
  });
  const checks = await checksForTarget(path, target, undefined, summary);
  const plan = targetPlans.get(target),
    latestRun = summary.runs[0],
    latestJob = summary.jobs[0];
  const active = summary.jobs.filter((j) =>
    ["accepted", "queued", "running"].includes(j.state),
  );
  const args = ["--project", root],
    selection = [...args, "--target", target];
  const actions = [];
  for (const job of active.slice(0, 10))
    actions.push({
      reason: "Wait briefly for the accepted job; timeout does not cancel it",
      args: [
        "job",
        "status",
        job.id,
        ...args,
        "--wait",
        "--timeout-ms",
        "1000",
      ],
    });
  if (!active.length && !checks.ready)
    actions.push({
      reason: summary.errors.length
        ? "Inspect project inputs, locks and tool availability"
        : "Run the current target after reviewing its configuration",
      args: ["design", summary.errors.length ? "doctor" : "run", ...selection],
    });
  if (latestJob)
    actions.push({
      reason: "Inspect job diagnostics",
      args: ["job", "logs", latestJob.id, ...args],
    });
  actions.push({
    reason: "Inspect check scope and exact evidence",
    args: ["checks", ...selection],
  });
  const compactJob = (j) =>
    j && {
      id: j.id,
      state: j.state,
      generation: j.generation,
      run: j.run,
      ready: j.ready,
      tasks: j.tasks,
      error: j.error,
    };
  return {
    project: { ...summary.project, root },
    target,
    targets: Object.keys(config.targets),
    ready: checks.ready,
    required: checks.required,
    reason: checks.reason,
    errors: summary.errors,
    latestJob: compactJob(latestJob),
    activeJobs: active.slice(0, 10).map(compactJob),
    activeJobCount: active.length,
    latestRun: latestRun && {
      id: latestRun.id,
      state: latestRun.state,
      valid: latestRun.valid,
      stale: latestRun.stale,
      error: latestRun.error,
    },
    tasks: (plan?.tasks || []).map((t) => ({
      task: t.task,
      adapter: t.definition.adapter,
      needs: t.needs,
      inputs: t.inputs.length,
      fingerprint: t.fingerprint,
      stale:
        latestRun?.taskFreshness.find((f) => f.task === t.task)?.stale ?? null,
      tools: t.tools.map(({ command, path, available, version }) => ({
        command,
        path,
        available,
        version,
      })),
    })),
    actions,
  };
}

export async function compareRuns(store, left, right) {
  const a = await verifyEvidence(store, left),
    b = await verifyEvidence(store, right);
  if (a.format !== "chipsim-run" || b.format !== "chipsim-run")
    throw new Error("Comparison requires two run IDs");
  const leftArtifacts = await Promise.all(
    a.artifacts.map((id) => store.get(id, "artifact")),
  );
  const rightArtifacts = await Promise.all(
    b.artifacts.map((id) => store.get(id, "artifact")),
  );
  const key = (artifact) =>
    (artifact.producer?.task || "import") + ":" + artifact.path;
  const rows = [];
  for (const path of new Set([...leftArtifacts, ...rightArtifacts].map(key))) {
    const l = leftArtifacts.find((a) => key(a) === path),
      r = rightArtifacts.find((a) => key(a) === path);
    rows.push({
      path,
      left: l?.id,
      right: r?.id,
      change: !l
        ? "added"
        : !r
          ? "removed"
          : l.payload.sha256 === r.payload.sha256
            ? "identical"
            : "changed",
      contexts: [l?.context, r?.context],
    });
  }
  return {
    left,
    right,
    artifacts: rows,
    scope:
      "Artifact byte identity; timing metrics require matching units, stage, corner and constraints.",
  };
}
