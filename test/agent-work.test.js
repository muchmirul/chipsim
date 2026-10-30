import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentCommand } from "../src/agent/commands.js";
import {
  startWork,
  appendWorkEvent,
  workStatus,
  listWork,
  workLimits,
} from "../src/agent/work.js";

async function temporary(t) {
  const project = await mkdtemp(join(tmpdir(), "chipsim-work-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}
const journal = (project, session) =>
  join(project, ".chipsim-agent", "work", session);
const save = (file, value) => writeFile(file, JSON.stringify(value));

test("work journals need only a local directory and reduce all candidate history, not just the displayed tail", async (t) => {
  const project = await temporary(t);
  assert.deepEqual(await listWork(project), []);
  assert.equal((await workStatus(project)).session, null);
  const session = await startWork(project, {
    goal: "Improve counter area without changing behavior",
    mode: "evolution",
  });
  assert.equal(session.reporting, "agent-reported");
  const first = await appendWorkEvent(project, session.id, {
    kind: "candidate",
    candidate: "baseline",
    generation: 0,
    stage: "RTL",
    message: "Baseline measured",
    metrics: { area: { value: 12, unit: "cells" } },
  });
  const original = await readFile(
    join(journal(project, session.id), "000001.json"),
    "utf8",
  );
  await appendWorkEvent(project, session.id, {
    kind: "candidate",
    candidate: "smaller",
    parent: "baseline",
    generation: 1,
    message: "Shared decode candidate",
    metrics: { area: { value: 9, unit: "cells" } },
  });
  await appendWorkEvent(project, session.id, {
    kind: "evaluation",
    candidate: "smaller",
    status: "passed",
    message: "Agent reports simulation passed",
    metrics: { delay: { value: 2.5, unit: "ns" } },
    evidence: {
      project: "other",
      job: randomUUID(),
      run: "a".repeat(64),
      artifact: "b".repeat(64),
    },
  });
  const status = await workStatus(project, { session: session.id, limit: 1 });
  assert.equal(status.totalEvents, 3);
  assert.equal(status.events.length, 1);
  assert.equal(status.session.status, "running");
  assert.equal(status.candidates.length, 2);
  const candidate = status.candidates.find((item) => item.id === "smaller");
  assert.equal(candidate.parent, "baseline");
  assert.equal(candidate.generation, 1);
  assert.equal(candidate.status, "passed");
  assert.equal(candidate.reporting, "agent-reported");
  assert.deepEqual(candidate.metrics, {
    area: { value: 9, unit: "cells" },
    delay: { value: 2.5, unit: "ns" },
  });
  assert.equal(candidate.evidence.project, resolve(project, "other"));
  assert.equal(status.events[0].reporting, "agent-reported");
  assert.equal(
    await readFile(join(journal(project, session.id), "000001.json"), "utf8"),
    original,
  );
  assert.equal(first.sequence, 1);
  await appendWorkEvent(project, session.id, {
    kind: "summary",
    status: "completed",
    message: "Selected smaller candidate; evidence still requires inspection",
  });
  assert.equal((await workStatus(project)).session.status, "completed");
  await assert.rejects(
    appendWorkEvent(project, session.id, {
      kind: "edit",
      message: "More work",
    }),
    { code: "WORK_CLOSED" },
  );
  const later = await startWork(project, { goal: "Review assumptions" });
  assert.equal(later.mode, "task");
  assert.equal((await listWork(project))[0].id, later.id);
  assert.equal((await workStatus(project)).session.id, later.id);
  assert.equal(
    (await workStatus(project, { session: session.id })).session.status,
    "completed",
  );
});

test("a repeated running candidate clears current measurements but preserves lineage and event history", async (t) => {
  const project = await temporary(t);
  const session = await startWork(project, {
    goal: "Re-evaluate the selected candidate",
    mode: "evolution",
  });
  await appendWorkEvent(project, session.id, {
    kind: "candidate",
    candidate: "stable-source-hash",
    parent: "baseline",
    generation: 2,
    status: "running",
    message: "Initial evaluation started",
  });
  const previousMetrics = {
    combined_score: { value: 1, unit: "score" },
    checks_passed: { value: 80, unit: "checks" },
    checks_total: { value: 80, unit: "checks" },
  };
  const previousEvidence = { job: randomUUID(), artifact: "a".repeat(64) };
  await appendWorkEvent(project, session.id, {
    kind: "evaluation",
    candidate: "stable-source-hash",
    status: "passed",
    message: "Initial evaluation passed",
    metrics: previousMetrics,
    evidence: previousEvidence,
  });
  const original = await readFile(
    join(journal(project, session.id), "000002.json"),
    "utf8",
  );
  await appendWorkEvent(project, session.id, {
    kind: "candidate",
    candidate: "stable-source-hash",
    status: "running",
    message: "Finalist re-evaluation started",
  });
  const running = (await workStatus(project, { limit: 1 })).candidates[0];
  assert.deepEqual(running.metrics, {});
  assert.equal(Object.hasOwn(running, "evidence"), false);
  assert.equal(running.status, "running");
  assert.equal(running.parent, "baseline");
  assert.equal(running.generation, 2);
  const currentEvidence = { job: randomUUID() };
  await appendWorkEvent(project, session.id, {
    kind: "tool",
    candidate: "stable-source-hash",
    status: "running",
    message: "Finalist job accepted",
    evidence: currentEvidence,
  });
  await appendWorkEvent(project, session.id, {
    kind: "evaluation",
    candidate: "stable-source-hash",
    status: "inconclusive",
    message: "Tool failed before measured checks",
    metrics: { combined_score: { value: 0, unit: "score" } },
  });
  const status = await workStatus(project);
  assert.deepEqual(status.candidates[0].metrics, {
    combined_score: { value: 0, unit: "score" },
  });
  assert.deepEqual(status.candidates[0].evidence, currentEvidence);
  assert.equal(status.candidates[0].status, "inconclusive");
  assert.equal(status.candidates[0].parent, "baseline");
  assert.equal(status.candidates[0].generation, 2);
  assert.deepEqual(status.events[1].metrics, previousMetrics);
  assert.deepEqual(status.events[1].evidence, previousEvidence);
  assert.equal(
    await readFile(join(journal(project, session.id), "000002.json"), "utf8"),
    original,
  );
});

test("concurrent events publish complete immutable JSON in a stable sequence", async (t) => {
  const project = await temporary(t);
  const session = await startWork(project, { goal: "Parallel evaluation" });
  const published = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      appendWorkEvent(project, session.id, {
        kind: "tool",
        message: `Worker ${index}`,
        candidate: `worker-${index}`,
      }),
    ),
  );
  assert.equal(new Set(published.map((event) => event.id)).size, 24);
  const status = await workStatus(project, { limit: 200 });
  assert.equal(status.totalEvents, 24);
  assert.deepEqual(
    status.events.map((event) => event.sequence),
    Array.from({ length: 24 }, (_, index) => index + 1),
  );
  assert.equal(
    (await readdir(journal(project, session.id))).filter((name) =>
      name.endsWith(".tmp"),
    ).length,
    0,
  );
  const endings = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      appendWorkEvent(project, session.id, {
        kind: "summary",
        status: "completed",
        message: "Closed",
      }),
    ),
  );
  assert.equal(
    endings.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.ok(
    endings
      .filter((result) => result.status === "rejected")
      .every((result) => result.reason.code === "WORK_CLOSED"),
  );
  assert.equal((await workStatus(project)).totalEvents, 25);
});

test("only terminal summary closes a session; failures and inconclusive evaluations remain progress", async (t) => {
  const project = await temporary(t);
  const session = await startWork(project, { goal: "Evaluate a failure" });
  for (const event of [
    { kind: "tool", status: "failed", message: "Compiler failed" },
    {
      kind: "evaluation",
      status: "completed",
      message: "Evaluation completed, not the task",
    },
    {
      kind: "summary",
      status: "inconclusive",
      message: "More evidence needed",
    },
  ]) {
    await appendWorkEvent(project, session.id, event);
    assert.equal((await workStatus(project)).session.status, "running");
  }
  await appendWorkEvent(project, session.id, {
    kind: "summary",
    status: "cancelled",
    message: "User cancelled task",
  });
  assert.equal((await workStatus(project)).session.status, "cancelled");
});

test("work events reject invalid and unknown fields without recording them", async (t) => {
  const project = await temporary(t);
  const session = await startWork(project, { goal: "Validate input" });
  const base = { kind: "plan", message: "Public next action" };
  for (const patch of [
    { kind: "thought" },
    { reasoning: "private" },
    { message: " " },
    { message: "x".repeat(4001) },
    { message: "\u001b[2J" },
    { status: "verified" },
    { candidate: "../escape" },
    { kind: "candidate" },
    { parent: "baseline" },
    { candidate: "a", parent: "a" },
    { candidate: "a", generation: -1 },
    { candidate: "a", generation: 0.5 },
    { stage: 1 },
    { metrics: [] },
    { metrics: { area: { value: Infinity, unit: "cells" } } },
    { metrics: { area: { value: "1", unit: "cells" } } },
    { metrics: { area: { value: 1 } } },
    { metrics: { area: { value: 1, unit: "cells", verified: true } } },
    {
      metrics: Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [
          `metric${i}`,
          { value: i, unit: "" },
        ]),
      ),
    },
    { evidence: {} },
    { evidence: { project: "." } },
    { evidence: { job: "not-uuid" } },
    { evidence: { artifact: "123" } },
    { evidence: { run: "a".repeat(64), command: "echo do-not-run" } },
  ])
    await assert.rejects(
      appendWorkEvent(project, session.id, { ...base, ...patch }),
      { code: "WORK_INVALID" },
    );
  for (const event of [null, [], "data"])
    await assert.rejects(appendWorkEvent(project, session.id, event), {
      code: "WORK_INVALID",
    });
  assert.equal((await workStatus(project)).totalEvents, 0);
  await assert.rejects(startWork(project, { goal: "x", mode: "autonomous" }), {
    code: "WORK_INVALID",
  });
  await assert.rejects(workStatus(project, { session: "../../outside" }), {
    code: "WORK_INVALID",
  });
  await assert.rejects(workStatus(project, { limit: 201 }), {
    code: "WORK_INVALID",
  });
  await assert.rejects(
    startWork(join(project, "missing"), {
      goal: "No implicit directory creation",
    }),
    { code: "ENOENT" },
  );
  await appendWorkEvent(project, session.id, {
    kind: "tool",
    message: "Quoted command is data: rm -rf /",
    metrics: { dimensionless: { value: 0, unit: "" } },
  });
  assert.equal(
    (await workStatus(project)).events[0].metrics.dimensionless.value,
    0,
  );
});

test("readers ignore atomic temp files but reject corrupt published records and unsafe directories", async (t) => {
  const project = await temporary(t);
  const session = await startWork(project, { goal: "Inspect publication" });
  const path = journal(project, session.id);
  await writeFile(join(path, ".unfinished.tmp"), "{");
  await mkdir(journal(project, randomUUID()));
  assert.equal((await listWork(project)).length, 1);
  assert.equal((await workStatus(project)).totalEvents, 0);
  await writeFile(join(path, "000001.json"), "{");
  await assert.rejects(workStatus(project), { code: "INVALID_JSON" });
  await rm(join(path, "000001.json"));
  const outside = join(project, "event.json");
  await save(outside, { kind: "plan", message: "not a published event" });
  await symlink(outside, join(path, "000001.json"));
  await assert.rejects(workStatus(project), { code: "ELOOP" });
  const other = await temporary(t);
  await symlink(join(project, ".chipsim-agent"), join(other, ".chipsim-agent"));
  await assert.rejects(
    startWork(other, { goal: "Do not follow storage links" }),
    { code: "WORK_DIRECTORY" },
  );
  await assert.rejects(workStatus(other), { code: "WORK_DIRECTORY" });
});

test("journal limits preserve old data and bound filesystem enumeration", async (t) => {
  const project = await temporary(t);
  const session = await startWork(project, { goal: "Capacity" });
  const path = journal(project, session.id);
  const first = await appendWorkEvent(project, session.id, {
    kind: "plan",
    message: "Keep this",
  });
  await save(join(path, "002048.json"), {
    ...first,
    id: randomUUID(),
    sequence: workLimits.events,
  });
  await assert.rejects(
    appendWorkEvent(project, session.id, {
      kind: "edit",
      message: "Over limit",
    }),
    { code: "WORK_LIMIT" },
  );
  assert.equal(
    JSON.parse(await readFile(join(path, "000001.json"), "utf8")).id,
    first.id,
  );
  await Promise.all(
    Array.from({ length: workLimits.directoryEntries }, (_, i) =>
      writeFile(join(path, `.temporary-${i}.tmp`), ""),
    ),
  );
  await assert.rejects(workStatus(project), { code: "WORK_LIMIT" });
  assert.equal(
    JSON.parse(await readFile(join(path, "000001.json"), "utf8")).id,
    first.id,
  );
  const fullProject = await temporary(t);
  await startWork(fullProject, { goal: "First session" });
  await Promise.all(
    Array.from({ length: workLimits.sessions - 2 }, () =>
      mkdir(journal(fullProject, randomUUID())),
    ),
  );
  const starts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      startWork(fullProject, { goal: "Concurrent capacity check" }),
    ),
  );
  const sessionDirectories = await readdir(
    join(fullProject, ".chipsim-agent", "work"),
  );
  assert.ok(sessionDirectories.length <= workLimits.sessions);
  assert.ok(
    starts.some(
      (entry) =>
        entry.status === "rejected" && entry.reason.code === "WORK_LIMIT",
    ),
  );
  assert.equal(
    (await listWork(fullProject))[0].goal === "First session" ||
      (await listWork(fullProject))[0].goal === "Concurrent capacity check",
    true,
  );
});

test("work CLI discovers commands, validates bounded JSON files and emits one versioned result", async (t) => {
  const project = await temporary(t);
  const started = await agentCommand([
    "work-start",
    project,
    "--goal",
    "CLI smoke",
  ]);
  assert.equal(started.exitCode, 0);
  const session = started.result.session.id;
  const file = join(project, "event.json");
  await save(file, {
    kind: "candidate",
    candidate: "first",
    message: "Candidate ready",
  });
  const appended = await agentCommand([
    "work-event",
    project,
    session,
    "--event",
    file,
  ]);
  assert.equal(appended.exitCode, 0);
  assert.equal(appended.result.event.reporting, "agent-reported");
  const executable = new URL("../scripts/chipsim.mjs", import.meta.url)
    .pathname;
  const output = await promisify(execFile)(
    process.execPath,
    [
      executable,
      "agent",
      "work-status",
      project,
      "--session",
      session,
      "--limit",
      "1",
    ],
    { cwd: tmpdir() },
  );
  const result = JSON.parse(output.stdout);
  assert.equal(output.stderr, "");
  assert.equal(result.format, "chipsim-agent-result");
  assert.equal(result.version, 1);
  assert.equal(result.session.id, session);
  assert.equal(result.events.length, 1);
  const help = await agentCommand(["help"]);
  assert.equal(help.result.commands["work-start"].options.goal, "required");
  assert.equal(help.result.work.reporting, "agent-reported");
  for (const path of [
    help.result.documentation["AGENT_CONTROL.md"],
    help.result.documentation["AGENT_WORK.md"],
    help.result.documentation["EVOLUTION.md"],
    help.result.examples.evolution.guide,
    help.result.examples.evolution.runner,
    help.result.examples.evolution.workflows["counter-activity"],
  ]) {
    assert.ok(path.startsWith(new URL("../", import.meta.url).pathname));
    assert.ok((await readFile(path)).length > 100);
  }
  for (const text of [
    "{",
    "null",
    "[]",
    JSON.stringify({ kind: "tool", message: "x".repeat(17000) }),
  ]) {
    await writeFile(file, text);
    const response = await agentCommand([
      "work-event",
      project,
      session,
      "--event",
      file,
    ]);
    assert.notEqual(response.exitCode, 0);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.diagnostics.length, 1);
  }
  const directoryInput = await agentCommand([
    "work-event",
    project,
    session,
    "--event",
    project,
  ]);
  assert.equal(directoryInput.result.diagnostics[0].code, "FILE_LIMIT");
  for (const args of [
    ["work-start", project],
    ["work-status", project, "--limit", "0"],
    ["work-status", project, "--surprise", "yes"],
  ]) {
    const response = await agentCommand(args);
    assert.equal(response.exitCode, 2);
    assert.equal(response.result.ok, false);
  }
  assert.equal((await workStatus(project)).totalEvents, 1);
});
