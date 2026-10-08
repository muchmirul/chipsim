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
    "docs/AGENT_WORKFLOW.md",
    "docs/AGENT_PROJECT.md",
    "docs/MODEL_FORMAT.md",
    "AGENTS.md",
    "docs/references/espressif-esp32-c6-trm.pdf",
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
  const project = join(cwd, "agent work");
  const prepared = await cli([
    "prepare",
    join(installed, "docs/references/nexperia-74hc00.pdf"),
    "--out",
    project,
  ]);
  assert.ok(prepared.models.length);
  const model = join(project, prepared.models[0].file);
  await cli(["search", project, "function"]);
  await cli(["page", project, "1"]);
  await cli(["check", model, "--project", project]);
  const result = await cli([
    "run",
    model,
    "--project",
    project,
    "--out",
    join(cwd, "experiment"),
  ]);
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
    `Installed ${pack.filename} offline; Node/Python JSON commands, real PDF/model/run and 80×24/120×40 TUI snapshots passed outside checkout.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
