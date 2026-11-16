import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, stat, open } from "node:fs/promises";
import { execute } from "../design/process.js";
import { dockerEnvironment } from "./docker.js";
import { parseXunit } from "../design/xunit.js";
import { localPath } from "../design/store.js";

export function validateVerification(task) {
  if (task.adapter !== "tinytapeout-verify") return;
  const o = task.options || {};
  if (
    !["rtl", "gate", "synthesis"].includes(o.operation) ||
    !/^tt_um_[A-Za-z0-9_]+$/.test(o.top || "") ||
    !/^ghcr\.io\/librelane\/librelane@sha256:[a-f0-9]{64}$/.test(
      o.image || "",
    ) ||
    !o.python ||
    !o.pdkRoot
  )
    throw new Error(
      "Tiny Tapeout verification requires an explicit operation, top, pinned container, Python and PDK",
    );
  if (
    !Array.isArray(o.sources) ||
    o.sources.length > 512 ||
    (o.operation !== "gate" && !o.sources.length)
  )
    throw new Error("Declare the RTL source inventory");
  for (const source of o.sources) {
    localPath(source);
    if (!/^[A-Za-z0-9_./-]+\.(v|sv)$/.test(source))
      throw new Error("Unsupported Verilog source spelling");
  }
  if ((task.checks || []).some((c) => ["tests", "synthesis"].includes(c.name)))
    throw new Error("Native verification check names are reserved");
}

export async function executeVerification(task, context) {
  const request = join(context.workspace, "verification-request.json");
  await writeFile(request, JSON.stringify(task.definition.options));
  const logStart = await stat(context.log)
    .then((s) => s.size)
    .catch(() => 0);
  const result = await execute(
    task.tools[0].path,
    [
      fileURLToPath(
        new URL("../../scripts/manufacturing-verify.py", import.meta.url),
      ),
      request,
    ],
    {
      ...context,
      cwd: context.workspace,
      timeoutMs: task.definition.timeoutMs || 120000,
      env: {
        ...(await dockerEnvironment(context)),
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  const checks = await verificationChecks(task, context.workspace, result);
  if (result.ok && checks.every((c) => c.verdict === "pass")) return result;
  const handle = await open(context.log, "r");
  let excerpt;
  try {
    const end = (await handle.stat()).size,
      start = Math.max(logStart, end - 16384);
    const buffer = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    excerpt = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const failure = verificationFailure(task, result, checks, excerpt);
  return { ...result, ok: false, diagnostic: failure.message, failure };
}
export function verificationFailure(task, execution, checks, excerpt) {
  const failed = checks
    .flatMap((c) => c.cases || [])
    .filter((c) => c.verdict === "fail");
  const native = excerpt
    .split(/\r?\n/)
    .find((s) => /FATAL:|ERROR:|assertion.*fail/i.test(s));
  const reports = checks.filter((c) => c.diagnostic).map((c) => c.diagnostic);
  const message = (
    native ||
    failed[0]?.message ||
    reports[0] ||
    execution.reason ||
    "Native process failed"
  ).slice(0, 2000);
  const location = /(?:FATAL:|ERROR:)\s+(.+?):(\d+):/.exec(message);
  return {
    category:
      execution.reason === "timeout"
        ? "timeout"
        : execution.reason === "cancelled"
          ? "cancelled"
          : failed.length || /FATAL:|assertion/i.test(message)
            ? "assertion"
            : execution.ok
              ? "report"
              : "execution",
    stage: task.definition.options.operation,
    exitStatus: execution.code ?? null,
    message,
    testCase: failed.length === 1 ? failed[0].name : null,
    failedCases: failed.map((c) => ({
      name: c.name,
      message: c.message || null,
    })),
    source: location ? { path: location[1], line: Number(location[2]) } : null,
    excerpt,
    reportDiagnostics: reports,
  };
}
export async function verificationChecks(task, workspace, execution) {
  const synthesis = task.definition.options.operation === "synthesis";
  const record = {
    name: synthesis ? "synthesis" : "tests",
    verdict: "inconclusive",
    scope: synthesis
      ? "Yosys synthesis and explicit Tiny Tapeout top-level port contract"
      : "Executed project test cases; does not establish completeness of the authored specification",
    evidence: [synthesis ? "synthesis.json" : "results.xml", "acceptance.json"],
    assumptions: [],
  };
  try {
    if (synthesis) {
      const graph = JSON.parse(
        await readFile(join(workspace, "synthesis.json"), "utf8"),
      );
      const ports = graph.modules[task.definition.options.top]?.ports;
      const contract = {
        clk: ["input", 1],
        rst_n: ["input", 1],
        ena: ["input", 1],
        ui_in: ["input", 8],
        uio_in: ["input", 8],
        uo_out: ["output", 8],
        uio_out: ["output", 8],
        uio_oe: ["output", 8],
      };
      if (
        !ports ||
        Object.keys(ports).length !== Object.keys(contract).length ||
        Object.entries(contract).some(
          ([key, [direction, width]]) =>
            ports[key]?.direction !== direction ||
            ports[key]?.bits?.length !== width,
        )
      )
        throw new Error(
          "Synthesized top-level interface differs from the manufacturing contract",
        );
      record.verdict = execution.ok ? "pass" : "fail";
    } else {
      const expected = JSON.parse(
        await readFile(join(workspace, "acceptance.json"), "utf8"),
      ).cases;
      if (
        !Array.isArray(expected) ||
        !expected.length ||
        expected.length > 1024 ||
        expected.some((s) => typeof s !== "string" || !s.trim()) ||
        new Set(expected).size !== expected.length
      )
        throw new Error("Declare 1–1024 unique acceptance case names");
      record.expectedCases = expected;
      record.missingCases = null; // Unknown until a complete report parses.
      const cases = parseXunit(
        await readFile(join(workspace, "results.xml"), "utf8"),
      );
      record.cases = cases;
      record.expectedCases = expected;
      record.missingCases = expected.filter(
        (name) => !cases.some((c) => c.name === name),
      );
      if (
        cases.length !== expected.length ||
        new Set(cases.map((c) => c.name)).size !== expected.length ||
        cases.some((c) => !expected.includes(c.name))
      )
        throw new Error(
          "Executed test cases differ from declared acceptance cases",
        );
      record.metrics = {
        cases: cases.length,
        failed: cases.filter((c) => c.verdict === "fail").length,
        skipped: cases.filter((c) => c.verdict === "inconclusive").length,
      };
      record.verdict =
        record.metrics.failed || !execution.ok
          ? "fail"
          : record.metrics.skipped
            ? "inconclusive"
            : "pass";
    }
  } catch (e) {
    record.diagnostic = e.message;
  }
  return [record];
}
