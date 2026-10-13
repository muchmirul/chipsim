import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runHDL } from "../src/hdl/run.js";
import { toolArguments, toolCommands } from "../src/integrations/extension.js";
import { adapterIdentity, adapters } from "../src/design/adapters.js";

const exec = promisify(execFile);
const root = resolve(new URL("../", import.meta.url).pathname);
const cli = (...args) =>
  exec(process.execPath, ["scripts/chipsim.mjs", ...args], {
    cwd: root,
    maxBuffer: 4 * 1048576,
  });

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "chipsim-hdl-defaults-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("HDL native tools preserve omitted, enabled and explicitly disabled debug", () => {
  const spec = toolCommands.find(
    (s) => s.family === "hdl" && s.command === "run",
  );
  const params = { project: "sim.json", out: "run" };
  assert.deepEqual(toolArguments(spec, params, "/tmp"), [
    "hdl",
    "run",
    "--out",
    "/tmp/run",
    "/tmp/sim.json",
  ]);
  assert.ok(
    toolArguments(spec, { ...params, debug: true }, "/tmp").includes("--debug"),
  );
  assert.ok(
    toolArguments(spec, { ...params, debug: false }, "/tmp").includes(
      "--no-debug",
    ),
  );
});

test("HDL CLI rejects duplicate/conflicting capture flags and unrelated no-debug", async () => {
  for (const args of [
    ["hdl", "run", "x.json", "--debug", "--no-debug", "--out", "unused"],
    ["hdl", "run", "x.json", "--no-debug", "--no-debug", "--out", "unused"],
    ["hdl", "doctor", "--no-debug"],
    ["hdl", "import", "x.vcd", "--no-debug", "--out", "unused"],
    ["--no-debug", "--snapshot"],
  ]) {
    await assert.rejects(
      cli(...args),
      (error) =>
        error.code === 2 || /--no-debug requires --hdl/.test(error.stderr),
    );
  }
});

test("default capture fails explicitly without observers and preserves diagnostic recording", async (t) => {
  const dir = await temporary(t);
  const previous = process.env.CHIPSIM_HDL_DEBUG_TOOLS;
  process.env.CHIPSIM_HDL_DEBUG_TOOLS = join(dir, "missing-tools");
  try {
    const project = join(dir, "sim.json");
    await writeFile(
      project,
      JSON.stringify({
        format: "chipsim-hdl-project",
        version: 1,
        language: "verilog",
        sources: ["tb.v"],
        top: "tb",
      }),
    );
    await writeFile(join(dir, "tb.v"), "module tb; initial $finish; endmodule");
    const run = await runHDL(project, join(dir, "run"));
    assert.equal(run.result.ok, false);
    assert.equal(run.result.stages[0].stage, "debug-setup");
    assert.match(run.result.error, /--no-debug/);
    assert.ok(run.result.artifacts.debug);
    const data = JSON.parse(await readFile(run.result.artifacts.debug, "utf8"));
    assert.equal(data.status.complete, false);
    assert.equal(data.sources.length, 1);
    assert.equal(data.events.length, 0);
    assert.deepEqual(
      await adapterIdentity({ adapter: "hdl", options: { debug: false } }),
      {},
    );
    const stock = await adapters.hdl.tools(
      { options: { project: "sim.json", debug: false } },
      dir,
    );
    assert.equal(stock[0][0], "iverilog");
    await assert.rejects(
      adapters.hdl.tools({ options: { project: "sim.json" } }, dir),
      /--no-debug/,
    );
  } finally {
    if (previous === undefined) delete process.env.CHIPSIM_HDL_DEBUG_TOOLS;
    else process.env.CHIPSIM_HDL_DEBUG_TOOLS = previous;
  }
});

test(
  "default CLI launch and managed runs capture linked debug; explicit opt-out stays waveform only",
  { skip: process.env.CHIPSIM_TEST_HDL_DEBUG !== "1", timeout: 120000 },
  async (t) => {
    const dir = await temporary(t);
    const project = resolve(root, "examples/hdl/counter-verilog.project.json");
    const captured = JSON.parse(
      (await cli("hdl", "run", project, "--out", join(dir, "capture"))).stdout,
    );
    assert.equal(captured.ok, true);
    assert.ok(captured.artifacts.debug);
    assert.equal(captured.tui[1], "--hdl-debug");
    const frame = (
      await cli(
        "--hdl",
        project,
        "--hdl-out",
        join(dir, "launch"),
        "--snapshot",
        "--columns",
        "120",
        "--rows",
        "40",
      )
    ).stdout;
    for (const pane of ["HDL SOURCE", "RTL HARDWARE", "SIGNALS"])
      assert.ok(frame.includes(pane));
    const wave = JSON.parse(
      (
        await cli(
          "hdl",
          "run",
          project,
          "--no-debug",
          "--out",
          join(dir, "stock"),
        )
      ).stdout,
    );
    assert.equal(wave.ok, true);
    assert.equal(wave.artifacts.debug, undefined);
    assert.equal(wave.tui[1], "--vcd");
    const ordinary = (
      await cli(
        "--hdl",
        project,
        "--hdl-out",
        join(dir, "stock-launch"),
        "--no-debug",
        "--snapshot",
      )
    ).stdout;
    assert.match(ordinary, /HDL waveform replay/);
    const { cp } = await import("node:fs/promises");
    const managed = join(dir, "managed");
    await cp(join(root, "examples/design/minimal"), managed, {
      recursive: true,
    });
    const identity = await adapterIdentity({
      adapter: "hdl",
      options: { project: "sim.project.json" },
    });
    assert.equal(identity.instrumentation, "chipsim-1");
    const tools = await adapters.hdl.tools(
      { options: { project: "sim.project.json" } },
      managed,
    );
    assert.notEqual(tools[0][0], "iverilog");
    const result = JSON.parse(
      (
        await cli(
          "design",
          "run",
          "--project",
          managed,
          "--target",
          "simulation",
          "--wait",
          "--timeout-ms",
          "30000",
        )
      ).stdout,
    );
    assert.equal(result.job.ready, true);
    const inventory = JSON.parse(
      (await cli("artifact", "list", "--project", managed)).stdout,
    );
    assert.ok(inventory.artifacts.some((a) => a.kind === "hdl-debug"));
  },
);
