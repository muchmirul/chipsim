import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { parseVCD, waveformVCD, validateWaveform } from "../src/hdl/vcd.js";
import { waveformModel } from "../src/hdl/trace.js";
import { compareBehavior } from "../src/hdl/compare.js";
import { readWaveform, digest } from "../src/hdl/io.js";
import { runHDL, readProject, processRun, hdlDoctor } from "../src/hdl/run.js";
import { TuiState } from "../src/tui/state.js";
import { TerminalApp } from "../src/tui/app.js";
import { render, screenText, displayWidth } from "../src/tui/render.js";
import { exportJSON, exportVCD, exportCSV } from "../src/trace/export.js";
import { formatPayload } from "../src/core/values.js";
import { timeLabel } from "../src/hdl/time.js";
import { searchBits } from "../src/hdl/values.js";

const exec = promisify(execFile),
  root = resolve(import.meta.dirname, "..");
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "chipsim-hdl-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const fixture = `$timescale 10 ps $end
$scope module tb $end
$var wire 1 ! clk $end
$var wire 4 a bus [3:0] $end
$var wire 4 a alias [3:0] $end
$var wire 1 b late $end
$var wire 64 c wide $end
$upscope $end
$enddefinitions $end
$dumpvars
0!
b10xz a
b1000000000000000000000000000000000000000000000000000000000000001 c
$end
#10
1!
b1 a
#10
b10 a
#12
0!
zb
#9007199254740993000
`;

test("VCD preserves hierarchy, aliases, per-bit logic, wide words, exact times and held values", () => {
  const wave = parseVCD(fixture),
    trace = waveformModel(wave).simulate();
  assert.deepEqual(
    wave.events.map((e) => e.time),
    ["0", "10", "12", "9007199254740993000"],
  );
  assert.equal(trace[0].signals["tb.bus"], "10XZ");
  assert.equal(trace[0].signals["tb.late"], undefined);
  assert.equal(trace[1].signals["tb.bus"], "0010");
  assert.equal(trace[1].signals["tb.alias"], "0010");
  assert.equal(trace[2].signals["tb.late"], "Z");
  assert.equal(trace[3].signals["tb.clk"], "0");
  assert.equal(
    formatPayload(trace[0].signals["tb.wide"], "hex", 64),
    "0x8000000000000001",
  );
  assert.equal(
    formatPayload(trace[0].signals["tb.wide"], "decimal", 64),
    "9223372036854775809",
  );
  assert.equal(searchBits("10", 4), "1010");
  assert.equal(searchBits("0b10XZ", 4), "10XZ");
  assert.equal(searchBits("X", 4), "XXXX");
  assert.equal(
    searchBits("0x8000000000000001", 64),
    trace[0].signals["tb.wide"],
  );
  assert.throws(() => searchBits("16", 4), /wider/);
  assert.equal(timeLabel("2500000", { magnitude: "1", unit: "fs" }), "2.5 ns");
  const roundtrip = parseVCD(waveformVCD(wave));
  assert.deepEqual(
    roundtrip.signals.map(({ id, width }) => ({ id, width })),
    wave.signals.map(({ id, width }) => ({ id, width })),
  );
  assert.equal(
    waveformModel(roundtrip).simulate()[3].signals["tb.wide"],
    trace[3].signals["tb.wide"],
  );
});

test("VCD rejects malformed, unsupported and unbounded data without coercing it", () => {
  for (const bad of [
    fixture.replace("10 ps", "3 ps"),
    fixture.replace("$timescale 10 ps $end", ""),
    fixture.replace("wire 4 a", "real 4 a"),
    fixture.replace("wire 4 a alias", "wire 8 a alias"),
    fixture.replace("b10xz a", "b11111 a"),
    fixture.replace("#12", "#9"),
    fixture.replace("#12", "#-1"),
    fixture.replace("b10xz a", "b0101 missing"),
    fixture.replace("b10xz a", "r1.2 a"),
    fixture.replace("wire 64 c", "wire 4097 c"),
    fixture.replace("$enddefinitions $end", "$enddefinitions"),
    fixture.replace("late", "clk"),
  ])
    assert.throws(() => parseVCD(bad));
  const wave = parseVCD(fixture);
  wave.events[1].changes["tb.bus"] = "1";
  assert.throws(() => validateWaveform(wave), /Invalid waveform change/);
});

function simple(bits, timescale = "1ns", end = "10") {
  return parseVCD(
    `$timescale ${timescale} $end\n$var wire 1 a out $end\n$enddefinitions $end\n0a\n#5\n${bits}a\n#${end}\n`,
  );
}
const mapping = { signals: [{ left: "out", right: "out", role: "output" }] };

test("comparison aligns physical time, catches pulses and reports duration/width/mapping errors", () => {
  const left = simple("1"),
    right = parseVCD(
      waveformVCD(left)
        .replace("1ns", "1ps")
        .replace("#5", "#5000")
        .replace("#10", "#10000"),
    );
  assert.equal(compareBehavior(left, right, mapping).match, true);
  const pulse = parseVCD(
    waveformVCD(left).replace("#10", "#6\nb0 v0\n#7\nb1 v0\n#10"),
  );
  const result = compareBehavior(left, pulse, mapping);
  assert.equal(result.match, false);
  assert.equal(result.firstDifferenceFs, "6000000");
  assert.equal(result.outputDifferences, 1);
  assert.equal(
    compareBehavior(left, pulse, {
      ...mapping,
      mode: "sampled",
      sampleEvery: "5ns",
    }).match,
    true,
  );
  assert.equal(
    compareBehavior(left, simple("1", "1ns", "11"), mapping).coverageMatches,
    false,
  );
  assert.equal(
    compareBehavior(left, simple("1", "1ns", "11"), mapping).match,
    false,
  );
  assert.throws(
    () => compareBehavior(left, right, { signals: [] }),
    /nonempty/,
  );
  assert.throws(
    () =>
      compareBehavior(left, right, {
        signals: [{ left: "missing", right: "out" }],
      }),
    /Missing signal/,
  );
  assert.throws(
    () => compareBehavior(left, right, { ...mapping, to: "11ns" }),
    /outside/,
  );
  assert.throws(
    () =>
      compareBehavior(left, right, {
        ...mapping,
        mode: "sampled",
        sampleEvery: "3ns",
      }),
    /endpoint/,
  );
});

test("comparison distinguishes X, Z and unavailable bits, and checks mapped stimulus", () => {
  assert.equal(compareBehavior(simple("x"), simple("z"), mapping).match, false);
  assert.equal(compareBehavior(simple("x"), simple("x"), mapping).match, true);
  const missing = parseVCD(
    "$timescale 1ns $end\n$var wire 1 a out $end\n$enddefinitions $end\n#10\n",
  );
  assert.equal(compareBehavior(missing, missing, mapping).match, false);
  const mismatch = compareBehavior(simple("0"), simple("1"), {
    signals: [{ left: "out", right: "out", role: "input" }],
  });
  assert.equal(mismatch.inputDifferences, 2);
  assert.match(mismatch.stimulus, /inputs differ/);
});

test("TUI loads, navigates, exports and restores external traces atomically at both terminal sizes", async (t) => {
  const dir = await temporary(t),
    s = new TuiState({ workspace: join(dir, "work") });
  await s.initialize();
  const wave = parseVCD(fixture);
  s.installWaveform(wave);
  assert.equal(s.documentId, null);
  s.jumpEdge("rise");
  assert.equal(s.tick, 1);
  s.jumpEdge("fall");
  assert.equal(s.tick, 2);
  const before = JSON.stringify(s.session());
  assert.throws(() => s.setDuration(50), /read-only/);
  assert.throws(() => s.driveInput("tb.clk", 1), /read-only/);
  assert.throws(() => s.installWaveform({ ...wave, timescale: {} }));
  assert.equal(JSON.stringify(s.session()), before);
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ]) {
    s.columns = columns;
    s.rows = rows;
    for (const view of [
      "wave",
      "inspect",
      "registers",
      "model",
      "log",
      "sources",
      "stimulus",
    ]) {
      s.view = view;
      const frame = render(s);
      assert.equal(frame.length, rows);
      assert.ok(frame.every((r) => displayWidth(r.text) <= columns));
      assert.match(screenText(s), /HDL waveform replay/);
      assert.match(screenText(s), /time 120 ps/);
    }
  }
  const model = s.model,
    trace = s.trace;
  assert.equal(JSON.parse(exportJSON(model, trace)).format, "chipsim-waveform");
  assert.match(exportCSV(model, trace), /"simulator_time","time_unit"/);
  assert.match(exportVCD(model, trace), /timescale 10ps/);
  await writeFile(join(dir, "saved.json"), JSON.stringify(s.session()));
  s.selectModel("pio");
  await s.loadFile(join(dir, "saved.json"));
  assert.equal(s.tick, 2);
  assert.equal(s.snapshot.signals["tb.bus"], "0010");
  const input = new EventEmitter(),
    output = new EventEmitter();
  input.setRawMode = input.pause = () => {};
  output.write = () => {};
  const app = new TerminalApp(s, { input, output });
  app.key("H", { name: "h" });
  assert.match(s.menu.title, /HDL/);
  assert.equal(s.menu.items.length, 3);
});

test("runner bounds/cancels processes and reports missing tools", async () => {
  const result = await processRun(
    process.execPath,
    ["-e", "setInterval(()=>{}, 1000)"],
    { timeoutMs: 100 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  const missing = await processRun("chipsim-no-such-simulator", []);
  assert.match(missing.reason, /not installed/);
  const abort = new AbortController();
  const running = processRun(
    process.execPath,
    ["-e", "setInterval(()=>{}, 1000)"],
    { signal: abort.signal },
  );
  abort.abort();
  assert.equal((await running).reason, "cancelled");
  assert.equal(
    (
      await processRun(process.execPath, [
        "-e",
        "process.stdout.write('x'.repeat(2000000))",
      ])
    ).ok,
    false,
  );
});

test("manifest rejects commands, outside paths, and noninteger parameters", async (t) => {
  const dir = await temporary(t),
    path = join(dir, "project.json");
  const base = {
    format: "chipsim-hdl-project",
    version: 1,
    language: "verilog",
    sources: ["x.v"],
    top: "tb",
  };
  for (const project of [
    { ...base, sources: ["../x.v"] },
    { ...base, command: "echo" },
    { ...base, parameters: { x: "evil" } },
    { ...base, timeoutMs: 0 },
    { ...base, waveform: "../x.vcd" },
  ]) {
    await writeFile(path, JSON.stringify(project));
    await assert.rejects(readProject(path));
  }
  await writeFile(path, JSON.stringify(base));
  await symlink("/etc/passwd", join(dir, "x.v"));
  await assert.rejects(runHDL(path, join(dir, "output")), /symbolic links/);
});

// Required integration gate: unlike unit tests, never silently skips missing
// backends. npm run test:hdl exercises both real open-source simulators.
test(
  "open-source Verilog/VHDL runs and independent 256-case arithmetic oracle",
  { skip: !process.env.CHIPSIM_TEST_HDL },
  async (t) => {
    const dir = await temporary(t),
      tools = await hdlDoctor();
    assert.ok(
      tools.every((tool) => tool.available),
      "Install iverilog, vvp and ghdl before running test:hdl",
    );
    const provenance = JSON.parse(
      await readFile(
        join(root, "examples/hdl/upstream/provenance.json"),
        "utf8",
      ),
    );
    for (const file of provenance.files)
      assert.equal(
        digest(await readFile(join(root, "examples/hdl", file.file))),
        file.sha256,
      );
    const results = [];
    for (const language of ["verilog", "vhdl"]) {
      const manifest = join(
        root,
        `examples/hdl/adder-${language}.project.json`,
      );
      const run = await runHDL(manifest, join(dir, language));
      assert.equal(run.result.ok, true, JSON.stringify(run.result));
      assert.ok(run.result.stages.every((s) => s.ok));
      await assert.rejects(
        runHDL(manifest, join(dir, language)),
        /already exists/,
      );
      const wave = await readWaveform(run.result.artifacts.vcd);
      const bus = language === "verilog" ? "adder_tb.X" : "adder_tb.x[4:0]";
      const oracle = {
        format: "chipsim-trace",
        version: 1,
        model: { signals: [{ id: "sum", width: 5 }] },
        trace: Array.from({ length: 256 }, (_, tick) => ({
          tick,
          signals: { sum: Math.floor(tick / 16) + (tick % 16) },
          registers: {},
        })),
      };
      const config = {
        mode: "sampled",
        rightTick: "5ns",
        sampleEvery: "5ns",
        from: "0ns",
        to: "1275ns",
        signals: [{ left: bus, right: "signal.sum" }],
      };
      assert.equal(compareBehavior(wave, oracle, config).match, true);
      assert.throws(
        () =>
          compareBehavior(wave, oracle, { ...config, rightTick: undefined }),
        /explicit/,
      );
      const wrong = structuredClone(oracle);
      wrong.trace[10].signals.sum++;
      const mismatch = compareBehavior(wave, wrong, config);
      assert.equal(mismatch.firstDifferenceFs, "50000000");
      assert.equal(mismatch.changedSamples, 1);
      results.push(run);
    }
    const config = JSON.parse(
      await readFile(join(root, "examples/hdl/adder-compare.json"), "utf8"),
    );
    const comparison = compareBehavior(
      results[0].waveform,
      results[1].waveform,
      config,
    );
    assert.equal(comparison.match, true);
    assert.equal(comparison.samples, 256);
    // Compare actual sourced ChipSim logic, not only the arithmetic oracle.
    const { extractPDFFile } = await import("../src/documents/extract-node.js");
    const { analyzeDocument } = await import("../src/model/from-document.js");
    const { registerModel } = await import("../src/models/index.js");
    const doc = await extractPDFFile(
      join(root, "docs/references/74hc00/nexperia-74hc00.pdf"),
    );
    const spec = analyzeDocument(doc).models[0].spec;
    const model = registerModel(spec, [doc]);
    const inputs = Array.from({ length: 256 }, (_, tick) => [
      { tick, signal: "pin_1a", value: Math.floor(tick / 16) & 1 },
      { tick, signal: "pin_1b", value: tick & 1 },
    ]).flat();
    const trace = model.simulate({}, { inputs, ticks: 255 });
    const exported = JSON.parse(exportJSON(model, trace, {}, inputs));
    assert.equal(
      compareBehavior(results[0].waveform, exported, {
        mode: "sampled",
        rightTick: "5ns",
        sampleEvery: "5ns",
        from: "0ns",
        to: "1275ns",
        signals: [
          { left: "adder_tb.nand_a", right: "signal.pin_1a", role: "input" },
          { left: "adder_tb.nand_b", right: "signal.pin_1b", role: "input" },
          { left: "adder_tb.nand_probe", right: "signal.pin_1y" },
        ],
      }).match,
      true,
    );
    // Public CLI: one JSON result, mismatch status, import and TUI rendering.
    const cli = join(root, "scripts/chipsim.mjs");
    const imported = JSON.parse(
      (
        await exec(process.execPath, [
          cli,
          "hdl",
          "import",
          results[0].result.artifacts.vcd,
          "--out",
          join(dir, "imported"),
        ])
      ).stdout,
    );
    assert.equal(imported.ok, true);
    for (const [columns, rows] of [
      [80, 24],
      [120, 40],
    ]) {
      const frame = await exec(
        process.execPath,
        [
          cli,
          "--vcd",
          imported.artifacts.waveform,
          "--snapshot",
          "--columns",
          String(columns),
          "--rows",
          String(rows),
        ],
        { cwd: dir },
      );
      assert.match(frame.stdout, /HDL waveform replay/);
    }
    const cliComparison = await exec(process.execPath, [
      cli,
      "hdl",
      "compare",
      results[0].result.artifacts.vcd,
      results[1].result.artifacts.vcd,
      "--map",
      join(root, "examples/hdl/adder-compare.json"),
      "--out",
      join(dir, "comparison"),
    ]);
    assert.equal(JSON.parse(cliComparison.stdout).comparison.match, true);
    await writeFile(
      join(dir, "mapping.json"),
      JSON.stringify({
        signals: [{ left: "adder_tb.A", right: "adder_tb.B" }],
      }),
    );
    try {
      await exec(process.execPath, [
        cli,
        "hdl",
        "compare",
        results[0].result.artifacts.vcd,
        results[0].result.artifacts.vcd,
        "--map",
        join(dir, "mapping.json"),
      ]);
      assert.fail("Expected mismatch exit status");
    } catch (error) {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).comparison.match, false);
    }
  },
);

test(
  "failed HDL compilation and assertions retain diagnostics and partial waveform",
  { skip: !process.env.CHIPSIM_TEST_HDL },
  async (t) => {
    const dir = await temporary(t),
      project = join(dir, "project.json");
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
    await writeFile(join(dir, "tb.v"), "invalid syntax");
    const bad = await runHDL(project, join(dir, "bad"));
    assert.equal(bad.result.ok, false);
    assert.match(
      await readFile(bad.result.artifacts.diagnostics, "utf8"),
      /syntax error/,
    );
    await writeFile(
      join(dir, "tb.v"),
      '`timescale 1ns/1ps\nmodule tb; reg x=0; initial begin $dumpfile("trace.vcd"); $dumpvars(0,tb); #1; x=1; #1; $fatal(1,"intentional assertion failure"); end endmodule',
    );
    const fault = await runHDL(project, join(dir, "fault"));
    assert.equal(fault.result.ok, false);
    assert.ok(fault.waveform);
    assert.match(fault.result.error, /HDL run failed|assertion failure/);
    assert.equal(
      waveformModel(fault.waveform).simulate().at(-1).signals["tb.x"],
      "1",
    );
    await writeFile(
      project,
      JSON.stringify({
        format: "chipsim-hdl-project",
        version: 1,
        language: "vhdl",
        sources: ["tb.vhdl"],
        top: "tb",
      }),
    );
    await writeFile(join(dir, "tb.vhdl"), "invalid syntax");
    const vhdlBad = await runHDL(project, join(dir, "vhdl-bad"));
    assert.equal(vhdlBad.result.ok, false);
    assert.equal(vhdlBad.result.stages[0].stage, "analyze");
    assert.ok(vhdlBad.result.stages[0].stderr);
    await writeFile(
      join(dir, "tb.vhdl"),
      `library ieee; use ieee.std_logic_1164.all;
entity tb is end; architecture test of tb is signal x: std_logic := '0';
begin process begin wait for 1 ns; x <= '1'; wait for 1 ns;
assert false report "intentional assertion failure" severity failure; wait;
end process; end;`,
    );
    const vhdlFault = await runHDL(project, join(dir, "vhdl-fault"));
    assert.equal(vhdlFault.result.ok, false);
    assert.ok(vhdlFault.waveform);
    assert.match(vhdlFault.result.error, /intentional assertion failure/);
    assert.equal(
      waveformModel(vhdlFault.waveform).simulate().at(-1).signals["tb.x"],
      "1",
    );
  },
);
