import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHDL, readProject } from "../src/hdl/run.js";
import { digest, readWaveform } from "../src/hdl/io.js";
import { scaleFs } from "../src/hdl/time.js";
import { HDLRecording } from "../src/hdl/debug/recording.js";

const real =
    process.env.CHIPSIM_TEST_HDL === "1" ||
    process.env.CHIPSIM_TEST_HDL_DEBUG === "1",
  debug = process.env.CHIPSIM_TEST_HDL_DEBUG === "1",
  profile = {
    format: "chipsim-digital-environment",
    version: 1,
    timeUnit: "1ns",
    seed: 1,
    channels: [
      {
        name: "pin",
        initial: 0,
        delayTicks: 2,
        offsetTicks: 1,
        jitterTicks: 0,
        events: [
          { tick: 10, value: 1 },
          { tick: 30, value: 0 },
        ],
        glitches: [{ tick: 22, durationTicks: 2 }],
      },
    ],
  };

const source = `\`timescale 1ns/1ps
module sampled_pin(input wire pin, input wire capture, output reg value=0);
  always @(posedge capture) value <= pin;
endmodule
module tb;
  parameter integer FAIL_ASSERTION=0;
  wire [0:0] nominal, disturbed;
  reg capture=0;
  reg expected;
  wire sampled;
  chipsim_environment env(.nominal(nominal), .disturbed(disturbed));
  sampled_pin dut(.pin(disturbed[0]), .capture(capture), .value(sampled));
  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0,tb);
    #11;
    if (nominal[0] !== 1'b1) $fatal(1,"nominal edge missing");
    // Sample one tick after the zero-delay profile's edge, not on that edge.
    #1;
    expected=disturbed[0];
    capture=1;
    #1;
    if (sampled !== expected) $fatal(1,"DUT did not capture disturbed pin");
    capture=0;
    #1;
    if (disturbed[0] !== 1'b1) $fatal(1,"delayed edge missing");
    capture=1;
    #1;
    if (sampled !== 1'b1) $fatal(1,"DUT did not capture delayed edge");
    capture=0;
    if (FAIL_ASSERTION) $fatal(1,"intentional environment assertion failure");
    #8;
    if (disturbed[0] !== 1'b0) $fatal(1,"glitch missing");
    #2;
    if (disturbed[0] !== 1'b1) $fatal(1,"glitch did not end");
    #9;
    if (nominal[0] !== 1'b0 || disturbed[0] !== 1'b0)
      $fatal(1,"falling edge missing");
    #1;
    $finish;
  end
endmodule
`;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-environment-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "tb.sv"), source);
  return root;
}

async function project(root, name, environment = profile, extra = {}) {
  const path = join(root, name + ".json");
  await writeFile(
    path,
    JSON.stringify({
      format: "chipsim-hdl-project",
      version: 1,
      language: "verilog",
      standard: "2012",
      top: "tb",
      sources: ["tb.sv"],
      environment,
      ...extra,
    }),
  );
  return path;
}

function settled(data, ns) {
  const values = {},
    target = BigInt(ns) * 1000000n;
  for (const event of data.events) {
    if (BigInt(event.time) * scaleFs(data.timescale) > target) break;
    Object.assign(values, event.changes);
  }
  return values;
}

async function environmentArtifacts(
  run,
  expectedProfile,
  expectedSource = source,
) {
  assert.equal(
    run.result.artifacts.environment,
    join(run.result.root, "environment.json"),
  );
  const report = JSON.parse(
    await readFile(run.result.artifacts.environment, "utf8"),
  );
  assert.deepEqual(report.profile, expectedProfile);
  assert.deepEqual(run.result.project.environment, expectedProfile);
  assert.deepEqual(
    run.result.sources.map((entry) => entry.file),
    ["tb.sv", "chipsim_environment.sv"],
  );
  for (const entry of run.result.sources) {
    const bytes = await readFile(join(run.result.root, "sources", entry.file));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, digest(bytes), entry.file);
  }
  assert.equal(run.result.sources[0].sha256, digest(expectedSource));
  assert.deepEqual(report.generatedSource, {
    file: "chipsim_environment.sv",
    sha256: run.result.sources[1].sha256,
  });
  return report;
}

test("HDL manifest validates inline environments and rejects unsupported languages", async (t) => {
  const root = await workspace(t),
    valid = await project(root, "valid");
  assert.deepEqual((await readProject(valid)).environment, profile);
  const invalid = structuredClone(profile);
  invalid.channels = [];
  await assert.rejects(readProject(await project(root, "invalid", invalid)));
  for (const extra of [
    { language: "vhdl", standard: "08" },
    { standard: "2005" },
  ])
    await assert.rejects(
      readProject(await project(root, "unsupported", profile, extra)),
      /SystemVerilog/,
    );
});

test("environment source reservation and aggregate file budget reject before backend execution", async (t) => {
  const root = await workspace(t);
  await writeFile(
    join(root, "chipsim_environment.sv"),
    "// authored fixture must survive\n",
  );
  for (const extra of [{ assets: ["chipsim_environment.sv"] }]) {
    const destination = join(
      root,
      "reserved-" + (extra.assets ? "asset" : "waveform"),
    );
    await assert.rejects(
      runHDL(await project(root, "reserved", profile, extra), destination, {
        debug: false,
      }),
      /reserved/,
    );
    assert.equal(
      await readFile(join(root, "chipsim_environment.sv"), "utf8"),
      "// authored fixture must survive\n",
    );
  }
  const files = Array.from({ length: 256 }, (_, i) => "f" + i + ".sv");
  await Promise.all(
    files.map((file) => writeFile(join(root, file), "// bounded input\n")),
  );
  await assert.rejects(
    runHDL(
      await project(root, "full", profile, {
        sources: files.slice(0, 128),
        assets: files.slice(128),
      }),
      join(root, "too-many"),
      { debug: false },
    ),
    /exceed 256/,
  );
});

// Real backend gates must fail on missing tools, not silently skip them.
test(
  "native digital environment drives DUT capture, waveform and fingerprinted artifacts",
  { skip: !real, timeout: 120000 },
  async (t) => {
    const root = await workspace(t),
      manifest = await project(root, "delayed"),
      destination = join(root, "delayed-run"),
      delayed = await runHDL(manifest, destination, { debug: false });
    assert.equal(delayed.result.ok, true, delayed.result.error);
    await environmentArtifacts(delayed, profile);
    const wave = await readWaveform(delayed.result.artifacts.vcd);
    assert.deepEqual(wave.events, delayed.waveform.events);
    for (const [ns, nominal, disturbed] of [
      [11, "1", "0"],
      [14, "1", "1"],
      [23, "1", "0"],
      [25, "1", "1"],
      [34, "0", "0"],
    ]) {
      const values = settled(wave, ns);
      assert.equal(values["tb.nominal"], nominal, `nominal at ${ns}ns`);
      assert.equal(values["tb.disturbed"], disturbed, `disturbed at ${ns}ns`);
      assert.equal(values["tb.dut.pin"], disturbed, `DUT pin at ${ns}ns`);
    }
    assert.equal(settled(wave, 13)["tb.sampled"], "0");
    assert.equal(settled(wave, 15)["tb.sampled"], "1");
    assert.ok(delayed.result.stages.every((stage) => stage.ok));

    const before = await readFile(delayed.result.artifacts.result, "utf8"),
      beforeEnvironment = await readFile(
        delayed.result.artifacts.environment,
        "utf8",
      );
    await assert.rejects(
      runHDL(manifest, destination, { debug: false }),
      /already exists/,
    );
    assert.equal(
      await readFile(delayed.result.artifacts.result, "utf8"),
      before,
    );
    assert.equal(
      await readFile(delayed.result.artifacts.environment, "utf8"),
      beforeEnvironment,
    );

    const immediateProfile = structuredClone(profile);
    immediateProfile.channels[0].delayTicks = 0;
    const immediate = await runHDL(
      await project(root, "immediate", immediateProfile),
      join(root, "immediate-run"),
      { debug: false },
    );
    assert.equal(immediate.result.ok, true, immediate.result.error);
    await environmentArtifacts(immediate, immediateProfile);
    const immediateWave = await readWaveform(immediate.result.artifacts.vcd);
    assert.equal(settled(immediateWave, 11)["tb.disturbed"], "1");
    assert.equal(settled(immediateWave, 13)["tb.sampled"], "1");
    assert.equal(settled(immediateWave, 15)["tb.sampled"], "1");
    assert.equal(
      delayed.result.sources[0].sha256,
      immediate.result.sources[0].sha256,
      "the DUT and sampling testbench are unchanged",
    );
    assert.notEqual(
      delayed.result.sources[1].sha256,
      immediate.result.sources[1].sha256,
    );
  },
);

test(
  "failed environment assertions retain the profile, generated source and partial waveform",
  { skip: !real, timeout: 120000 },
  async (t) => {
    const root = await workspace(t),
      manifest = await project(root, "fault", profile, {
        parameters: { FAIL_ASSERTION: 1 },
      }),
      run = await runHDL(manifest, join(root, "fault-run"), { debug: false });
    assert.equal(run.result.ok, false);
    assert.match(run.result.error, /intentional environment assertion failure/);
    await environmentArtifacts(run, profile);
    assert.equal(
      JSON.parse(await readFile(run.result.artifacts.result, "utf8")).ok,
      false,
    );
    assert.match(
      await readFile(run.result.artifacts.diagnostics, "utf8"),
      /intentional environment assertion failure/,
    );
    const wave = await readWaveform(run.result.artifacts.vcd);
    assert.equal(settled(wave, 11)["tb.disturbed"], "0");
    assert.equal(settled(wave, 13)["tb.sampled"], "0");
    assert.equal(settled(wave, 15)["tb.sampled"], "1");
    const endFs = BigInt(wave.events.at(-1).time) * scaleFs(wave.timescale);
    assert.ok(endFs >= 14000000n && endFs < 35000000n);
  },
);

test(
  "native time overflow fails before driving a wrapped environment edge",
  { skip: !real, timeout: 120000 },
  async (t) => {
    const root = await workspace(t);
    await writeFile(
      join(root, "tb.sv"),
      `\`timescale 1ns/1ps
module tb;
  wire [0:0] nominal, disturbed;
  chipsim_environment env(nominal, disturbed);
  initial begin $dumpfile("trace.vcd"); $dumpvars(0,tb); end
  always @(posedge disturbed[0]) $finish;
endmodule
`,
    );
    const large = structuredClone(profile);
    large.timeUnit = "1s";
    Object.assign(large.channels[0], {
      delayTicks: 0,
      offsetTicks: 0,
      jitterTicks: 0,
      events: [{ tick: 1000000000, value: 1 }],
      glitches: [],
    });
    const run = await runHDL(
      await project(root, "overflow", large),
      join(root, "overflow-run"),
      { debug: false },
    );
    assert.equal(run.result.ok, false);
    assert.match(
      run.result.error,
      /environment time overflow at tick 1000000000/,
    );
    const report = await environmentArtifacts(
      run,
      large,
      await readFile(join(root, "tb.sv")),
    );
    assert.equal(report.edges[0].arrivalTick, 1000000000);
    const wave = await readWaveform(run.result.artifacts.vcd);
    assert.ok(
      !wave.events.some((event) => event.changes["tb.disturbed"] === "1"),
    );

    // The same large schedule is representable when every module uses seconds.
    const tb = await readFile(join(root, "tb.sv"), "utf8");
    await writeFile(join(root, "tb.sv"), tb.replace("1ns/1ps", "1s/1s"));
    const safe = await runHDL(
      await project(root, "coarse", large),
      join(root, "coarse-run"),
      { debug: false },
    );
    assert.equal(safe.result.ok, true, safe.result.error);
    assert.deepEqual(safe.waveform.timescale, { magnitude: "1", unit: "s" });
    assert.equal(safe.waveform.events.at(-1).time, "1000000000");
    assert.equal(safe.waveform.events.at(-1).changes["tb.disturbed"], "1");
  },
);

test(
  "debug environment captures embed the generated source and actual generator signals",
  { skip: !debug, timeout: 120000 },
  async (t) => {
    const root = await workspace(t),
      manifest = await project(root, "debug"),
      run = await runHDL(manifest, join(root, "debug-run"), { debug: true });
    assert.equal(run.result.ok, true, run.result.error);
    await environmentArtifacts(run, profile);
    const data = JSON.parse(await readFile(run.result.artifacts.debug, "utf8"));
    assert.equal(data.status.complete, true);
    new HDLRecording(data);
    const generated = data.sources.find(
      (entry) => entry.path === "chipsim_environment.sv",
    );
    assert.ok(generated);
    assert.equal(
      generated.text,
      await readFile(join(run.result.root, "sources", generated.path), "utf8"),
    );
    assert.equal(generated.sha256, run.result.sources[1].sha256);
    assert.ok(
      data.design.objects.some(
        (object) => object.source?.file === generated.id,
      ),
    );
    for (const [name, at11, at14] of [
      ["nominal", "1", "1"],
      ["disturbed", "0", "1"],
    ]) {
      const signal = data.design.objects.find(
        (object) => object.path === "tb.env." + name && object.observed,
      );
      assert.ok(signal, `generated ${name} signal is observed`);
      assert.ok(
        data.events.some((event) => Object.hasOwn(event.changes, signal.id)),
      );
      assert.equal(settled(data, 11)[signal.id], at11);
      assert.equal(settled(data, 14)[signal.id], at14);
    }
    assert.equal(settled(data, 13)["s:tb.dut.value"], "0");
    assert.equal(settled(data, 15)["s:tb.dut.value"], "1");
  },
);
