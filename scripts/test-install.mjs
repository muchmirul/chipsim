#!/usr/bin/env node
// Pack/install outside the checkout without fetching dependencies or launching
// a model provider. Exercise the public process contract agents actually use.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
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
    "extensions/chipsim.ts",
    "src/integrations/extension.js",
    "src/integrations/process.js",
    "src/design/commands.js",
    "src/design/contracts.js",
    "src/design/guide.js",
    "src/design/physical.js",
    "scripts/design-klayout.py",
    "docs/AGENT_EXTENSIONS.md",
    "src/agent/activity.js",
    "src/agent/context.js",
    "src/agent/program.js",
    "src/program/engine.js",
    "src/program/guides.js",
    "src/tui/program-panel.js",
    "src/tui/visual-panel.js",
    "src/tui/visual-render.js",
    "src/visualization/state-graph.js",
    "src/visualization/flow.js",
    "src/visualization/experiments.js",
    "src/tui/agent-monitor.js",
    "src/tui/activity-panel.js",
    "docs/AGENT_WORKFLOW.md",
    "docs/AGENT_PROJECT.md",
    "docs/DESIGN_INPUTS.md",
    "examples/design/minimal/counter.v",
    "examples/design/minimal/counter_tb.v",
    "examples/design/minimal/sim.project.json",
    "examples/design/minimal/chipsim.design.json",
    "examples/design/minimal/chipsim.lock.json",
    "docs/CHANGELOG.md",
    "docs/VISUALIZATION.md",
    "docs/TUI.md",
    "docs/DEVELOPMENT.md",
    "docs/MODEL_FORMAT.md",
    "docs/PROGRAMMING.md",
    "docs/EXISTING_SIMULATORS.md",
    "docs/HDL.md",
    "docs/HDL_DEBUG.md",
    "extensions/hdl-debug/COPYING",
    "extensions/hdl-debug/README.md",
    "extensions/hdl-debug/iverilog/apply.py",
    "extensions/hdl-debug/iverilog/chipsim-debug.cc",
    "extensions/hdl-debug/ghdl/apply.py",
    "extensions/hdl-debug/ghdl/grt-chipsim.adb",
    "scripts/build-hdl-debug.sh",
    "src/hdl/debug/recording.js",
    "src/tui/debug-render.js",
    "examples/hdl/counter.sv",
    "examples/hdl/counter.vhdl",
    "src/hdl/vcd.js",
    "src/hdl/run.js",
    "scripts/hdl.mjs",
    "examples/hdl/upstream/adder.sv",
    "examples/hdl/upstream/adder.vhdl",
    "examples/hdl/upstream/provenance.json",
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
  assert.ok(
    !pack.files.some((file) =>
      /^(?:src\/ui\/|src\/documents\/(?:pdf|store)\.js$|scripts\/(?:build|serve)\.mjs$|(?:index|chipsim)\.html$|\.generated\/|playwright\.)/.test(
        file.path,
      ),
    ),
    "The installed package must contain only terminal interfaces and headless support tools",
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
  const { debugFixture } = await import("../test/fixtures/hdl-debug.mjs");
  const recordingPath = join(cwd, "portable-debug.json");
  await writeFile(recordingPath, JSON.stringify(debugFixture(20)));
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    const { stdout } = await run(
      binary,
      [
        "--hdl-debug",
        recordingPath,
        "--view",
        "debug",
        "--at-event",
        "3",
        "--snapshot",
        "--columns",
        String(columns),
        "--rows",
        String(rows),
      ],
      {
        cwd,
        env: {
          ...process.env,
          CHIPSIM_HDL_DEBUG_TOOLS: join(cwd, "no-simulator"),
        },
      },
    );
    for (const title of ["HDL SOURCE", "RTL HARDWARE", "SIGNALS"])
      assert.ok(stdout.includes(title + " · e3"));
  }
  await assert.rejects(
    run(
      binary,
      ["--hdl-debug", recordingPath, "--snapshot", "--at-event", "999"],
      { cwd },
    ),
    (error) => /outside the recording/.test(error.stderr),
  );
  for (const [view, tick, expected] of [
    ["states", "32", "Current: wait · Focus: wait"],
    ["flow", "2", "CAPTURE bit 0"],
    ["compare", "0", "No reference captured"],
  ]) {
    const result = await run(
      binary,
      [
        "--model",
        "pio",
        "--view",
        view,
        "--at",
        tick,
        "--snapshot",
        "--no-color",
      ],
      { cwd, maxBuffer: 1048576 },
    );
    assert.ok(
      result.stdout.includes(expected),
      "Installed visualization failed: " + view,
    );
  }
  const hdlInput = join(cwd, "external.vcd");
  await writeFile(
    hdlInput,
    "$timescale 1ns $end\n$var wire 1 a out $end\n$enddefinitions $end\n0a\n#5\n1a\n#10\n",
  );
  const hdlResult = JSON.parse(
    (
      await run(
        binary,
        ["hdl", "import", hdlInput, "--out", join(cwd, "hdl import")],
        { cwd },
      )
    ).stdout,
  );
  assert.equal(hdlResult.ok, true);
  await writeFile(
    join(cwd, "hdl-map.json"),
    JSON.stringify({ signals: [{ left: "out", right: "out" }] }),
  );
  const compared = JSON.parse(
    (
      await run(
        binary,
        [
          "hdl",
          "compare",
          hdlInput,
          hdlResult.artifacts.waveform,
          "--map",
          join(cwd, "hdl-map.json"),
        ],
        { cwd },
      )
    ).stdout,
  );
  assert.equal(compared.comparison.match, true);
  assert.match(
    (
      await run(binary, ["--vcd", hdlResult.artifacts.waveform, "--snapshot"], {
        cwd,
      })
    ).stdout,
    /HDL waveform replay/,
  );
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
  assert.deepEqual(help.designGuidance.command, ["design", "guide"]);
  assert.match(
    await readFile(help.documentation["DESIGN_INPUTS.md"], "utf8"),
    /optional recipes/,
  );
  assert.match(
    await readFile(help.documentation["MODEL_FORMAT.md"], "utf8"),
    /schemaVersion/,
  );
  assert.equal((await cli(["doctor"])).pdfTools.length, 2);
  const installed = join(prefix, "lib/node_modules/chipsim");
  const metadata = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.deepEqual(metadata.pi.extensions, ["./extensions/chipsim.ts"]);
  // Exercise the installed bridge, not a checkout import or PATH-resolved binary.
  const bridgeProbe = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { runChipSim } from ${JSON.stringify(pathToFileURL(join(installed, "src/integrations/process.js")).href)};
    const result = await runChipSim(["agent", "context", "pio"], { cwd: process.cwd() });
    if (!result.ok) throw new Error(JSON.stringify(result));
    console.log(JSON.stringify(result));
  `,
    ],
    { cwd, maxBuffer: 2 * 1048576 },
  );
  assert.equal(JSON.parse(bridgeProbe.stdout).ok, true);
  const controllerProbe = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {registerChipSim} from ${JSON.stringify(pathToFileURL(join(installed, "src/integrations/extension.js")).href)};
    const tools = new Map();
    const Type = new Proxy({}, {get: () => (value) => value});
    registerChipSim({registerTool: t => tools.set(t.name,t), registerCommand() {}}, Type);
    const call = args => tools.get('chipsim_command').execute('installed-test', {args}, undefined, undefined, {cwd:process.cwd()});
    await call(['design','init','controller project']);
    const catalog = await call(['design','commands']);
    if (!catalog.details.commands.some(c => c.family === 'design' && c.command === 'status')) throw new Error('Controller discovery failed');
    const guide = await call(catalog.details.guidance.command.concat('rtl'));
    if (!guide.details.guide.optional || !guide.details.guide.recipe.minimumInputs.length) throw new Error('Input guidance failed');
    if (!guide.details.guide.starter.directory.startsWith(${JSON.stringify(installed)} + '/')) throw new Error('Starter path escaped installed package');
    const status = await call(['design','status','--project','controller project']);
    if (status.details.ready !== false || !status.details.actions.length) throw new Error('Controller status failed');
    const help = await call(['design','help']);
    if (!help.details.ok) throw new Error(JSON.stringify(help));
    console.log(JSON.stringify(help.details));
  `,
    ],
    { cwd, maxBuffer: 1048576 },
  );
  assert.equal(
    JSON.parse(controllerProbe.stdout).format,
    "chipsim-design-result",
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(cwd, "controller project/chipsim.design.json"),
        "utf8",
      ),
    ).format,
    "chipsim-design",
  );
  const backendCheck = JSON.parse(
    (await run(binary, ["hdl", "doctor"], { cwd })).stdout,
  );
  if (
    backendCheck.tools
      .filter((t) => ["iverilog", "vvp"].includes(t.command))
      .every((t) => t.available)
  ) {
    const guided = JSON.parse(
      (await run(binary, ["design", "guide", "rtl"], { cwd })).stdout,
    ).guide;
    const starter = join(cwd, "guided chip");
    await cp(guided.starter.directory, starter, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    // This gate checks stock backends; debug capture is covered separately.
    const starterConfigPath = join(starter, "chipsim.design.json");
    const starterConfig = JSON.parse(await readFile(starterConfigPath, "utf8"));
    starterConfig.tasks.simulate.options.debug = false;
    await writeFile(starterConfigPath, JSON.stringify(starterConfig));
    const simulated = JSON.parse(
      (
        await run(
          binary,
          [
            "design",
            "run",
            "--project",
            starter,
            "--target",
            "simulation",
            "--wait",
            "--timeout-ms",
            "30000",
          ],
          { cwd, maxBuffer: 2 * 1048576 },
        )
      ).stdout,
    );
    assert.equal(simulated.job.ready, true);
  }
  if (backendCheck.tools.every((tool) => tool.available)) {
    for (const language of ["verilog", "vhdl"]) {
      const hdlRun = JSON.parse(
        (
          await run(
            binary,
            [
              "hdl",
              "run",
              join(installed, `examples/hdl/adder-${language}.project.json`),
              "--no-debug",
              "--out",
              join(cwd, "installed hdl " + language),
            ],
            { cwd },
          )
        ).stdout,
      );
      assert.equal(hdlRun.ok, true);
      assert.ok(hdlRun.tools.every((tool) => tool.available));
    }
  }
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
  assert.match(
    await readFile(join(project, "AGENTS.md"), "utf8"),
    /docs\/CHANGELOG\.md/,
  );
  assert.match(
    await readFile(join(project, "AGENTS.md"), "utf8"),
    /only\s+interactive frontend is the TUI/,
  );
  for (const file of [
    "CHANGELOG.md",
    "TUI.md",
    "DEVELOPMENT.md",
    "VISUALIZATION.md",
    "DESIGN_INPUTS.md",
  ])
    assert.equal(
      await readFile(join(project, "docs", file), "utf8"),
      await readFile(join(installed, "docs", file), "utf8"),
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
