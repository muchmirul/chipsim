import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand } from "../src/agent/commands.js";
import { prepareProject } from "../src/agent/project.js";
import { buildProgrammingContext } from "../src/agent/context.js";
import catalog from "../docs/references/catalog.json" with { type: "json" };
import { TuiState } from "../src/tui/state.js";
import { screenText } from "../src/tui/render.js";
import { AgentMonitor } from "../src/tui/agent-monitor.js";

const root = new URL("../", import.meta.url).pathname;
const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "chipsim-context-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("every catalog chip exposes truthful programming guidance, document pointers and native-backend limits", async () => {
  for (const chip of catalog.chips) {
    const { result, exitCode } = await agentCommand(["context", chip.id]);
    assert.equal(exitCode, 0, chip.id);
    assert.equal(result.format, "chipsim-agent-result");
    const context = result.programmingContext;
    assert.equal(context.chips[0].id, chip.id);
    assert.equal(context.decision.nativeExecution.available, false);
    assert.ok(
      context.decision.nativeExecution.unsupportedInputs.includes("ELF"),
    );
    assert.deepEqual(context.chips[0].missingDocuments, chip.missing);
    assert.ok(
      context.documents.some((d) => d.roles.includes("programmingGuide")),
      chip.id,
    );
    for (const document of context.documents)
      assert.ok((await stat(document.path)).isFile());
    for (const example of context.examples) {
      assert.ok(context.models.some((model) => model.id === example.modelId));
      assert.ok((await stat(example.path)).isFile());
    }
  }
  const gpio = (await agentCommand(["context", "esp32c6-gpio"])).result
    .programmingContext;
  assert.equal(gpio.models.length, 1);
  assert.equal(
    gpio.models[0].programming.mode,
    "register and input experiment",
  );
  assert.deepEqual(
    gpio.models[0].addressedRegisters.find(
      (r) => r.name === "GPIO_OUT_W1TS_REG",
    ).operations,
    ["write"],
  );
  const pcnt = (await agentCommand(["context", "esp32c6-pcnt"])).result
    .programmingContext;
  assert.ok(!pcnt.models[0].programming.instructions.includes("write"));
  const pio = (await agentCommand(["context", "pio"])).result
    .programmingContext;
  assert.match(
    pio.models[0].programming.controls,
    /does not accept a replacement native program/,
  );
  assert.deepEqual(
    pio.models[0].inputs.map((s) => s.id),
    ["ack"],
  );
  assert.ok(
    pio.models[0].observedRegisters.some(
      (register) => register.target === "reg.osr",
    ),
  );
  const unknownManual = buildProgrammingContext({
    source: { path: "/project/manual.pdf", sha256: "0".repeat(64), pages: 10 },
  });
  assert.equal(unknownManual.documents[0].id, "manual");
  assert.equal(unknownManual.chips.length, 0);
  const unknown = await agentCommand(["context", "unknown-RISC-V-device"]);
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.result.diagnostics[0].code, "UNKNOWN_CHIP");
  assert.equal(
    buildProgrammingContext({ source: { sha256: "0".repeat(64) } }).identity
      .method,
    "unidentified manual; do not infer chip architecture",
  );
});

test("prepared agent context leads to a real checked GPIO program, source session and watched signals", async (t) => {
  const path = await temporary(t),
    project = join(path, "project");
  const prepared = await prepareProject(
    join(root, "docs/references/esp32-c6/espressif-esp32-c6-trm.pdf"),
    project,
  );
  const snapshot = await readJSON(prepared.programmingContext.json);
  assert.equal(snapshot.identity.method, "exact PDF SHA-256");
  assert.equal(snapshot.chips[0].id, "esp32-c6");
  assert.deepEqual(
    snapshot.models.map((m) => m.id),
    ["esp32c6-pcnt", "esp32c6-gpio"],
  );
  assert.match(
    await readFile(join(project, "AGENTS.md"), "utf8"),
    /First read `PROGRAMMING_CONTEXT.md`/,
  );
  assert.match(
    await readFile(prepared.programmingContext.instructions, "utf8"),
    /GPIO_OUT_W1TS_REG \(write\)/,
  );
  assert.ok((await stat(join(project, "docs/PROGRAMMING.md"))).isFile());
  assert.deepEqual(snapshot.examples.map((example) => example.modelId).sort(), [
    "esp32c6-gpio",
    "esp32c6-pcnt",
  ]);
  for (const example of snapshot.examples) {
    assert.ok(example.path.startsWith(join(project, "examples") + "/"));
    assert.equal(
      await readFile(example.path, "utf8"),
      await readFile(example.source, "utf8"),
    );
  }
  const selected = await agentCommand([
    "context",
    project,
    "--model",
    "esp32c6-gpio",
  ]);
  assert.equal(selected.exitCode, 0);
  const context = selected.result.programmingContext,
    model = context.models[0];
  const programPath = join(project, "programs", "esp32c6-gpio.chip");
  await writeFile(programPath, await readFile(context.examples[0].path));
  const check = await agentCommand(model.commands.check.slice(2));
  assert.equal(check.exitCode, 0, JSON.stringify(check.result));
  assert.equal(check.result.format, "chipsim-agent-result");
  assert.equal(check.result.stepCount, 0);
  const run = await agentCommand(model.commands.run.slice(2));
  assert.equal(run.exitCode, 0, JSON.stringify(run.result));
  assert.equal(run.result.format, "chipsim-agent-result");
  const trace = await readJSON(run.result.artifacts["trace.json"]);
  assert.deepEqual(
    trace.trace.map((s) => s.signals.selected_driver),
    ["Z", 0, 1, 1, 1, 1, 0, 0],
  );
  const debug = await readJSON(run.result.artifacts["debug.json"]);
  assert.deepEqual(
    debug.steps.map((s) => s.line),
    [5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  assert.equal(debug.variables.latch, 0);
  assert.equal(debug.guides[0].page, 983);
  const state = new TuiState({ workspace: join(path, "viewer") });
  await state.initialize();
  const monitor = await new AgentMonitor(state, project).initialize();
  t.after(() => monitor.close());
  assert.equal(state.modelId, "esp32c6-gpio");
  assert.equal(state.programDebugger.status, "halted");
  assert.deepEqual(state.trace, trace.trace);
  state.view = "program";
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    Object.assign(state, { columns, rows });
    const frame = screenText(state);
    assert.match(frame, /EXPERIMENT SOURCE/);
    assert.equal(frame.split("\n").length, rows);
  }
  const prior = await readFile(prepared.programmingContext.json, "utf8");
  const spec = await readJSON(model.modelFile);
  spec.signals.push({
    id: "extra_input",
    label: "An explicitly added test input",
    width: 1,
    initial: 0,
    direction: "input",
  });
  await writeFile(model.modelFile, JSON.stringify(spec));
  const refreshed = await agentCommand([
    "context",
    project,
    "--model",
    model.id,
  ]);
  assert.equal(refreshed.exitCode, 0, JSON.stringify(refreshed.result));
  assert.ok(
    refreshed.result.programmingContext.models[0].inputs.some(
      (s) => s.id === "extra_input",
    ),
  );
  assert.notEqual(
    refreshed.result.programmingContext.models[0].definitionSha256,
    model.definitionSha256,
  );
  assert.equal(await readFile(prepared.programmingContext.json, "utf8"), prior);
  const mismatch = await agentCommand([
    "context",
    "am335x",
    "--project",
    project,
  ]);
  assert.equal(mismatch.result.diagnostics[0].code, "CHIP_MISMATCH");
  const failing = structuredClone(spec);
  failing.checks[0].expect = { "reg.gpio_out": 123456 };
  await writeFile(model.modelFile, JSON.stringify(failing));
  const unavailable = await agentCommand(["context", project]);
  assert.ok(
    !unavailable.result.programmingContext.models.some(
      (item) => item.id === model.id,
    ),
  );
  assert.ok(
    unavailable.result.programmingContext.diagnostics.some(
      (item) => item.code === "ACCEPTANCE" && item.message.includes("123456"),
    ),
  );
});

test("a prepared function-table chip receives an applicable source example and executes its pin program", async (t) => {
  const path = await temporary(t),
    project = join(path, "logic-project");
  const prepared = await prepareProject(
    join(root, "docs/references/74hc00/nexperia-74hc00.pdf"),
    project,
  );
  const context = await readJSON(prepared.programmingContext.json);
  assert.equal(context.chips[0].id, "74hc00");
  assert.equal(context.examples.length, 1);
  const model = context.models[0],
    example = context.examples[0];
  assert.equal(example.modelId, model.id);
  assert.ok(model.programming.instructions.includes("drive"));
  assert.ok(!model.programming.instructions.includes("write"));
  await writeFile(
    join(project, "programs", model.id + ".chip"),
    await readFile(example.path),
  );
  const check = await agentCommand(model.commands.check.slice(2));
  assert.equal(check.exitCode, 0, JSON.stringify(check.result));
  const run = await agentCommand(model.commands.run.slice(2));
  assert.equal(run.exitCode, 0, JSON.stringify(run.result));
  const trace = await readJSON(run.result.artifacts["trace.json"]);
  assert.deepEqual(
    trace.trace.map(({ signals }) => signals.pin_1y),
    [1, 1, 0, 1, 1],
  );
  assert.ok(trace.trace.every(({ signals }) => signals.pin_2y === 1));
});
