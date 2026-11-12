import { workbenchTools } from "../src/workbench/schema.js";
import { referenceTest, extractReferencePDF } from "./reference-fixtures.js";
const test = referenceTest([
  "native tool mappings cover every agent command and preserve literal text and zero offsets",
  "agent work tools preserve goals/session identifiers and explicit dashboard launch",
  "tool calls use their current cwd independently and forward cancellation",
  "general commands keep arguments literal, enforce bounds and forward cwd/cancellation",
  "one general tool drives discovery, durable jobs, evidence, checks and snapshots",
  "HDL tools preserve comparison mismatches as errors with result details",
  "process bridge bounds output/time, aborts, and rejects invalid envelopes and missing Node",
  "POSIX cancellation also kills an owned descendant that ignores SIGTERM",
  "snapshot CLI errors retain stderr in the error visible to the agent",
  "TUI slash command handles Pi/Prime modes and restores host after child failure",
  "native workbench tools share the Node process boundary, literal arguments and structured failures",
  "native inspection snapshots cover netlists and circuits with correct modes and exclusivity",
]);
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  registerChipSim,
  toolCommands,
  toolArguments,
  tuiArguments,
  commandArguments,
} from "../src/integrations/extension.js";
import {
  runChipSim,
  nodeCommand,
  ChipSimProcessError,
} from "../src/integrations/process.js";

const root = new URL("../", import.meta.url).pathname;
// Tests need no agent package installed. Real native loaders are tested by
// scripts/test-agent-hosts.mjs using each host's supplied TypeBox implementation.
const Type = {
  String: (options) => ({ type: "string", ...options }),
  Integer: (options) => ({ type: "integer", ...options }),
  Array: (items, options) => ({ type: "array", items, ...options }),
  Literal: (value) => ({ const: value }),
  Union: (values) => ({ anyOf: values }),
  Optional: (value) => ({ ...value, optional: true }),
  Object: (properties, options) => ({ type: "object", properties, ...options }),
};
function registry(options) {
  const tools = new Map(),
    commands = new Map();
  registerChipSim(
    {
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: (name, command) => commands.set(name, command),
    },
    Type,
    options,
  );
  return { tools, commands };
}
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "chipsim-extension-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const invoke = (tools, name, params, cwd, signal) =>
  tools.get(name).execute("test", params, signal, undefined, { cwd });

test("native workbench tools share the Node process boundary, literal arguments and structured failures", async (t) => {
  const calls = [],
    signal = new AbortController().signal;
  const success = {
    format: "chipsim-workbench-result",
    version: 1,
    ok: true,
    result: {},
  };
  const mocked = registry({
    run: async (args, options) => {
      calls.push({ args, options });
      return success;
    },
  }).tools;
  const params = {
    project: "chip project",
    path: "rtl/top.sv",
    text: "literal $(touch NEVER)\n",
    expectedHash: null,
  };
  await invoke(
    mocked,
    "chipsim_workbench_file_write",
    params,
    "/tmp/first",
    signal,
  );
  await invoke(
    mocked,
    "chipsim_workbench_project",
    { project: "." },
    "/tmp/second",
  );
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "workbench",
    "file_write",
    "--project",
    "/tmp/first/chip project",
    "--input",
  ]);
  assert.equal(calls[0].args[5], "-");
  assert.deepEqual(JSON.parse(calls[0].options.input), {
    path: params.path,
    text: params.text,
    expectedHash: null,
  });
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.cwd, "/tmp/first");
  assert.equal(calls[1].args[3], "/tmp/second");
  const failure = {
    format: "chipsim-workbench-result",
    version: 1,
    ok: false,
    error: { code: "EDIT_CONFLICT", message: "changed" },
  };
  const failing = registry({
    run: async () => {
      throw new ChipSimProcessError("failed", { result: failure });
    },
  }).tools;
  const errorResult = await invoke(
    failing,
    "chipsim_workbench_file_write",
    params,
    "/tmp/first",
  );
  assert.deepEqual(errorResult.details, failure);
  assert.equal(errorResult.isError, true);
  const interrupted = registry({
    run: async () => {
      throw new ChipSimProcessError("cancelled", {
        reason: "cancelled",
        result: failure,
      });
    },
  }).tools;
  await assert.rejects(
    () =>
      invoke(
        interrupted,
        "chipsim_workbench_project",
        { project: "." },
        "/tmp/first",
      ),
    /cancelled/,
  );
  const broken = registry({
    run: async () => {
      throw new Error("missing Node");
    },
  }).tools;
  await assert.rejects(
    () =>
      invoke(
        broken,
        "chipsim_workbench_project",
        { project: "." },
        "/tmp/first",
      ),
    /missing Node/,
  );
  const cwd = await temporary(t),
    { tools } = registry();
  const created = await invoke(
    tools,
    "chipsim_workbench_file_write",
    { ...params, project: "." },
    cwd,
  );
  assert.equal(created.details.ok, true);
  assert.equal(await readFile(join(cwd, params.path), "utf8"), params.text);
  const conflict = await invoke(
    tools,
    "chipsim_workbench_file_write",
    { ...params, project: "." },
    cwd,
  );
  assert.equal(conflict.details.error.code, "EDIT_CONFLICT");
  assert.equal(conflict.isError, true);
  const large = "x".repeat(1048576);
  const largeResult = await invoke(
    tools,
    "chipsim_workbench_file_write",
    { project: ".", path: "large.txt", text: large, expectedHash: null },
    cwd,
  );
  assert.equal(largeResult.details.ok, true);
  assert.equal(await readFile(join(cwd, "large.txt"), "utf8"), large);
  const tooLarge = await invoke(
    tools,
    "chipsim_workbench_file_write",
    {
      project: ".",
      path: "too-large.txt",
      text: large + "x",
      expectedHash: null,
    },
    cwd,
  );
  assert.equal(tooLarge.isError, true);
});

test("native inspection snapshots cover netlists and circuits with correct modes and exclusivity", async (t) => {
  const cwd = await temporary(t),
    file = join(cwd, "netlist.json");
  await writeFile(
    file,
    JSON.stringify({
      modules: { top: { ports: { q: { direction: "output", bits: [2] } } } },
    }),
  );
  const { tools } = registry();
  const frame = await invoke(
    tools,
    "chipsim_snapshot",
    { netlist: file, columns: 80, rows: 24 },
    cwd,
  );
  assert.match(frame.content[0].text, /synthesized netlist/);
  assert.doesNotMatch(frame.content[0].text, /Selected: data/);
  assert.equal(frame.details.view, "schematic");
  const circuit = await invoke(
    tools,
    "chipsim_snapshot",
    { circuit: join(root, "examples/connected-circuit/swap.json") },
    cwd,
  );
  assert.equal(circuit.details.view, "circuit");
  assert.match(circuit.content[0].text, /CONNECTED/);
  await assert.rejects(
    () =>
      invoke(tools, "chipsim_snapshot", { netlist: file, model: "pio" }, cwd),
    /Choose one snapshot source/,
  );
  await assert.rejects(
    () =>
      invoke(
        tools,
        "chipsim_snapshot",
        { netlist: file, circuit: "circuit.json" },
        cwd,
      ),
    /Choose one snapshot source/,
  );
});

test("native tool mappings cover every agent command and preserve literal text and zero offsets", async () => {
  const help = await runChipSim(["agent", "help"], { cwd: root });
  assert.deepEqual(
    toolCommands
      .filter((s) => !s.family)
      .map((s) => s.command)
      .sort(),
    Object.keys(help.commands).sort(),
  );
  for (const spec of toolCommands.filter((s) => !s.family)) {
    const contract = help.commands[spec.command];
    assert.equal(spec.positionals?.length || 0, contract.positionals.length);
    assert.deepEqual(
      [...(spec.options || [])].sort(),
      Object.keys(contract.options).sort(),
    );
    for (const [key, value] of Object.entries(contract.options))
      assert.equal(
        !!spec.required?.includes(key),
        value === "required",
        spec.command + " " + key,
      );
  }
  const search = toolCommands.find((s) => s.command === "search");
  assert.deepEqual(
    toolArguments(
      search,
      { project: ".", query: "--out $(touch NEVER)", offset: 0 },
      "/tmp/a",
    ),
    ["agent", "search", "--offset", "0", "--", ".", "--out $(touch NEVER)"],
  );
  assert.equal(registry().tools.size, 37 + workbenchTools.length);
  assert.equal(
    nodeCommand({ CHIPSIM_NODE: "/opt/node" }, { bun: "1" }),
    "/opt/node",
  );
  assert.equal(nodeCommand({}, { bun: "1" }), "node");
});

test("agent work tools preserve goals/session identifiers and explicit dashboard launch", async (t) => {
  const cwd = await temporary(t);
  const start = toolCommands.find((s) => s.command === "work-start");
  assert.deepEqual(
    toolArguments(
      start,
      { project: ".", goal: "Reduce area; keep behavior", mode: "evolution" },
      cwd,
    ),
    [
      "agent",
      "work-start",
      "--goal",
      "Reduce area; keep behavior",
      "--mode",
      "evolution",
      "--",
      ".",
    ],
  );
  const event = toolCommands.find((s) => s.command === "work-event");
  assert.deepEqual(
    toolArguments(
      event,
      { project: ".", session: "session-id", event: "event.json" },
      cwd,
    ),
    [
      "agent",
      "work-event",
      "--event",
      join(cwd, "event.json"),
      "--",
      ".",
      "session-id",
    ],
  );
  assert.deepEqual(tuiArguments("--agent .", cwd), ["--agent", cwd]);
  const { tools } = registry();
  const started = await invoke(
    tools,
    "chipsim_work_start",
    { project: ".", goal: "Visible implementation", mode: "task" },
    cwd,
  );
  assert.ok(started.details.session.id);
  const frame = await invoke(tools, "chipsim_snapshot", { agent: "." }, cwd);
  assert.match(frame.content[0].text, /Visible implementation/);
  assert.equal(frame.details.view, "activity");
});

test("tool calls use their current cwd independently and forward cancellation", async () => {
  const calls = [];
  const { tools } = registry({
    run: async (args, options) => {
      calls.push({ args, options });
      return { ok: true };
    },
  });
  const signal = new AbortController().signal;
  await Promise.all([
    invoke(
      tools,
      "chipsim_prepare",
      { manual: "one.pdf", out: "work" },
      "/tmp/one",
      signal,
    ),
    invoke(
      tools,
      "chipsim_prepare",
      { manual: "two.pdf", out: "work" },
      "/tmp/two",
    ),
  ]);
  assert.equal(calls[0].options.cwd, "/tmp/one");
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].args[3], "/tmp/one/work");
  assert.equal(calls[1].args[3], "/tmp/two/work");
});

test("general commands keep arguments literal, enforce bounds and forward cwd/cancellation", async () => {
  const calls = [];
  const { tools } = registry({
    run: async (args, options) => {
      calls.push({ args, options });
      return { ok: true };
    },
  });
  const signal = new AbortController().signal;
  const args = ["agent", "search", ".", "--", "--snapshot $(touch NEVER)"];
  await invoke(tools, "chipsim_command", { args }, "/tmp/one", signal);
  await invoke(
    tools,
    "chipsim_command",
    { args: ["job", "status", "--project", "."] },
    "/tmp/two",
  );
  assert.deepEqual(calls[0].args, args);
  assert.equal(calls[0].options.cwd, "/tmp/one");
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.textOutput, false);
  assert.equal(calls[1].options.cwd, "/tmp/two");
  for (const invalid of [
    "design run",
    [null],
    ["a\0b"],
    Array(129).fill("x"),
    ["x".repeat(8193)],
    Array(9).fill("x".repeat(8192)),
  ])
    assert.throws(() => commandArguments(invalid), /ChipSim args/);
  for (const interactive of [
    ["--design", "."],
    ["bash", "-c", "pwd"],
  ])
    assert.throws(
      () => commandArguments(interactive),
      /Pass ChipSim arguments/,
    );
  assert.deepEqual(commandArguments(), { args: ["--help"], textOutput: true });
  assert.deepEqual(commandArguments(["evolution", "list"]), {
    args: ["evolution", "list"],
    textOutput: false,
  });
  assert.equal(commandArguments(["evolution", "help"]).textOutput, true);
  assert.equal(
    commandArguments(["evolution", "report", "report.json", "--format", "text"])
      .textOutput,
    true,
  );
  assert.deepEqual(commandArguments(["table", "help"]), {
    args: ["table", "help"],
    textOutput: false,
  });
});

test("one general tool drives discovery, durable jobs, evidence, checks and snapshots", async (t) => {
  const cwd = await temporary(t),
    { tools } = registry();
  const call = (args) => invoke(tools, "chipsim_command", { args }, cwd);
  assert.match(
    (await call([])).content[0].text,
    /Project commands: chipsim design commands/,
  );
  assert.equal(
    (await call(["design", "help"])).details.format,
    "chipsim-design-result",
  );
  const circuit = await call([
    "circuit",
    "check",
    join(root, "examples/connected-circuit/swap.json"),
  ]);
  assert.equal(circuit.details.format, "chipsim-circuit-result");
  assert.equal(circuit.details.coverage.status, "complete-scoped-proof");
  const evolution = await call(["evolution", "list"]);
  assert.equal(evolution.details.format, "chipsim-evolution-result");
  assert.deepEqual(
    evolution.details.result.benchmarks.map((benchmark) => benchmark.id),
    ["counter", "alu8"],
  );
  const catalog = (await call(["design", "commands"])).details;
  const guidance = (await call([...catalog.guidance.command, "testbench"]))
    .details.guide;
  assert.equal(guidance.optional, true);
  assert.ok(guidance.recipe.adapters.includes("cocotb"));
  assert.ok(
    catalog.commands.some(
      (c) => c.family === "design" && c.command === "status",
    ),
  );
  const project = "chip $(touch NEVER)";
  assert.equal((await call(["design", "init", project])).details.ok, true);
  await access(join(cwd, project, "chipsim.design.json"));
  await assert.rejects(access(join(cwd, "NEVER")), { code: "ENOENT" });
  await writeFile(
    join(cwd, project, "task.mjs"),
    "import {writeFile} from 'node:fs/promises'; await writeFile('result.txt', 'captured result');",
  );
  await writeFile(
    join(cwd, project, "chipsim.design.json"),
    JSON.stringify({
      format: "chipsim-design",
      version: 1,
      id: "controller-fixture",
      tasks: {
        sim: {
          adapter: "command",
          inputs: ["task.mjs"],
          options: { command: process.execPath, args: ["task.mjs"] },
          outputs: [{ path: "result.txt", kind: "report" }],
        },
      },
      targets: {
        simulation: {
          tasks: ["sim"],
          requiredChecks: ["sim:execution", "sim:outputs"],
        },
      },
    }),
  );
  const accepted = (await call(["design", "run", "--project", project]))
    .details;
  assert.equal(accepted.accepted, true);
  const job = (
    await call([
      "job",
      "status",
      accepted.job.id,
      "--project",
      project,
      "--wait",
      "--timeout-ms",
      "60000",
    ])
  ).details.job;
  assert.equal(job.state, "completed");
  assert.equal(job.ready, true);
  const current = (await call(["design", "status", "--project", project]))
    .details;
  assert.equal(current.ready, true);
  assert.equal(current.latestRun.id, job.run);
  const artifacts = (await call(["artifact", "list", "--project", project]))
    .details.artifacts;
  const output = artifacts.find((a) => a.path === "result.txt");
  assert.equal(
    (await call(["artifact", "inspect", output.id, "--project", project]))
      .details.preview,
    "captured result",
  );
  assert.equal(
    (await call(["checks", "--project", project])).details.ready,
    true,
  );
  const snapshot = await call([
    "--design",
    project,
    "--snapshot",
    "--view",
    "checks",
    "--no-color",
  ]);
  assert.match(snapshot.content[0].text, /CHECKS/);
  assert.match(snapshot.content[0].text, /READY/);
  await assert.rejects(
    call(["design", "unknown", "--project", project]),
    (error) => {
      assert.ok(error instanceof ChipSimProcessError);
      assert.equal(error.details.result.ok, false);
      assert.equal(error.details.exitCode, 2);
      return true;
    },
  );
});

test("native tools prepare real PDF evidence, check/run models and preserve failed destinations", async (t) => {
  const cwd = await temporary(t),
    { tools } = registry();
  const prepared = (
    await invoke(
      tools,
      "chipsim_prepare",
      {
        manual: join(root, "docs/references/74hc00/nexperia-74hc00.pdf"),
        out: "chip work",
      },
      cwd,
    )
  ).details;
  assert.equal(prepared.ok, true);
  const project = join(cwd, "chip work");
  assert.match(
    await readFile(join(project, "docs/AGENT_EXTENSIONS.md"), "utf8"),
    /chipsim_context/,
  );
  const model = join(project, prepared.models[0].file);
  assert.equal(
    (await invoke(tools, "chipsim_check", { model, project }, cwd)).details.ok,
    true,
  );
  const result = (
    await invoke(
      tools,
      "chipsim_run",
      { model, project, out: "run one", ticks: 4 },
      cwd,
    )
  ).details;
  assert.equal(result.ok, true);
  assert.ok(result.artifacts["trace.json"]);
  const before = await readFile(result.artifacts["trace.json"], "utf8");
  await assert.rejects(
    invoke(tools, "chipsim_run", { model, project, out: "run one" }, cwd),
    (error) => {
      assert.ok(error instanceof ChipSimProcessError);
      assert.equal(error.details.result.ok, false);
      return true;
    },
  );
  assert.equal(await readFile(result.artifacts["trace.json"], "utf8"), before);
  const note = await invoke(
    tools,
    "chipsim_note",
    { project, message: "--out $(touch NEVER)" },
    cwd,
  );
  assert.equal(note.details.ok, true);
  const activity = await invoke(
    tools,
    "chipsim_activity",
    { project, limit: 10 },
    cwd,
  );
  assert.ok(JSON.stringify(activity.details).includes("$(touch NEVER)"));
  // Fresh PDF verification must survive the native bridge. A corrupt source
  // cannot be made valid by previously cached preparation/check results.
  await writeFile(join(project, "manual.pdf"), "not the pinned PDF");
  await assert.rejects(
    invoke(tools, "chipsim_check", { model, project }, cwd),
    (error) => {
      assert.equal(error.details.result.ok, false);
      return true;
    },
  );
});

test("built-in program and terminal snapshot are controllable without an interactive agent", async (t) => {
  const cwd = await temporary(t),
    { tools } = registry();
  const context = (
    await invoke(tools, "chipsim_context", { target: "pio" }, cwd)
  ).details.programmingContext;
  const program = context.examples.find((e) => e.modelId === "pio").path;
  const result = (
    await invoke(
      tools,
      "chipsim_program_run",
      { program, model: "pio", out: "pio run" },
      cwd,
    )
  ).details;
  assert.equal(result.ok, true);
  const trace = JSON.parse(
    await readFile(result.artifacts["trace.json"], "utf8"),
  );
  assert.equal(trace.trace.at(-1).registers.decoded, 179);
  const snapshot = await invoke(
    tools,
    "chipsim_snapshot",
    { model: result.artifacts["session.json"], view: "states", at: 0 },
    cwd,
  );
  assert.match(snapshot.content[0].text, /CHIPSIM/);
  await assert.rejects(
    invoke(tools, "chipsim_snapshot", { model: "pio", waveform: "x.vcd" }, cwd),
    /Choose one snapshot source/,
  );
});

test("HDL tools preserve comparison mismatches as errors with result details", async (t) => {
  const cwd = await temporary(t),
    { tools } = registry();
  const header =
    "$timescale 1ns $end\n$var wire 1 a out $end\n$enddefinitions $end\n";
  await writeFile(join(cwd, "left.vcd"), header + "0a\n#5\n1a\n#10\n");
  await writeFile(join(cwd, "right.vcd"), header + "0a\n#5\n0a\n#10\n");
  await writeFile(
    join(cwd, "map.json"),
    JSON.stringify({ signals: [{ left: "out", right: "out" }] }),
  );
  assert.equal(
    (
      await invoke(
        tools,
        "chipsim_hdl_import",
        { waveform: "left.vcd", out: "wave" },
        cwd,
      )
    ).details.ok,
    true,
  );
  await assert.rejects(
    invoke(
      tools,
      "chipsim_hdl_compare",
      { left: "left.vcd", right: "right.vcd", map: "map.json" },
      cwd,
    ),
    (error) => {
      assert.equal(error.details.exitCode, 1);
      assert.equal(error.details.result.comparison.match, false);
      return true;
    },
  );
});

test("process bridge bounds output/time, aborts, and rejects invalid envelopes and missing Node", async (t) => {
  const cwd = await temporary(t),
    cli = join(cwd, "child.mjs");
  await writeFile(
    cli,
    'if (process.argv[2] === "flood") console.log("x".repeat(10000)); else if (process.argv[2] === "bad") console.log("{}"); else setInterval(() => {}, 1000);',
  );
  await assert.rejects(
    runChipSim(["bad"], { cli, cwd }),
    /invalid result envelope/,
  );
  await assert.rejects(
    runChipSim(["flood"], { cli, cwd, maxBytes: 100 }),
    /output limit/,
  );
  await assert.rejects(runChipSim([], { cli, cwd, timeout: 30 }), /timeout/);
  const controller = new AbortController();
  const running = runChipSim([], { cli, cwd, signal: controller.signal });
  controller.abort();
  await assert.rejects(running, (error) => error.details.cancelled === true);
  await assert.rejects(
    runChipSim([], { cwd, signal: controller.signal }),
    /before starting/,
  );
  await assert.rejects(
    runChipSim([], { cwd, executable: join(cwd, "missing-node") }),
    /could not start/,
  );
});

test(
  "POSIX cancellation also kills an owned descendant that ignores SIGTERM",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await temporary(t),
      cli = join(cwd, "parent.mjs");
    const ready = join(cwd, "ready"),
      escaped = join(cwd, "escaped");
    await writeFile(
      join(cwd, "worker.mjs"),
      `
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    writeFileSync(${JSON.stringify(ready)}, "ready");
    setTimeout(() => writeFileSync(${JSON.stringify(escaped)}, "orphan"), 1200);
    setInterval(() => {}, 1000);
  `,
    );
    await writeFile(
      cli,
      `
    import { spawn } from "node:child_process";
    spawn(process.execPath, [${JSON.stringify(join(cwd, "worker.mjs"))}], { stdio: "inherit" });
    setInterval(() => {}, 1000);
  `,
    );
    const controller = new AbortController();
    const running = runChipSim([], { cwd, cli, signal: controller.signal });
    // Attach rejection handling before waiting for readiness.
    const rejected = assert.rejects(
      running,
      (error) => error.details.cancelled === true,
    );
    let started = false;
    for (let count = 0; count < 200; count++) {
      try {
        await access(ready);
        started = true;
        break;
      } catch {}
      await new Promise((done) => setTimeout(done, 10));
    }
    controller.abort();
    await rejected;
    assert.ok(started, "Descendant must be running before cancellation");
    await new Promise((done) => setTimeout(done, 1250));
    await assert.rejects(access(escaped), { code: "ENOENT" });
  },
);

test("snapshot CLI errors retain stderr in the error visible to the agent", async (t) => {
  const cwd = await temporary(t),
    { tools } = registry();
  await assert.rejects(
    invoke(tools, "chipsim_snapshot", { model: "missing-session.json" }, cwd),
    /ENOENT/,
  );
});

test("TUI slash command handles Pi/Prime modes and restores host after child failure", async (t) => {
  const cwd = await temporary(t),
    events = [];
  const { commands } = registry({
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => events.push("clear") },
    interactive: (_node, args, opts) => {
      assert.equal(opts.shell, false);
      assert.equal(opts.cwd, cwd);
      assert.deepEqual(args.slice(1), ["--model", "pio"]);
      events.push("child");
      throw new Error("test failure");
    },
  });
  const handler = commands.get("chipsim").handler;
  const ui = {
    notify: (text) => events.push(text),
    custom: async (factory) => {
      let result;
      factory(
        {
          stop: () => events.push("stop"),
          start: () => events.push("start"),
          requestRender: () => events.push("render"),
        },
        null,
        null,
        (value) => {
          result = value;
        },
      );
      return result;
    },
  };
  for (const mode of [{ mode: "tui" }, { hasUI: true }]) {
    events.length = 0;
    await handler("--model pio", { cwd, ui, ...mode });
    assert.deepEqual(events.slice(0, 6), [
      "stop",
      "clear",
      "child",
      "start",
      "render",
      "ChipSim exited: test failure",
    ]);
  }
  events.length = 0;
  await handler("--model pio", { cwd, ui, mode: "rpc", hasUI: true });
  assert.match(events[0], /interactive terminal/);
  assert.match(events[0], /--model.*pio/);
  assert.ok(!events.includes("child"));
  events.length = 0;
  const remote = registry({
    stdin: { isTTY: false },
    stdout: { isTTY: false },
  });
  await remote.commands
    .get("chipsim")
    .handler("--session 'a $(touch NEVER).json'", { cwd, ui, hasUI: true });
  assert.match(events[0], /prime-agent daemon/);
  assert.ok(
    events[0].includes("'" + resolve(cwd, "a $(touch NEVER).json") + "'"),
    "Launch instructions must quote shell metacharacters literally",
  );
  assert.deepEqual(tuiArguments("--session 'a path/session.json'", cwd), [
    "--model",
    resolve(cwd, "a path/session.json"),
  ]);
  for (const flag of ["--netlist", "--circuit", "--hdl-debug", "--design"])
    assert.deepEqual(tuiArguments(flag + " 'a path/input.json'", cwd), [
      flag,
      join(cwd, "a path/input.json"),
    ]);
  await writeFile(join(cwd, "chipsim.project.json"), "{}");
  assert.deepEqual(tuiArguments("", cwd), ["--watch", cwd]);
  assert.throws(() => tuiArguments("--out something", cwd), /Use \/chipsim/);
});
