#!/usr/bin/env node
// Pack/install outside the checkout without fetching dependencies or launching
// a model provider. Exercise the public process contract agents actually use.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const root = new URL("../", import.meta.url).pathname;
const temporary = await mkdtemp(join(tmpdir(), "chipsim-install-"));
try {
  const prefix = join(temporary, "installed"),
    cwd = join(temporary, "external project");
  await mkdir(cwd);
  const packed = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
    { cwd: root, maxBuffer: 8 * 1048576 },
  );
  const [pack] = JSON.parse(packed.stdout);
  for (const path of [
    "src/agent/commands.js",
    "src/agent/activity.js",
    "src/agent/context.js",
    "src/agent/program.js",
    "src/program/engine.js",
    "src/program/guides.js",
    "src/tui/program-panel.js",
    "src/tui/agent-monitor.js",
    "src/tui/activity-panel.js",
    "docs/AGENT_WORKFLOW.md",
    "docs/AGENT_PROJECT.md",
    "docs/MODEL_FORMAT.md",
    "docs/PROGRAMMING.md",
    "docs/EXISTING_SIMULATORS.md",
    "docs/references/catalog.json",
    "examples/esp32c6-gpio.chip",
    "examples/programs/catalog.json",
    "examples/programs/pio-transfer.chip",
    "examples/programs/tca9534-output.chip",
    "examples/programs/hc00-nand.chip",
    "AGENTS.md",
    "docs/references/esp32-c6/espressif-esp32-c6-trm.pdf",
  ])
    assert.ok(
      pack.files.some((file) => file.path === path),
      `Package missing ${path}`,
    );
  assert.ok(
    !pack.files.some((file) =>
      /^(?:node_modules|\.chipsim|tmp|test-results|\.git)\//.test(file.path),
    ),
  );
  await run(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(temporary, pack.filename),
    ],
    { cwd, maxBuffer: 1048576 },
  );
  const binary = join(prefix, "bin/chipsim");
  const cli = async (args) => {
    const result = await run(binary, ["agent", ...args], {
      cwd,
      maxBuffer: 2 * 1048576,
    });
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.format, "chipsim-agent-result");
    assert.equal(parsed.version, 1);
    assert.equal(parsed.ok, true);
    return parsed;
  };
  const help = await cli(["help"]);
  assert.match(
    await readFile(help.documentation["MODEL_FORMAT.md"], "utf8"),
    /schemaVersion/,
  );
  assert.equal((await cli(["doctor"])).pdfTools.length, 2);
  const installed = join(prefix, "lib/node_modules/chipsim");
  const chipContext = (await cli(["context", "esp32-c6"])).programmingContext;
  assert.equal(chipContext.decision.nativeExecution.available, false);
  assert.ok(chipContext.models.some((model) => model.id === "esp32c6-gpio"));
  for (const document of chipContext.documents) {
    assert.ok(document.path.startsWith(installed + "/"));
    assert.equal(
      (await readFile(document.path)).subarray(0, 5).toString(),
      "%PDF-",
    );
  }
  const pioContext = (await cli(["context", "pio"])).programmingContext;
  const pioExample = pioContext.examples.find(
    (example) => example.modelId === "pio",
  );
  assert.ok(pioExample.path.startsWith(installed + "/"));
  await cli(["program-check", pioExample.path, "--model", "pio"]);
  const programmed = await cli([
    "program-run",
    pioExample.path,
    "--model",
    "pio",
    "--out",
    join(cwd, "programmed pio"),
  ]);
  const debug = JSON.parse(
    await readFile(programmed.artifacts["debug.json"], "utf8"),
  );
  assert.equal(debug.status, "halted");
  const programmedTrace = JSON.parse(
    await readFile(programmed.artifacts["trace.json"], "utf8"),
  );
  assert.equal(programmedTrace.trace.at(-1).registers.decoded, 179);
  const project = join(cwd, "agent work");
  const prepared = await cli([
    "prepare",
    join(installed, "docs/references/74hc00/nexperia-74hc00.pdf"),
    "--out",
    project,
  ]);
  assert.ok(prepared.models.length);
  const projectContext = (await cli(["context", project])).programmingContext;
  assert.equal(projectContext.chips[0].id, "74hc00");
  assert.ok(projectContext.models.length);
  assert.match(
    await readFile(join(project, "AGENTS.md"), "utf8"),
    /PROGRAMMING_CONTEXT/,
  );
  assert.equal(
    JSON.parse(
      await readFile(join(project, "programming-context.json"), "utf8"),
    ).format,
    "chipsim-programming-context",
  );
  const model = join(project, prepared.models[0].file);
  const logicExample = projectContext.examples[0];
  assert.equal(logicExample.id, "hc00-nand");
  const logicProgram = await cli([
    "program-run",
    logicExample.path,
    "--model",
    model,
    "--project",
    project,
    "--out",
    join(cwd, "programmed nand"),
  ]);
  const logicTrace = JSON.parse(
    await readFile(logicProgram.artifacts["trace.json"], "utf8"),
  );
  assert.deepEqual(
    logicTrace.trace.map(({ signals }) => signals.pin_1y),
    [1, 1, 0, 1, 1],
  );
  await cli(["search", project, "function"]);
  await cli(["page", project, "1"]);
  await cli([
    "note",
    project,
    "Reviewing this experiment from an installed agent tool",
  ]);
  await cli(["check", model, "--project", project]);
  const result = await cli([
    "run",
    model,
    "--project",
    project,
    "--out",
    join(cwd, "experiment"),
  ]);
  assert.ok(
    (await cli(["activity", project])).events.some(
      (event) => event.command === "run" && event.status === "succeeded",
    ),
  );
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    const frame = await run(
      binary,
      [
        ...result.tui.slice(1),
        "--snapshot",
        "--columns",
        String(columns),
        "--rows",
        String(rows),
      ],
      { cwd, maxBuffer: 1048576 },
    );
    assert.match(frame.stdout, /CHIPSIM/);
    assert.match(frame.stdout, /HC00/i);
    assert.equal(frame.stderr, "");
    const monitored = await run(
      binary,
      [
        "--watch",
        project,
        "--view",
        "activity",
        "--snapshot",
        "--columns",
        String(columns),
        "--rows",
        String(rows),
      ],
      { cwd, maxBuffer: 1048576 },
    );
    assert.match(monitored.stdout, /Agent activity/);
    assert.match(monitored.stdout, /WATCH LIVE/);
    assert.match(monitored.stdout, /HC00/i);
    assert.equal(monitored.stderr, "");
  }
  const python = `import json, subprocess, sys
binary, model, project = sys.argv[1:]
for args, expected in [(["check", model, "--project", project], 0), (["check", model], 2)]:
    result = subprocess.run([binary, "agent", *args], capture_output=True, text=True, check=False)
    report = json.loads(result.stdout)
    assert result.returncode == expected, report
    assert report["ok"] == (expected == 0), report
    assert result.stderr == "", result.stderr
print("Python subprocess: success and structured error verified")
`;
  const pythonResult = await run(
    "python3",
    ["-c", python, binary, model, project],
    { cwd },
  );
  process.stdout.write(pythonResult.stdout);
  console.log(
    `Installed ${pack.filename} offline; Node/Python JSON commands, real PDF/model/run, agent activity/watch and 80×24/120×40 TUI snapshots passed outside checkout.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
