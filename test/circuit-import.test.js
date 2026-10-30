import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCircuit, circuitFromNetlist } from "../src/circuit/import.js";
import { readBundle } from "../src/circuit/files.js";
import { evaluateStep } from "../src/circuit/relation.js";
import { resolve } from "node:path";
const yosys = process.env.CHIPSIM_YOSYS;
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-circuit-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("HDL lowering rejects unsupported netlists without making initial-state or connectivity guesses", () => {
  const module = {
    ports: {
      clk: { direction: "input", bits: [1] },
      q: { direction: "output", bits: [2] },
    },
    cells: {
      ff: { type: "$_DFF_P_", connections: { C: [1], D: [2], Q: [2] } },
    },
    netnames: { q: { bits: [2], attributes: { init: "1" } } },
  };
  const result = circuitFromNetlist(
    { modules: { unit: module } },
    "unit",
    "clk",
    { clk: 0 },
  );
  assert.equal(result.spec.state[0].initial, 1);
  const unknown = structuredClone(module);
  delete unknown.netnames.q.attributes.init;
  assert.throws(
    () =>
      circuitFromNetlist({ modules: { unit: unknown } }, "unit", "clk", {
        clk: 0,
      }),
    /initialization/,
  );
  const async = structuredClone(module);
  async.cells.ff.type = "$_DFF_PP0_";
  assert.throws(
    () =>
      circuitFromNetlist({ modules: { unit: async } }, "unit", "clk", {
        clk: 0,
      }),
    /Unsupported lowered cell/,
  );
});
test(
  "real Yosys-derived connections correspond to original RTL and retain source/tool/staleness evidence",
  { skip: !yosys, timeout: 120000 },
  async (t) => {
    const root = await temporary(t),
      source = join(root, "swap.sv"),
      initial = join(root, "initial.json");
    await writeFile(
      source,
      "module swap(input clk, output reg A=0, output reg B=1); always @(posedge clk) begin A<=B; B<=A; end endmodule\n",
    );
    await writeFile(initial, '{"clk":0}');
    const result = await importCircuit(source, join(root, "import"), {
      top: "swap",
      clock: "clk",
      initial,
      yosys,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.originalCorrespondence.checked, 4);
    const loaded = await readBundle(result.bundle.path);
    assert.match(loaded.report.lowering.tool.version, /Yosys/);
    assert.equal(loaded.model.state.length, 2);
    assert.ok(loaded.report.artifacts["lowered.json"]);
    const names = Object.entries(loaded.report.lowering.mapping.state).map(
      ([id, record]) => [id, record.nets.find((net) => net.visible).name],
    );
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++) {
        const state = Object.fromEntries(
          names.map(([id, name]) => [id, name === "A" ? a : b]),
        );
        const step = evaluateStep(loaded.model, {
          state,
          inputs: { clk: 1 },
          previousClock: 0,
        });
        for (const [id, name] of names)
          assert.equal(BigInt(step.next[id]), BigInt(name === "A" ? b : a));
      }
    assert.match(
      await readFile(join(root, "import/lower.ys"), "utf8"),
      /write_json/,
    );
    assert.match(
      await readFile(join(root, "import/diagnostics.json"), "utf8"),
      /JSON backend/,
    );
    await writeFile(source, (await readFile(source)) + "\n");
    await assert.rejects(
      readBundle(result.bundle.path),
      /original RTL changed/,
    );
    await rm(source);
    const detached = await readBundle(result.bundle.path);
    assert.equal(detached.sourceStatuses.rtl, "snapshot-only");
    await writeFile(
      join(root, "import/connected/lowered.json"),
      "changed netlist",
    );
    await assert.rejects(
      readBundle(result.bundle.path),
      /changed circuit artifact/,
    );
  },
);
test(
  "real HDL import rejects asynchronous state, latches, uninitialized state and logic loops with retained diagnostics",
  { skip: !yosys, timeout: 120000 },
  async (t) => {
    const root = await temporary(t),
      initial = join(root, "initial.json");
    await writeFile(initial, '{"clk":0,"reset":0,"d":0}');
    const cases = [
      "output reg q=0);always @(posedge clk or posedge reset)if(reset)q<=0;else q<=d;endmodule",
      "output reg q=0);always @*if(d)q=reset;endmodule",
      "output reg q);always @(posedge clk)q<=d;endmodule",
      "output wire q);wire a;assign a=~a;assign q=a;endmodule",
    ];
    for (let i = 0; i < cases.length; i++) {
      const source = join(root, `bad${i}.sv`);
      await writeFile(source, "module bad(input clk,reset,d," + cases[i]);
      const report = await importCircuit(source, join(root, `out${i}`), {
        top: "bad",
        clock: "clk",
        initial,
        yosys,
      });
      assert.equal(report.ok, false);
      assert.equal(report.status, "inconclusive");
      assert.ok(report.error || report.bundle?.native?.error);
      assert.ok(await readFile(join(root, `out${i}/diagnostics.json`)));
    }
  },
);

test(
  "real counter/capture RTL lowering retains every flop bit and agrees with the original across its full binary one-edge domain",
  { skip: !yosys, timeout: 120000 },
  async (t) => {
    const root = await temporary(t);
    const result = await importCircuit(
      resolve("examples/connected-circuit/counter_capture.sv"),
      join(root, "import"),
      {
        top: "counter_capture",
        clock: "clk",
        initial: resolve(
          "examples/connected-circuit/counter_capture.initial.json",
        ),
        yosys,
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.originalCorrespondence.checked, 1024);
    const loaded = await readBundle(result.bundle.path);
    assert.equal(loaded.model.stateBits, 4);
    assert.ok(loaded.model.nodes.length > 0);
    const stateMapping = loaded.report.lowering.mapping.state;
    const sample = (count, captured, data, external) => {
      const old = Object.fromEntries(
        Object.entries(stateMapping).map(([id, entry]) => {
          const net = entry.nets.find(
            (net) => net.name === "count" || net.name === "captured",
          );
          return [
            id,
            ((net.name === "count" ? count : captured) >> net.index) & 1,
          ];
        }),
      );
      return evaluateStep(loaded.model, {
        state: old,
        inputs: { clk: 1, reset: 0, enable: 1, capture: 1, external, data },
        previousClock: 0,
      });
    };
    const observed = sample(1, 0, 3, 0);
    assert.equal(BigInt(observed.outputsAfter.count), 2n);
    assert.equal(BigInt(observed.outputsAfter.captured), 1n);
    assert.equal(BigInt(sample(1, 0, 3, 1).outputsAfter.captured), 3n);
  },
);
