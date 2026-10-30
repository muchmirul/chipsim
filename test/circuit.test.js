import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileCircuit } from "../src/circuit/model.js";
import { expression, evaluate, mask } from "../src/circuit/expression.js";
import { BDD, bitblast } from "../src/circuit/bdd.js";
import {
  checkCoverage,
  evaluateStep,
  initialSnapshot,
} from "../src/circuit/relation.js";
import { buildCircuit, readBundle } from "../src/circuit/files.js";
import { generatedHDL } from "../src/circuit/hdl.js";
import { circuitCommand } from "../src/circuit/commands.js";
import { waveformModel } from "../src/hdl/trace.js";
import { symbolicSMT } from "../src/circuit/hdl.js";
import { spawnSync } from "node:child_process";
import { scaleFs } from "../src/hdl/time.js";
import { parseVCD } from "../src/hdl/vcd.js";

const examples = resolve("examples/connected-circuit");
const fixture = async (name) =>
  JSON.parse(await readFile(join(examples, name + ".json")));
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-connected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const constant = (bits, width = 1) => ({ bits, width });

test("connected swap exhaustively samples old state, independent of declaration/rule/connection order", async () => {
  const spec = await fixture("swap");
  for (const reorder of [false, true]) {
    const input = structuredClone(spec);
    if (reorder) {
      input.state.reverse();
      input.connections.reverse();
    }
    const model = compileCircuit(input),
      coverage = checkCoverage(model);
    assert.equal(coverage.status, "complete-scoped-proof");
    assert.equal(coverage.assignments, "4");
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++) {
        const step = evaluateStep(model, {
          state: { A: a, B: b },
          inputs: { clk: 1 },
          previousClock: 0,
        });
        assert.equal(BigInt(step.next.A), BigInt(b));
        assert.equal(BigInt(step.next.B), BigInt(a));
        assert.equal(BigInt(step.outputsBefore.a), BigInt(a));
        assert.equal(BigInt(step.outputsAfter.a), BigInt(b));
      }
    const initial = evaluateStep(model, initialSnapshot(model));
    assert.equal(initial.event, "none");
    assert.deepEqual(initial.next, initial.state);
  }
});

test("load/hold tables use explicit priorities, synchronous reset and no tick-zero or held-clock edge", async () => {
  const spec = await fixture("load-hold");
  for (const reverse of [false, true]) {
    const copy = structuredClone(spec);
    if (reverse) copy.state[0].table.rows.reverse();
    const model = compileCircuit(copy);
    assert.equal(checkCoverage(model).ok, true);
    for (let q = 0; q < 2; q++)
      for (let reset = 0; reset < 2; reset++)
        for (let enable = 0; enable < 2; enable++)
          for (let data = 0; data < 2; data++) {
            const snapshot = {
              state: { Q: q },
              inputs: { clk: 1, reset, enable, data },
              previousClock: 0,
            };
            const result = evaluateStep(model, snapshot);
            assert.equal(
              BigInt(result.next.Q),
              BigInt(reset ? 0 : enable ? data : q),
            );
            assert.equal(
              BigInt(
                evaluateStep(model, { ...snapshot, previousClock: 1 }).next.Q,
              ),
              BigInt(q),
            );
            assert.equal(
              BigInt(
                evaluateStep(model, {
                  ...snapshot,
                  inputs: { ...snapshot.inputs, clk: 0 },
                }).next.Q,
              ),
              BigInt(q),
            );
          }
  }
});

test("exact symbolic coverage produces executable missing-case/conflict witnesses and retains inconclusive budgets", async () => {
  const spec = await fixture("load-hold");
  spec.state[0].table.rows = spec.state[0].table.rows.filter(
    (row) => row.id !== "hold",
  );
  let model = compileCircuit(spec),
    report = checkCoverage(model);
  assert.equal(report.status, "counterexample");
  const missing = report.checks.find((check) => check.verdict === "fail");
  assert.throws(
    () => evaluateStep(model, missing.counterexample),
    /Unspecified/,
  );
  const conflict = await fixture("swap");
  conflict.state[0].rules.push({
    id: "contradiction",
    priority: 0,
    reason: "load",
    when: constant(1),
    value: constant(0),
  });
  model = compileCircuit(conflict);
  report = checkCoverage(model);
  const overlap = report.checks.find((check) => check.verdict === "fail");
  assert.equal(overlap.kind, "equal-priority agreement");
  assert.throws(
    () => evaluateStep(model, overlap.counterexample),
    /Contradictory/,
  );
  // Agreeing overlaps are accepted; priorities are semantic numbers, never row order.
  conflict.state[0].rules[1].value = { ref: "d" };
  assert.equal(checkCoverage(compileCircuit(conflict)).ok, true);
  assert.equal(
    checkCoverage(model, { nodes: 2, operations: 100 }).status,
    "inconclusive",
  );
  assert.equal(checkCoverage(model, { nodes: 100, operations: 1 }).ok, false);
  const masked = await fixture("swap");
  masked.state[0].rules.push(
    {
      id: "higher",
      priority: 1,
      reason: "load",
      when: constant(1),
      value: { ref: "d" },
    },
    {
      id: "masked_conflict",
      priority: 0,
      reason: "load",
      when: constant(1),
      value: constant(0),
    },
  );
  assert.equal(
    checkCoverage(compileCircuit(masked)).ok,
    true,
    "an explicit always-active higher priority masks lower conflicts",
  );
});

test("connections reject absent paths, width mismatch, duplicate drivers, unsupported constructs and loops", async () => {
  const source = await fixture("swap");
  for (const change of [
    (s) => s.connections.pop(),
    (s) => s.connections.push(s.connections[0]),
    (s) => (s.connections[0].from = "state.A.D"),
    (s) => (s.connections[0].slice = [1, 0]),
    (s) => (s.state[0].rules[0].value = { ref: "state.B" }),
    (s) => (s.state[0].initial = "X"),
    (s) => (s.state[0].memory = { depth: 4 }),
    (s) => (s.clock.edge = "asynchronous"),
    (s) => (s.inputs[0].initial = 1),
  ]) {
    const spec = structuredClone(source);
    change(spec);
    assert.throws(() => compileCircuit(spec));
  }
  const cyclic = structuredClone(source);
  cyclic.nodes = [
    { id: "loop", width: 1, ports: { x: 1 }, expression: { ref: "x" } },
  ];
  cyclic.connections.push({ from: "node.loop", to: "node.loop.x" });
  assert.throws(() => compileCircuit(cyclic), /combinational loop/);
  const model = compileCircuit(source);
  assert.throws(
    () => evaluateStep(model, { state: { A: 0, B: 1 }, inputs: { clk: 1 } }),
    /previousClock/,
  );
  assert.throws(
    () =>
      evaluateStep(model, {
        state: { A: "Z", B: 1 },
        inputs: { clk: 1 },
        previousClock: 0,
      }),
    /unsupported/,
  );
});

test("symbolic and concrete vector expressions agree with independent arithmetic/selection expectations", () => {
  const nodes = [
    ["add", (a, b) => (a + b) & 7n],
    ["sub", (a, b) => (a - b) & 7n],
    ["and", (a, b) => a & b],
    ["or", (a, b) => a | b],
    ["xor", (a, b) => a ^ b],
    ["eq", (a, b) => BigInt(a === b)],
    ["ult", (a, b) => BigInt(a < b)],
  ];
  for (const [op, oracle] of nodes) {
    const expr = expression(
      { op, args: [{ ref: "a" }, { ref: "b" }] },
      { a: 3, b: 3 },
    );
    const bdd = new BDD(["a0", "b0", "a1", "b1", "a2", "b2"]);
    const bits = bitblast(
      expr,
      (name) =>
        [0, 1, 2].map((bit) => bdd.variable(2 * bit + (name === "b" ? 1 : 0))),
      bdd,
    );
    for (let a = 0n; a < 8n; a++)
      for (let b = 0n; b < 8n; b++) {
        assert.equal(
          evaluate(expr, (name) => (name === "a" ? a : b)),
          oracle(a, b),
        );
        const evaluateBDD = (id) => {
          if (id < 2) return BigInt(id);
          const node = bdd.nodes[id],
            variable = bdd.names[node.variable],
            value = variable[0] === "a" ? a : b;
          return evaluateBDD(
            (value >> BigInt(variable[1])) & 1n ? node.high : node.low,
          );
        };
        assert.equal(
          bits.reduce(
            (value, bit, i) => value | (evaluateBDD(bit) << BigInt(i)),
            0n,
          ),
          oracle(a, b),
        );
      }
  }
});

test("large state remains a compact checkable relation rather than an enumerated lookup table", async () => {
  const source = await fixture("swap");
  for (const state of source.state) {
    state.width = 64;
    state.ports.d = 64;
  }
  source.outputs.forEach((output) => (output.width = 64));
  const model = compileCircuit(source),
    result = checkCoverage(model);
  assert.equal(result.domainBits, 128);
  assert.equal(result.assignments, (1n << 128n).toString());
  assert.equal(result.ok, true);
  const step = evaluateStep(model, {
    state: { A: "0xffffffffffffffff", B: 1 },
    inputs: { clk: 1 },
    previousClock: 0,
  });
  assert.equal(BigInt(step.next.A), 1n);
  assert.equal(BigInt(step.next.B), mask(64));
});

test("connected counter/capture exhaustively preserves old-state sampling, selected paths and explicit reset priority", async () => {
  const model = compileCircuit(await fixture("counter-capture"));
  assert.equal(checkCoverage(model).ok, true);
  for (let count = 0; count < 4; count++)
    for (let captured = 0; captured < 4; captured++)
      for (let data = 0; data < 4; data++)
        for (let controls = 0; controls < 16; controls++) {
          const [reset, enable, capture, external] = [0, 1, 2, 3].map(
            (bit) => (controls >> bit) & 1,
          );
          const result = evaluateStep(model, {
            state: { Count: count, Captured: captured },
            inputs: { clk: 1, reset, enable, capture, external, data },
            previousClock: 0,
          });
          assert.equal(
            BigInt(result.next.Count),
            BigInt(reset ? 0 : enable ? (count + 1) % 4 : count),
          );
          assert.equal(
            BigInt(result.next.Captured),
            BigInt(reset ? 0 : capture ? (external ? data : count) : captured),
          );
          assert.equal(
            BigInt(result.outputsAfter.lsb),
            BigInt(result.next.Captured) & 1n,
          );
          const selected = result.updates.find(
            (update) => update.state === "Captured",
          ).selectedDependencies;
          if (!reset && capture) {
            assert.ok(
              selected.some(
                (link) =>
                  link.to ===
                  `node.Selected.${external ? "external" : "internal"}`,
              ),
            );
            assert.ok(
              !selected.some(
                (link) =>
                  link.to ===
                  `node.Selected.${external ? "internal" : "external"}`,
              ),
            );
          }
        }
});

test("captured source/tool identities reject stale source and changed derived artifacts without overwriting bundles", async (t) => {
  const root = await temporary(t),
    source = join(root, "source.json"),
    out = join(root, "bundle");
  await writeFile(source, JSON.stringify(await fixture("swap")));
  const report = await buildCircuit(source, out);
  assert.equal(report.status, "built");
  assert.equal(
    (await readBundle(report.path)).sourceStatus,
    "current-source-matches",
  );
  await assert.rejects(buildCircuit(source, out), /already exists/);
  const original = await readFile(source);
  await writeFile(source, original + "\n");
  await assert.rejects(readBundle(report.path), /original source changed/);
  await writeFile(source, original);
  await writeFile(join(out, "generated.sv"), "tampered");
  await assert.rejects(readBundle(report.path), /changed circuit artifact/);
});

test("circuit CLI discovery, structured diagnostics and uncovered-domain failure", async () => {
  const help = await circuitCommand(["help"]);
  assert.equal(help.result.format, "chipsim-circuit-result");
  assert.match(help.result.help, /no PDF/);
  assert.equal(
    (await circuitCommand(["inspect", join(examples, "swap.json")])).result
      .relation.domain.stateBits,
    2,
  );
  assert.equal(
    (await circuitCommand(["step", join(examples, "swap.json")])).exitCode,
    2,
  );
});

test(
  "an independent SMT solver checks emitted coverage and post-commit counter/capture values",
  { skip: !process.env.CHIPSIM_Z3 },
  async (t) => {
    const root = await temporary(t),
      model = compileCircuit(await fixture("counter-capture")),
      path = join(root, "relation.smt2");
    const solve = async (text) => {
      await writeFile(path, text);
      const result = spawnSync(process.env.CHIPSIM_Z3, ["-smt2", path], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout.trim();
    };
    const emitted = symbolicSMT(model);
    assert.equal(
      await solve(emitted),
      "unsat",
      "no missing guard assignment in the full declared domain",
    );
    const base = emitted.replace(
      "(assert (not rules_complete))\n(check-sat)",
      "",
    );
    const inputs =
      "(assert (= previous_clock #b0))\n(assert (= i_clk #b1))\n(assert (= q_Count #b01))\n(assert (= q_Captured #b00))\n(assert (= i_reset #b0))\n(assert (= i_enable #b1))\n(assert (= i_capture #b1))\n(assert (= i_external #b0))\n(assert (= i_data #b11))\n";
    const expected =
      "(and (= next_q_Count #b10) (= next_q_Captured #b01) (= post_o_count #b10) (= post_o_captured #b01) (= post_o_lsb #b1))";
    assert.equal(
      await solve(base + inputs + `(assert ${expected})\n(check-sat)\n`),
      "sat",
    );
    assert.equal(
      await solve(base + inputs + `(assert (not ${expected}))\n(check-sat)\n`),
      "unsat",
      "post-commit outputs and captured old Count agree with independent expectations",
    );
  },
);

test(
  "real Icarus correspondence checks all swap/load cases, mismatch evidence and simultaneous event stimulus",
  { skip: process.env.CHIPSIM_TEST_CIRCUIT !== "1", timeout: 120000 },
  async (t) => {
    const root = await temporary(t);
    for (const [name, total] of [
      ["swap", 4],
      ["load-hold", 16],
      ["counter-capture", 1024],
    ]) {
      const report = await buildCircuit(
        join(examples, name + ".json"),
        join(root, name),
        { operation: "verify" },
      );
      assert.equal(report.ok, true, JSON.stringify(report.native));
      assert.equal(report.correspondence.checked, total);
      assert.equal(report.status, "simulation-only");
      assert.equal((await readBundle(report.path)).coverage.ok, true);
    }
    const spec = await fixture("swap"),
      rtl = generatedHDL(compileCircuit(spec));
    const mismatch = join(root, "wrong.sv");
    await writeFile(mismatch, rtl.replace("q_A <= q_B", "q_A <= 1'b0"));
    const report = await buildCircuit(
      join(examples, "swap.json"),
      join(root, "mismatch"),
      { operation: "verify", rtl: mismatch },
    );
    assert.equal(report.native.ok, true);
    assert.equal(report.status, "counterexample");
    assert.equal(report.correspondence.ok, false);
    assert.ok(report.correspondence.mismatches.length);
    assert.ok(await readFile(join(root, "mismatch/native/diagnostics.json")));
    const initialMismatch = join(root, "wrong-initial.sv");
    await writeFile(
      initialMismatch,
      rtl.replace("initial q_A = 1'h0", "initial q_A = 1'h1"),
    );
    const badInitial = await buildCircuit(
      join(examples, "swap.json"),
      join(root, "wrong-initial"),
      { operation: "verify", rtl: initialMismatch },
    );
    assert.equal(badInitial.status, "counterexample");
    assert.equal(badInitial.correspondence.subject, "initialization");
    assert.equal(
      badInitial.correspondence.checked,
      0,
      "state injection cannot hide an incorrect initial scenario",
    );
    const unavailable = join(root, "unknown.sv");
    await writeFile(unavailable, rtl.replace("q_A <= q_B", "q_A <= 1'bx"));
    const unknown = await buildCircuit(
      join(examples, "swap.json"),
      join(root, "unknown"),
      { operation: "verify", rtl: unavailable },
    );
    assert.equal(unknown.status, "counterexample");
    assert.ok(
      unknown.correspondence.mismatches.some((mismatch) =>
        /x/i.test(mismatch.observed),
      ),
    );
    const invalid = join(root, "invalid.sv");
    await writeFile(invalid, "this is not HDL\n");
    const incomplete = await buildCircuit(
      join(examples, "swap.json"),
      join(root, "incomplete"),
      { operation: "verify", rtl: invalid },
    );
    assert.equal(incomplete.status, "inconclusive");
    assert.equal(incomplete.ok, false);
    assert.ok(await readFile(join(root, "incomplete/native/diagnostics.json")));
    const run = await buildCircuit(
      join(examples, "swap.json"),
      join(root, "run"),
      { operation: "run", stimulus: join(examples, "swap.stimulus.json") },
    );
    assert.equal(run.ok, true);
    const wave = JSON.parse(await readFile(join(root, "run/waveform.json"))),
      trace = waveformModel(wave).simulate();
    const at = (time) =>
      trace.find((snapshot) => snapshot.time === String(time * 1000));
    assert.equal(at(0).signals["circuit_tb.q_A"], "0");
    assert.equal(at(0).signals["circuit_tb.q_B"], "1");
    assert.equal(at(1).signals["circuit_tb.q_A"], "1");
    assert.equal(at(1).signals["circuit_tb.q_B"], "0");
    assert.equal(at(3).signals["circuit_tb.q_A"], "0");
    assert.equal(at(3).signals["circuit_tb.q_B"], "1");
    const captureRun = await buildCircuit(
      join(examples, "counter-capture.json"),
      join(root, "capture-run"),
      {
        operation: "run",
        stimulus: join(examples, "counter-capture.stimulus.json"),
      },
    );
    assert.equal(captureRun.ok, true);
    const captureTrace = waveformModel(
      JSON.parse(await readFile(join(root, "capture-run/waveform.json"))),
    ).simulate();
    const sample = (ns) =>
      captureTrace.find((snapshot) => snapshot.time === String(ns * 1000))
        .signals;
    assert.equal(sample(1)["circuit_tb.q_Count"], "10");
    assert.equal(
      sample(1)["circuit_tb.q_Captured"],
      "01",
      "capture sees old counter despite same-edge increment/input enable changes",
    );
    assert.equal(sample(3)["circuit_tb.q_Count"], "11");
    assert.equal(
      sample(3)["circuit_tb.q_Captured"],
      "11",
      "same-edge external selector/data settle before sampling",
    );
    assert.equal(
      sample(5)["circuit_tb.q_Captured"],
      "11",
      "synchronous reset waits for declared edge",
    );
    assert.equal(sample(6)["circuit_tb.q_Count"], "00");
    assert.equal(sample(6)["circuit_tb.q_Captured"], "00");
    await readBundle(captureRun.path);
    await writeFile(
      join(root, "capture-run/native/sources/circuit.sv"),
      "changed captured native source",
    );
    await assert.rejects(
      readBundle(captureRun.path),
      /changed native artifact/,
    );
  },
);

test(
  "real 64-bit datapaths preserve overflow, high bits and old-state capture on explicit cases",
  { skip: process.env.CHIPSIM_TEST_CIRCUIT !== "1" },
  async (t) => {
    const root = await temporary(t),
      spec = await fixture("counter-capture");
    spec.inputs.find((input) => input.id === "data").width = 64;
    spec.state.forEach((state) => {
      state.width = 64;
      state.ports.d = 64;
      state.rules
        .filter((rule) => rule.reason === "reset")
        .forEach((rule) => (rule.value.width = 64));
    });
    for (const node of spec.nodes) {
      node.width = 64;
      for (const port of Object.keys(node.ports))
        if (port !== "select") node.ports[port] = 64;
    }
    spec.nodes.find(
      (node) => node.id === "Increment",
    ).expression.args[1].width = 64;
    spec.outputs
      .filter((output) => output.id !== "lsb")
      .forEach((output) => (output.width = 64));
    const source = join(root, "wide.json"),
      casesFile = join(root, "cases.json");
    await writeFile(source, JSON.stringify(spec));
    const cases = [
      {
        state: { Count: "0xffffffffffffffff", Captured: 0 },
        inputs: {
          clk: 1,
          reset: 0,
          enable: 1,
          capture: 1,
          external: 0,
          data: 0,
        },
        previousClock: 0,
      },
      {
        state: { Count: 1, Captured: 0 },
        inputs: {
          clk: 1,
          reset: 0,
          enable: 1,
          capture: 1,
          external: 1,
          data: "0x8000000000000001",
        },
        previousClock: 0,
      },
      {
        state: { Count: "0xffffffffffffffff", Captured: "0xffffffffffffffff" },
        inputs: {
          clk: 1,
          reset: 1,
          enable: 1,
          capture: 1,
          external: 1,
          data: 0,
        },
        previousClock: 0,
      },
    ];
    await writeFile(casesFile, JSON.stringify(cases));
    const report = await buildCircuit(source, join(root, "run"), {
      operation: "verify",
      cases: casesFile,
    });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.correspondence.checked, 3);
    const wave = JSON.parse(await readFile(join(root, "run/waveform.json")));
    const trace = waveformModel(wave).simulate();
    const at = (time) =>
      trace
        .filter(
          (snapshot) =>
            BigInt(snapshot.time) * scaleFs(wave.timescale) <=
            BigInt(time) * 1000000n,
        )
        .at(-1).signals;
    assert.equal(BigInt("0b" + at(3)["circuit_tb.q_Count"]), 0n);
    assert.equal(
      BigInt("0b" + at(3)["circuit_tb.q_Captured"]),
      (1n << 64n) - 1n,
    );
    assert.equal(
      BigInt("0b" + at(6)["circuit_tb.q_Captured"]),
      0x8000000000000001n,
    );
    assert.equal(BigInt("0b" + at(9)["circuit_tb.q_Count"]), 0n);
    assert.equal(BigInt("0b" + at(9)["circuit_tb.q_Captured"]), 0n);
    const roundTrip = parseVCD(
      await readFile(join(root, "run/trace.vcd"), "utf8"),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(roundTrip.events)), wave.events);
    const csv = spawnSync(
      process.env.PYTHON || "python3",
      [
        "-c",
        "import csv,json,sys; print(json.dumps(list(csv.DictReader(open(sys.argv[1])))))",
        join(root, "run/trace.csv"),
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.ifError(csv.error);
    assert.equal(csv.status, 0, csv.stderr);
    const rows = JSON.parse(csv.stdout);
    assert.equal(rows.length, wave.events.length);
    assert.ok(
      rows.some(
        (row) => row["signal.circuit_tb.q_Captured"] === "1".repeat(64),
      ),
    );
    assert.ok(
      rows.some(
        (row) =>
          row["signal.circuit_tb.q_Captured"] === "1" + "0".repeat(62) + "1",
      ),
    );
  },
);
