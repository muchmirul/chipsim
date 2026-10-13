import { join } from "node:path";
import { json, localPath, fileDigest } from "./store.js";

export const physicalReportFile = "chipsim-physical-reports.json";

export function validatePhysicalReports(task) {
  const reports = task.options?.reports;
  if (reports === undefined) return;
  if (
    task.adapter !== "orfs" ||
    !reports ||
    typeof reports !== "object" ||
    Array.isArray(reports)
  )
    throw new Error(
      "options.reports requires the orfs adapter and a reports object",
    );
  for (const [kind, spec] of Object.entries(reports)) {
    if (
      !["timing", "drc", "lvs"].includes(kind) ||
      !spec ||
      typeof spec !== "object"
    )
      throw new Error("Unknown physical report " + kind);
    localPath(spec.path);
    if (
      kind === "timing" &&
      (!Array.isArray(spec.metrics) ||
        !spec.metrics.length ||
        spec.metrics.length > 32 ||
        spec.metrics.some(
          (m) =>
            !m ||
            typeof m.field !== "string" ||
            !m.field ||
            !["eq", "lte", "gte"].includes(m.operator) ||
            !Number.isFinite(m.value),
        ))
    )
      throw new Error(
        "Timing report requires 1–32 finite numeric metric comparisons",
      );
    if ((task.checks || []).some((c) => c.name === kind))
      throw new Error("Duplicate physical check name " + kind);
  }
}

const count = (n) => Number.isSafeInteger(n) && n >= 0;
export async function physicalChecks(
  task,
  workspace,
  execution,
  inputs = task.inputs,
) {
  const options = task.definition.options || {},
    reports = options.reports || {};
  const context = {
    ...options.context,
    constraints: inputs
      .filter((i) => i.path.endsWith(".sdc"))
      .map(({ path, sha256, artifact }) => ({
        path,
        sha256,
        ...(artifact ? { artifact } : {}),
      })),
  };
  const results = [];
  for (const [kind, spec] of Object.entries(reports)) {
    const record = {
      name: kind,
      verdict: "inconclusive",
      scope:
        spec.scope ||
        (kind === "timing"
          ? "Declared numeric timing criteria for reported paths, stage, corner and units"
          : kind === "drc"
            ? "Zero items in the selected KLayout DRC report and rule deck"
            : "Exact matches in the selected KLayout LVS comparison, including subordinate pairs"),
      assumptions: spec.assumptions || [],
      evidence: [spec.path],
      context,
    };
    try {
      if (kind === "timing") {
        if (
          !context.stage ||
          !context.corner ||
          !context.units?.time ||
          !context.constraints.length
        )
          throw new Error(
            "Timing checks require stage, corner, time units and captured SDC constraints",
          );
        const data = await json(join(workspace, localPath(spec.path)));
        record.metrics = spec.metrics.map((m) => ({
          ...m,
          observed: data[m.field] ?? null,
        }));
        if (
          record.metrics.some(
            (m) =>
              typeof m.observed !== "number" || !Number.isFinite(m.observed),
          )
        )
          throw new Error("Timing report is missing a finite numeric metric");
        record.verdict = record.metrics.every((m) =>
          m.operator === "eq"
            ? m.observed === m.value
            : m.operator === "gte"
              ? m.observed >= m.value
              : m.observed <= m.value,
        )
          ? "pass"
          : "fail";
      } else {
        record.evidence.push(physicalReportFile);
        const data = await json(join(workspace, physicalReportFile));
        if (data.format !== "chipsim-klayout-reports" || data.version !== 1)
          throw new Error("Invalid KLayout report summary");
        const r = data.reports?.[kind];
        if (!r || r.error)
          throw new Error(r?.error || "Native report was not read");
        const digest = await fileDigest(join(workspace, localPath(spec.path)));
        if (r.sha256 !== digest.sha256 || r.bytes !== digest.bytes)
          throw new Error("Native report changed after normalization");
        if (kind === "drc") {
          if (!count(r.items) || !count(r.categories) || !r.categories)
            throw new Error(
              "DRC report has no rule categories or invalid counts",
            );
          record.metrics = { items: r.items, categories: r.categories };
          record.verdict = r.items === 0 ? "pass" : "fail";
        } else {
          const names = [
            "Match",
            "MatchWithWarning",
            "Mismatch",
            "NoMatch",
            "Skipped",
            "None",
            "Unknown",
          ];
          if (
            !count(r.circuits) ||
            !r.circuits ||
            !count(r.extractionErrors) ||
            names.some((n) => !count(r.statuses?.[n]))
          )
            throw new Error(
              "LVS report has no compared circuits or invalid counts",
            );
          record.metrics = {
            circuits: r.circuits,
            statuses: r.statuses,
            extractionErrors: r.extractionErrors,
          };
          record.verdict =
            r.statuses.Mismatch || r.statuses.NoMatch || r.extractionErrors
              ? "fail"
              : r.statuses.Match >= r.circuits &&
                  names.slice(1).every((n) => r.statuses[n] === 0)
                ? "pass"
                : "inconclusive";
        }
      }
      if (!execution.ok && record.verdict === "pass")
        record.verdict = "inconclusive";
    } catch (e) {
      record.diagnostic = e.message;
    }
    results.push(record);
  }
  return results;
}
