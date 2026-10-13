import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  physicalChecks,
  validatePhysicalReports,
  physicalReportFile,
} from "../src/design/physical.js";
import { fileDigest } from "../src/design/store.js";
import { mcpResult } from "../src/design/mcp-result.js";

test("timing checks retain stage, corner, constraints, thresholds and missing coverage", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-timing-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const task = {
    inputs: [{ path: "design.sdc", sha256: "captured" }],
    definition: {
      adapter: "orfs",
      options: {
        context: { stage: "finish", corner: "typical", units: { time: "ns" } },
        reports: {
          timing: {
            path: "metrics.json",
            metrics: [
              { field: "finish__ws", operator: "gte", value: 0 },
              { field: "finish__hold", operator: "eq", value: 0 },
            ],
          },
        },
      },
    },
  };
  validatePhysicalReports(task.definition);
  const check = async () =>
    (await physicalChecks(task, workspace, { ok: true }))[0];
  await writeFile(
    join(workspace, "metrics.json"),
    JSON.stringify({ finish__ws: 0.25, finish__hold: 0 }),
  );
  const pass = await check();
  assert.equal(pass.verdict, "pass");
  assert.deepEqual(pass.context.constraints, task.inputs);
  assert.equal(pass.metrics[0].observed, 0.25);
  for (const [report, verdict] of [
    [{ finish__ws: -0.01, finish__hold: 0 }, "fail"],
    [{ finish__ws: 3, finish__hold: 1 }, "fail"],
    [{ finish__ws: "3", finish__hold: 0 }, "inconclusive"],
    [{ finish__hold: 0 }, "inconclusive"],
  ]) {
    await writeFile(join(workspace, "metrics.json"), JSON.stringify(report));
    assert.equal((await check()).verdict, verdict);
  }
  await writeFile(
    join(workspace, "metrics.json"),
    '{"finish__ws":1,"finish__hold":0}',
  );
  assert.equal(
    (await physicalChecks(task, workspace, { ok: false }))[0].verdict,
    "inconclusive",
  );
  delete task.definition.options.context.units;
  assert.match((await check()).diagnostic, /time units/);
  assert.throws(
    () =>
      validatePhysicalReports({
        ...task.definition,
        checks: [{ name: "timing" }],
      }),
    /Duplicate/,
  );
});

test("native physical summaries require intact reports, rule coverage and exact LVS matches", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "chipsim-physical-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const task = {
    inputs: [],
    definition: {
      options: {
        reports: {
          drc: { path: "layout.lyrdb" },
          lvs: { path: "layout.lvsdb" },
        },
      },
    },
  };
  await writeFile(join(workspace, "layout.lyrdb"), "native DRC bytes");
  await writeFile(join(workspace, "layout.lvsdb"), "native LVS bytes");
  const summary = {
    format: "chipsim-klayout-reports",
    version: 1,
    reports: {
      drc: {
        ...(await fileDigest(join(workspace, "layout.lyrdb"))),
        items: 0,
        categories: 3,
      },
      lvs: {
        ...(await fileDigest(join(workspace, "layout.lvsdb"))),
        circuits: 1,
        extractionErrors: 0,
        statuses: {
          Match: 5,
          MatchWithWarning: 0,
          Mismatch: 0,
          NoMatch: 0,
          Skipped: 0,
          None: 0,
          Unknown: 0,
        },
      },
    },
  };
  const check = async () => {
    await writeFile(
      join(workspace, physicalReportFile),
      JSON.stringify(summary),
    );
    return (await physicalChecks(task, workspace, { ok: true })).map(
      (c) => c.verdict,
    );
  };
  assert.deepEqual(await check(), ["pass", "pass"]);
  summary.reports.drc.items = 2;
  summary.reports.lvs.statuses.Mismatch = 1;
  assert.deepEqual(await check(), ["fail", "fail"]);
  summary.reports.drc.items = 0;
  summary.reports.drc.categories = 0;
  summary.reports.lvs.statuses.Mismatch = 0;
  summary.reports.lvs.statuses.MatchWithWarning = 1;
  assert.deepEqual(await check(), ["inconclusive", "inconclusive"]);
  summary.reports.drc.categories = 3;
  summary.reports.lvs.statuses.MatchWithWarning = 0;
  await writeFile(join(workspace, "layout.lyrdb"), "changed bytes");
  summary.reports.lvs.circuits = 0;
  assert.deepEqual(await check(), ["inconclusive", "inconclusive"]);
  await rm(join(workspace, "layout.lvsdb"));
  assert.deepEqual(await check(), ["inconclusive", "inconclusive"]);
});

test("OpenROAD-MCP errors inside JSON and incomplete responses cannot pass", () => {
  const response = (payload) => ({
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });
  assert.equal(
    mcpResult(response({ error: null, output: "ok" })).verdict,
    "pass",
  );
  assert.equal(
    mcpResult(response({ error: "CommandBlocked" })).verdict,
    "fail",
  );
  assert.equal(
    mcpResult(response({ error: null, truncated: true })).verdict,
    "inconclusive",
  );
  assert.equal(mcpResult(response({ output: "ok" })).verdict, "inconclusive");
  assert.equal(mcpResult({ result: { isError: true } }).verdict, "fail");
  assert.equal(
    mcpResult({ error: { message: "JSON-RPC failure" } }).verdict,
    "fail",
  );
  assert.equal(
    mcpResult({ result: { structuredContent: { error: "native error" } } })
      .verdict,
    "fail",
  );
});
