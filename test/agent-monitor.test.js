import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { agentCommand } from "../src/agent/commands.js";
import {
  recordActivity,
  readActivity,
  readPublishedRun,
  digest,
  activityDirectory,
} from "../src/agent/activity.js";
import { TuiState } from "../src/tui/state.js";
import { AgentMonitor } from "../src/tui/agent-monitor.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";
import { activityEvents } from "../src/tui/activity-panel.js";

const root = new URL("../", import.meta.url).pathname;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, data) => writeFile(path, JSON.stringify(data));
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "chipsim-monitor-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const project = join(path, "agent project");
  const prepared = await agentCommand([
    "prepare",
    join(root, "docs/references/74hc00/nexperia-74hc00.pdf"),
    "--out",
    project,
  ]);
  assert.equal(prepared.exitCode, 0);
  const model = join(project, prepared.result.models[0].file);
  const state = new TuiState({ workspace: join(path, "ui") });
  await state.initialize();
  const monitor = await new AgentMonitor(state, project).initialize();
  t.after(() => monitor.close());
  const run = async (name, ticks = 20) => {
    const result = await agentCommand([
      "run",
      model,
      "--project",
      project,
      "--out",
      join(path, name),
      "--ticks",
      String(ticks),
    ]);
    assert.equal(result.exitCode, 0, JSON.stringify(result.result));
    return result.result;
  };
  return { path, project, model, state, monitor, run };
}

test("activity records source retrieval, progress, failed checks and concurrent notes without changing JSON protocol", async (t) => {
  const { project, model } = await fixture(t);
  await agentCommand(["search", project, "function", "--limit", "1"]);
  await agentCommand(["page", project, "1", "--limit", "20"]);
  const checked = await agentCommand(["check", model, "--project", project]);
  assert.equal(checked.exitCode, 0);
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      agentCommand(["note", project, `Reviewing rule ${index}`]),
    ),
  );
  const broken = await json(model);
  broken.evidence[0].quote = "This fabricated quotation is not in the source";
  await save(model, broken);
  assert.equal(
    (await agentCommand(["check", model, "--project", project])).exitCode,
    1,
  );
  const report = await agentCommand(["activity", project, "--limit", "200"]);
  assert.equal(report.result.format, "chipsim-agent-result");
  const events = report.result.events;
  assert.equal(events.filter((event) => event.command === "note").length, 8);
  assert.ok(
    events.some(
      (event) =>
        event.command === "search" &&
        event.status === "succeeded" &&
        event.details.pages.length,
    ),
  );
  assert.ok(
    events.some(
      (event) => event.command === "page" && /PDF page 1/.test(event.message),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.command === "check" &&
        event.status === "progress" &&
        /fingerprint/.test(event.message),
    ),
  );
  assert.ok(
    events.some(
      (event) => event.command === "check" && event.status === "failed",
    ),
  );
  assert.equal(
    (await readdir(activityDirectory(project))).filter((file) =>
      file.endsWith(".tmp"),
    ).length,
    0,
  );
});

test("watch loads published runs outside project, preserves inspection, clamps shorter traces and pauses reload independently of activity", async (t) => {
  const { project, model, state, monitor, run } = await fixture(t);
  await run("first");
  await monitor.poll();
  assert.notEqual(state.modelId, "pio");
  state.view = "registers";
  state.format = "binary";
  state.zoom = 2;
  state.selected = 2;
  const signal = state.signal.id;
  state.seek(12);
  const spec = await json(model);
  spec.name = "Edited model under observation";
  await save(model, spec);
  await monitor.poll();
  assert.ok(
    state.activity.events.some(
      (event) => event.command === "model" && event.status === "changed",
    ),
  );
  assert.notEqual(state.model.name, spec.name);
  monitor.toggle();
  await agentCommand(["note", project, "Testing the shorter scenario"]);
  await run("short", 5);
  await monitor.poll();
  assert.equal(state.trace.length, 21);
  assert.ok(
    state.activity.events.some((event) =>
      /shorter scenario/.test(event.message),
    ),
  );
  monitor.toggle();
  state.prompt = { label: "Editing", value: "" };
  await monitor.poll();
  assert.equal(state.trace.length, 21);
  state.prompt = null;
  await monitor.poll();
  assert.equal(state.model.name, spec.name);
  assert.equal(state.trace.length, 6);
  assert.equal(state.tick, 5);
  assert.equal(state.view, "registers");
  assert.equal(state.format, "binary");
  assert.equal(state.zoom, 2);
  assert.equal(state.signal.id, signal);
  assert.equal((await readdir(join(state.workspace.path, "models"))).length, 0);
  const trace = state.trace;
  await monitor.poll();
  assert.equal(state.trace, trace, "unchanged run must not reload");
  // A restarted observer still finds an external run after journal rotation.
  const published = await readPublishedRun(project);
  assert.ok(published.details.sessionSha256);
  await rm(activityDirectory(project), { recursive: true });
  const other = new TuiState({
    workspace: join(state.workspace.path, "another"),
  });
  await other.initialize();
  const restarted = await new AgentMonitor(other, project).initialize();
  t.after(() => restarted.close());
  assert.equal(other.model.name, spec.name);
});

test("incomplete, tampered, invalid and failed runs keep the active simulation; new valid runs recover", async (t) => {
  const { project, model, state, monitor, run, path } = await fixture(t);
  await run("good");
  await monitor.poll();
  const baseline = state.trace;
  const candidate = await run("tampered");
  const sessionFile = candidate.artifacts["session.json"];
  const session = await json(sessionFile);
  session.duration = 9;
  await save(sessionFile, session);
  await monitor.poll();
  assert.equal(state.trace, baseline);
  assert.match(state.activity.status, /session changed/);
  const incomplete = join(project, "runs", "partial");
  await mkdir(incomplete, { recursive: true });
  await save(join(incomplete, "session.json"), session);
  await monitor.poll();
  assert.equal(state.trace, baseline);
  const invalid = await run("invalid");
  const invalidSession = await json(invalid.artifacts["session.json"]);
  invalidSession.inputs = [{ tick: 1, signal: "does_not_exist", value: 1 }];
  await save(invalid.artifacts["session.json"], invalidSession);
  await recordActivity(project, {
    command: "run",
    status: "succeeded",
    message: "Invalid authored session",
    details: {
      resultFile: join(path, "invalid/result.json"),
      resultSha256: digest(await readFile(join(path, "invalid/result.json"))),
      sessionFile: invalid.artifacts["session.json"],
      sessionSha256: digest(await readFile(invalid.artifacts["session.json"])),
    },
  });
  await monitor.poll();
  assert.equal(state.trace, baseline);
  assert.ok(
    state.activity.events.some(
      (event) => event.command === "watch" && event.status === "failed",
    ),
  );
  const broken = await json(model);
  broken.evidence[0].quote = "Not documented here";
  await save(model, broken);
  const failed = await agentCommand([
    "run",
    model,
    "--project",
    project,
    "--out",
    join(path, "failed"),
  ]);
  assert.equal(failed.result.ok, false);
  await monitor.poll();
  assert.equal(state.trace, baseline);
  broken.evidence = session.model.evidence;
  await save(model, broken);
  await run("recovered", 7);
  await monitor.poll();
  assert.equal(state.trace.length, 8);
  const current = state.trace;
  await writeFile(join(project, "manual.pdf"), "Changed source bytes");
  const ready = await readPublishedRun(project);
  await recordActivity(project, {
    ...ready,
    message: "Reinspect after source edit",
  });
  await monitor.poll();
  assert.equal(state.trace, current);
  assert.ok(
    state.activity.events.some((event) =>
      /fingerprint changed/.test(event.message),
    ),
  );
});

test("legacy completed runs are discoverable and failed or missing artifacts never replace a good trace", async (t) => {
  const { project, model, state, monitor } = await fixture(t);
  const output = join(project, "runs", "legacy");
  const result = await agentCommand([
    "run",
    model,
    "--project",
    project,
    "--out",
    output,
  ]);
  assert.equal(result.exitCode, 0);
  await rm(join(project, ".chipsim-agent"), { recursive: true });
  await monitor.poll();
  assert.equal(state.modelId, result.result.model.id);
  const trace = state.trace;
  const incomplete = join(project, "runs", "incomplete");
  await mkdir(incomplete);
  const data = await json(join(output, "result.json"));
  data.artifacts["trace.vcd"] = join(incomplete, "not-written.vcd");
  await save(join(incomplete, "result.json"), data);
  await monitor.poll();
  assert.equal(state.trace, trace);
  assert.ok(
    state.activity.events.some((event) =>
      /Waiting for complete run artifacts/.test(event.message),
    ),
  );
  await writeFile(
    data.artifacts["trace.vcd"],
    await readFile(join(output, "trace.vcd")),
  );
  await monitor.poll();
  assert.notEqual(
    state.trace,
    trace,
    "pending artifacts are retried after completion",
  );
  const completed = state.trace;
  data.ok = false;
  await save(join(incomplete, "result.json"), data);
  await monitor.poll();
  assert.equal(state.trace, completed);
});

test("runtime fault artifacts remain inspectable but never auto-load", async (t) => {
  const { project, model, state, monitor, run, path } = await fixture(t);
  await run("good");
  await monitor.poll();
  const baseline = state.trace;
  const spec = await json(model);
  spec.parameters.push({ id: "fault", type: "boolean", default: false });
  const output = spec.signals.find(
    (signal) => signal.direction === "output",
  ).id;
  spec.states[0].tick = [
    ...(spec.states[0].tick || []),
    {
      target: "signal." + output,
      value: {
        op: "select",
        args: ["param.fault", { op: "div", args: [1, 0] }, "signal." + output],
      },
    },
  ];
  await save(model, spec);
  const params = join(path, "fault-params.json");
  await save(params, { fault: true });
  const failed = await agentCommand([
    "run",
    model,
    "--project",
    project,
    "--out",
    join(project, "runs", "fault"),
    "--params",
    params,
  ]);
  assert.equal(failed.result.ok, false);
  assert.ok(failed.result.artifacts);
  await monitor.poll();
  assert.equal(state.trace, baseline);
  assert.ok(
    state.activity.events.some(
      (event) =>
        event.command === "run" &&
        event.status === "failed" &&
        /simulation fault/.test(event.message),
    ),
  );
});

test("coordinated cache edits cannot forge quotations in a watched session", async (t) => {
  const { project, state, monitor, run, path } = await fixture(t);
  await run("good");
  await monitor.poll();
  const baseline = state.trace;
  const invalid = await run("forged");
  const invented = "Fabricated quotation absent from the actual PDF";
  const session = await json(invalid.artifacts["session.json"]);
  session.model.evidence[0].quote = invented;
  await save(invalid.artifacts["session.json"], session);
  const cacheFile = join(project, "sources.json");
  const cache = await json(cacheFile);
  const cited = cache.documents[0].pages.find(
    (page) => page.number === session.model.evidence[0].page,
  );
  cited.text += " " + invented;
  await save(cacheFile, cache);
  const manifestFile = join(project, "chipsim.project.json");
  const manifest = await json(manifestFile);
  manifest.bundleSha256 = digest(await readFile(cacheFile));
  await save(manifestFile, manifest);
  await recordActivity(project, {
    command: "run",
    status: "succeeded",
    message: "Forged source session",
    details: {
      resultFile: join(path, "forged/result.json"),
      resultSha256: digest(await readFile(join(path, "forged/result.json"))),
      sessionFile: invalid.artifacts["session.json"],
      sessionSha256: digest(await readFile(invalid.artifacts["session.json"])),
    },
  });
  await monitor.poll();
  assert.equal(state.trace, baseline);
  assert.ok(
    state.activity.events.some((event) =>
      /quote does not occur/.test(event.message),
    ),
  );
});

test("activity UI fits both terminal sizes, sanitizes control text, supports browse/filter/follow and stops polling on close", async (t) => {
  const { project, state, monitor } = await fixture(t);
  await agentCommand([
    "note",
    project,
    "Source review\x1b[2J\x07\n" +
      "long details ".repeat(70) +
      "full-detail-tail",
  ]);
  await monitor.poll();
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = input.pause = () => {};
  output.columns = 120;
  output.rows = 40;
  output.write = () => {};
  const app = new TerminalApp(state, { input, output });
  app.monitor = monitor;
  app.key("8", { name: "8" });
  assert.equal(state.view, "activity");
  app.key("k", { name: "k" });
  assert.equal(state.activityFollow, false);
  const chosen = activityEvents(state)[state.activityIndex].id;
  await agentCommand(["note", project, "Next step"]);
  await monitor.poll();
  assert.equal(activityEvents(state)[state.activityIndex].id, chosen);
  app.key("G", { name: "g" });
  assert.equal(state.activityFollow, true);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    Object.assign(state, { columns, rows });
    const frame = render(state);
    assert.equal(frame.length, rows);
    assert.ok(frame.every((line) => displayWidth(line.text) === columns));
    assert.ok(!screenText(state).includes("\x1b"));
    assert.match(screenText(state), /WATCH LIVE/);
    assert.match(screenText(state), /8/);
  }
  app.key("W", { name: "w" });
  assert.equal(state.activity.enabled, false);
  state.activityFilter = "Source review";
  for (let i = 0; i < 40; i++) app.key("l", { name: "l" });
  assert.match(screenText(state), /full-detail-tail/);
  app.key("/", { name: "/" });
  for (const char of "Next step") app.key(char, { name: char });
  app.key("\r", { name: "return" });
  assert.equal(activityEvents(state).length, 1);
  monitor.start();
  app.close();
  assert.equal(monitor.closed, true);
  assert.equal(monitor.timer._destroyed, true);
});

test("logging failure does not turn a successful command into a failure, and failed prepare never alters an existing project", async (t) => {
  const { project, model, monitor, state } = await fixture(t);
  const before = await readActivity(project);
  const repeated = await agentCommand([
    "prepare",
    join(root, "docs/references/74hc00/nexperia-74hc00.pdf"),
    "--out",
    project,
  ]);
  assert.equal(repeated.result.diagnostics[0].code, "OUTPUT_EXISTS");
  assert.deepEqual(await readActivity(project), before);
  await rm(join(project, ".chipsim-agent"), { recursive: true });
  await writeFile(
    join(project, ".chipsim-agent"),
    "This path is not a directory",
  );
  const check = await agentCommand(["check", model, "--project", project]);
  assert.equal(check.exitCode, 0);
  assert.equal(check.result.ok, true);
  assert.equal(check.result.activityWarnings.length, 1);
  await monitor.poll();
  assert.ok(
    state.activity.events.some(
      (event) => event.command === "watch" && event.status === "failed",
    ),
  );
  await rm(join(project, ".chipsim-agent"));
  await monitor.poll();
  assert.equal(state.activity.status, "Watching completed runs");
});

test("journal retention stays bounded and preserves the completed-run pointer", async (t) => {
  const { project, run } = await fixture(t);
  await run("retained-run");
  const published = await readPublishedRun(project);
  for (let i = 0; i < 505; i++)
    await recordActivity(project, {
      command: "note",
      status: "note",
      message: `Milestone ${i}`,
    });
  const events = await readActivity(project);
  assert.equal(events.length, 500);
  assert.equal(new Set(events.map((event) => event.id)).size, 500);
  assert.equal((await readPublishedRun(project)).id, published.id);
  assert.ok(!events.some((event) => event.id === published.id));
});
