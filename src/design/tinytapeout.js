import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, readFile } from "node:fs/promises";
import { json, fileDigest } from "./store.js";
import { execute } from "./process.js";
import { parseXunit } from "./xunit.js";

export function validateTinyTapeout(task) {
  if (task.adapter !== "tinytapeout") return;
  const o = task.options || {};
  if (o.pdk !== "ihp-sg13cmos5l")
    throw new Error(
      "Tiny Tapeout adapter currently requires explicit ihp-sg13cmos5l PDK",
    );
  if (
    !o.pdkRoot ||
    !o.python ||
    !o.precheckPython ||
    !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(o.image || "")
  )
    throw new Error(
      "Tiny Tapeout requires python, precheckPython, pdkRoot and immutable container image digest",
    );
  for (const key of ["templateRevision", "supportRevision", "pdkRevision"])
    if (!/^[a-f0-9]{40}$/.test(o[key] || ""))
      throw new Error("Tiny Tapeout requires pinned " + key);
  if (!o.librelaneVersion || typeof o.librelaneVersion !== "string")
    throw new Error("Tiny Tapeout requires librelaneVersion");
  if (
    (task.checks || []).some((c) =>
      ["timing", "drc", "lvs", "precheck"].includes(c.name),
    )
  )
    throw new Error("Tiny Tapeout physical check names are reserved");
}
export function requireTinyTapeoutLock(task, dependencies) {
  if (task.adapter !== "tinytapeout") return;
  if (
    !dependencies.some((d) => resolve(d.path) === resolve(task.options.pdkRoot))
  )
    throw new Error(
      "Tiny Tapeout PDK directory must be inventoried in chipsim.lock.json for this task",
    );
}
export async function executeTinyTapeout(task, context) {
  const o = task.definition.options;
  await writeFile(
    join(context.workspace, "chipsim-tinytapeout-request.json"),
    JSON.stringify({
      ...o,
      fingerprint: task.fingerprint,
      dependencies: task.dependencies,
    }),
  );
  return execute(
    task.tools[0].path,
    [
      fileURLToPath(
        new URL("../../scripts/tinytapeout-run.py", import.meta.url),
      ),
    ],
    {
      ...context,
      cwd: context.workspace,
      timeoutMs: task.definition.timeoutMs || 3600000,
      env: {
        ...task.profile.env,
        ...o.env,
        PATH: [dirname(task.tools[0].path), process.env.PATH].join(":"),
        PDK: o.pdk,
        PDK_ROOT: o.pdkRoot,
        LIBRELANE_TAG: o.librelaneVersion,
        LIBRELANE_IMAGE_OVERRIDE: o.image,
        CI: "1",
      },
    },
  );
}
export async function tinyTapeoutChecks(task, workspace, execution) {
  const results = [],
    o = task.definition.options;
  let report, error;
  try {
    report = await json(join(workspace, "out/physical.json"));
    for (const source of report.sources) {
      const { localPath } = await import("./store.js");
      const actual = await fileDigest(join(workspace, localPath(source.path)));
      if (source.sha256 !== actual.sha256 || source.bytes !== actual.bytes)
        throw new Error(
          "Native physical report changed after normalization: " + source.path,
        );
    }
    if (
      !report.sources.some((s) => s.path === "runs/wokwi/final/metrics.json") ||
      !report.sources.some((s) => s.path === "runs/wokwi/resolved.json")
    )
      throw new Error("Missing native metrics or resolved configuration");
  } catch (e) {
    error = e.message;
  }
  const groups = {
    timing: ["timing__setup_vio__count", "timing__hold_vio__count"],
    drc: ["klayout__drc_error__count"],
    lvs: ["design__lvs_error__count"],
  };
  for (const [name, fields] of Object.entries(groups)) {
    const metrics = fields.map((field) => ({
      field,
      observed: report?.metrics?.[field] ?? null,
      operator: "eq",
      value: 0,
      unit: "count",
    }));
    const valid =
      !error &&
      (name !== "timing" ||
        (report?.sources?.some((s) => s.path.endsWith(".sdc")) &&
          Array.isArray(report?.corners) &&
          report.corners.length > 0)) &&
      metrics.every((m) => Number.isSafeInteger(m.observed) && m.observed >= 0);
    if (name === "timing") {
      for (const field of ["timing__setup__ws", "timing__hold__ws"])
        metrics.push({
          field,
          observed: Number.isFinite(report?.metrics?.[field])
            ? report.metrics[field]
            : null,
          unit: "ns",
        });
    }
    const violated = metrics.some((m) => m.operator === "eq" && m.observed > 0);
    results.push({
      name,
      verdict:
        valid && violated
          ? "fail"
          : valid && execution.ok
            ? "pass"
            : "inconclusive",
      metrics,
      scope:
        name === "timing"
          ? "Zero setup/hold violations across the final LibreLane reported corner set and captured constraints; not a protocol proof"
          : `Zero reported ${name.toUpperCase()} errors in the pinned final LibreLane flow and rule deck`,
      diagnostic:
        error ||
        (!valid
          ? "Required finite count metric is absent"
          : !execution.ok
            ? "Physical execution did not complete"
            : undefined),
      assumptions: [],
      evidence: [
        "out/physical.json",
        ...(report?.sources || []).map((s) => s.path),
      ],
      context: {
        stage: "final",
        pdk: o.pdk,
        image: o.image,
        pdkRevision: o.pdkRevision,
        corners: report?.corners,
        units: { time: "ns", area: "um^2", count: "count" },
        dependencies: task.dependencies,
        constraints:
          report?.sources?.filter((s) => s.path.endsWith(".sdc")) || [],
      },
    });
  }
  results.push({
    name: "physical-metrics",
    verdict:
      !error &&
      execution.ok &&
      Number.isFinite(report?.metrics?.design__instance__area__stdcell)
        ? "pass"
        : "inconclusive",
    scope:
      "Measured final standard-cell area and cell count in the pinned physical flow; no optimization threshold or aggregate score",
    assumptions: [],
    evidence: [
      "out/physical.json",
      ...(report?.sources || []).map((s) => s.path),
    ],
    context: {
      stage: "final",
      pdk: o.pdk,
      image: o.image,
      dependencies: task.dependencies,
    },
    metrics: [
      {
        field: "design__instance__area__stdcell",
        observed: report?.metrics?.design__instance__area__stdcell ?? null,
        unit: "um^2",
      },
      {
        field: "design__instance__count__stdcell",
        observed: report?.metrics?.design__instance__count__stdcell ?? null,
        unit: "count",
      },
    ],
  });
  const precheck = {
    name: "precheck",
    verdict: "inconclusive",
    scope:
      "All native Tiny Tapeout precheck cases for the packaged layout and pinned technology",
    assumptions: [],
    evidence: ["tt/precheck/reports/results.xml"],
    context: { supportRevision: o.supportRevision, pdkRevision: o.pdkRevision },
  };
  try {
    const source = join(workspace, "tt/precheck/reports/results.xml");
    const digest = await fileDigest(source);
    if (digest.bytes > 8 * 1048576)
      throw new Error("Precheck report exceeds 8 MiB");
    const cases = parseXunit(await readFile(source, "utf8"));
    precheck.metrics = {
      cases: cases.length,
      failed: cases.filter((c) => c.verdict === "fail").length,
      skipped: cases.filter((c) => c.verdict === "inconclusive").length,
    };
    precheck.verdict = precheck.metrics.failed
      ? "fail"
      : execution.ok && !precheck.metrics.skipped
        ? "pass"
        : "inconclusive";
  } catch (e) {
    precheck.diagnostic = e.message;
  }
  results.push(precheck);
  return results;
}
