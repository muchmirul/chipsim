import { loadDesign, planDesign } from "./project.js";
import { listJobs, evaluateChecks } from "./jobs.js";
import { verifyEvidence } from "./evidence.js";
import { identity } from "./store.js";
import { summarizeRequirementEvidence } from "../manufacturing/coverage.js";

function graphIdentity(plan) {
  if (!plan) return null;
  return identity(
    plan.tasks
      .map(({ task, fingerprint, needs }) => ({
        task,
        fingerprint,
        needs: [...needs].sort(),
      }))
      .sort((a, b) => a.task.localeCompare(b.task)),
  );
}

export async function projectSummary(
  path,
  {
    freshness = true,
    recoverJobs = true,
    target,
    latestOnly = false,
    runId,
    targetPlans = new Map(),
  } = {},
) {
  const { config, store } = await loadDesign(path);
  if (target && !config.targets[target])
    throw new Error("Unknown target " + target);
  const jobs = await listJobs(store, { recover: recoverJobs }),
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
    let comparison;
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
        const dependenciesChanged =
          now &&
          identity([...now.needs].sort()) !== identity([...task.needs].sort());
        const reason = !now
          ? "removed"
          : dependenciesChanged
            ? "dependencies"
            : now.fingerprint !== task.fingerprint
              ? "fingerprint"
              : outdated
                ? "upstream"
                : null;
        if (freshness && reason) changed.add(task.task);
        tasks.push({
          task: task.task,
          stale: freshness && !!reason,
          ...(freshness && reason ? { reason } : {}),
        });
      }
      if (freshness) {
        const captured = new Set(old.tasks.map((t) => t.task));
        for (const task of current?.tasks || [])
          if (!captured.has(task.task))
            tasks.push({ task: task.task, stale: true, reason: "added" });
        comparison = {
          capturedGraph: graphIdentity(old),
          currentGraph: graphIdentity(current),
          capturedPolicy: identity(old.policy),
          currentPolicy: current ? identity(current.policy) : null,
        };
        stale =
          !current || comparison.capturedGraph !== comparison.currentGraph;
      }
    }
    summaries.push({
      ...run,
      valid,
      error,
      stale,
      comparison,
      taskFreshness: tasks,
    });
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
      requirementCoverage: summarizeRequirementEvidence(null, []),
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
      requirementCoverage: summarizeRequirementEvidence(null, []),
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
  const evaluated = await evaluateChecks(store, plan, attempts, {
    policy: config.targets[target],
    requirements: config.engineering?.requirements ?? [],
  });
  for (const required of evaluated.required) {
    const task = required.name.slice(0, required.name.indexOf(":"));
    if (run.taskFreshness.find((t) => t.task === task)?.stale)
      required.verdict = "stale";
    if (!run.valid) required.verdict = "invalid";
  }
  return {
    ...evaluated,
    comparison: run.comparison,
    changes: run.taskFreshness.filter((t) => t.stale),
    ...(run.stale
      ? { reason: "Target execution graph changed", reasonCode: "STALE_PLAN" }
      : {}),
    run: run.id,
    ready:
      evaluated.ready &&
      run.valid &&
      run.stale === false &&
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
      ...(j.diagnostics?.length ? { diagnostics: j.diagnostics } : {}),
      error: j.error,
    };
  return {
    project: { ...summary.project, root },
    target,
    targets: Object.keys(config.targets),
    ready: checks.ready,
    requirementCoverage: checks.requirementCoverage,
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

function hasReportedContext(context) {
  const hasValue = (value) => {
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean") return true;
    return value !== null && typeof value === "object"
      ? Object.values(value).some(hasValue)
      : false;
  };
  return (
    context !== null &&
    typeof context === "object" &&
    !Array.isArray(context) &&
    hasValue(context)
  );
}

export async function compareRuns(store, left, right, rightStore = store) {
  const a = await verifyEvidence(store, left),
    b = await verifyEvidence(rightStore, right);
  if (a.format !== "chipsim-run" || b.format !== "chipsim-run")
    throw new Error("Comparison requires two run IDs");
  const leftArtifacts = await Promise.all(
    a.artifacts.map((id) => store.get(id, "artifact")),
  );
  const rightArtifacts = await Promise.all(
    b.artifacts.map((id) => rightStore.get(id, "artifact")),
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
  const leftChecks = await Promise.all(
    (a.checks || []).map((id) => store.get(id, "check")),
  );
  const rightChecks = await Promise.all(
    (b.checks || []).map((id) => rightStore.get(id, "check")),
  );
  const checkKey = (c) => c.subject.task + ":" + c.name;
  const checks = [
    ...new Set([...leftChecks, ...rightChecks].map(checkKey)),
  ].map((key) => {
    const l = leftChecks.find((c) => checkKey(c) === key),
      r = rightChecks.find((c) => checkKey(c) === key);
    const sameContext =
      hasReportedContext(l?.context) &&
      hasReportedContext(r?.context) &&
      identity({ context: l.context, scope: l.scope }) ===
        identity({ context: r.context, scope: r.scope });
    return {
      name: key,
      left: l
        ? {
            id: l.id,
            verdict: l.verdict,
            metrics: l.metrics,
            scope: l.scope,
            context: l.context,
          }
        : null,
      right: r
        ? {
            id: r.id,
            verdict: r.verdict,
            metrics: r.metrics,
            scope: r.scope,
            context: r.context,
          }
        : null,
      matchingReportedContext: sameContext,
      metrics:
        Array.isArray(l?.metrics) && Array.isArray(r?.metrics)
          ? l.metrics.map((m) => {
              const n = r.metrics.find(
                (n) => n.field === m.field && n.unit === m.unit,
              );
              const comparable =
                sameContext &&
                !!m.unit &&
                !!n &&
                Number.isFinite(m.observed) &&
                Number.isFinite(n.observed);
              return {
                field: m.field,
                unit: m.unit || null,
                left: m.observed ?? null,
                right: n?.observed ?? null,
                comparable,
                delta: comparable ? n.observed - m.observed : null,
              };
            })
          : [],
    };
  });
  const snapshots = await Promise.all(
    [
      [store, a],
      [rightStore, b],
    ].map(([s, r]) =>
      r.snapshot ? s.get(r.snapshot, "input-snapshot") : null,
    ),
  );
  const roles = Object.fromEntries(
    ["hardware", "program", "tests", "constraints"].map((role) => {
      const inventories = snapshots.map((s) => {
        const declared = s?.config.engineering?.roles?.[role];
        if (!declared?.length) return null;
        const selected = declared.map((path) =>
          s.inputs.find((f) => f.path === path),
        );
        return selected.every(Boolean)
          ? selected
              .map(({ path, sha256 }) => ({ path, sha256 }))
              .sort((a, b) => a.path.localeCompare(b.path))
          : null;
      });
      return [
        role,
        {
          left: inventories[0],
          right: inventories[1],
          identical: inventories.every(Boolean)
            ? identity(inventories[0]) === identity(inventories[1])
            : null,
        },
      ];
    }),
  );
  return {
    left,
    right,
    artifacts: rows,
    checks,
    roles,
    scope:
      "Verified artifact identity and named check metrics. Numeric deltas require explicit matching units and reported contexts; no aggregate score or inferred whole-design equivalence. Missing role inputs are unknown.",
  };
}
