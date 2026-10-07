import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePayload,
  formatPayload,
  payloadFormats,
} from "../src/core/values.js";
import { builtinModels, defaultParameters } from "../src/models/index.js";
import { exportCSV, exportJSON, exportVCD } from "../src/trace/export.js";

test("all integer formats round trip, ambiguous and invalid values are rejected", () => {
  for (const [input, value, format] of [
    ["179", 179, "decimal"],
    [" 00179 ", 179, "decimal"],
    ["0XB3", 179, "hex"],
    ["0b10110011", 179, "binary"],
    ["0O263", 179, "octal"],
  ])
    assert.deepEqual(parsePayload(input), { value, format });
  for (const input of [
    "",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "B3",
    "0x",
    "0b102",
    "0o8",
    "Infinity",
    "9007199254740992",
  ])
    assert.equal(parsePayload(input), null);
  for (const value of [0, 1, 179, 255, 300, 4095, 0xffffffff])
    for (const format of payloadFormats)
      assert.equal(parsePayload(formatPayload(value, format, 32)).value, value);
});
test("six original architectures decode both widths and latch success or timeout", () => {
  for (const model of builtinModels)
    for (const bits of ["8", "12"])
      for (const ack of ["present", "missing"]) {
        const payload = bits === "8" ? 0xb3 : 0xab3,
          trace = model.simulate({
            ...defaultParameters(model),
            bits,
            ack,
            payload,
          });
        const result = trace.find((s) =>
          ["success", "timeout", "fault"].includes(s.phase),
        );
        assert.equal(
          result?.phase,
          ack === "present" ? "success" : "timeout",
          model.id,
        );
        assert.equal(result.registers.samples, Number(bits));
        assert.equal(result.registers.decoded, payload);
        assert.equal(result.registers.actualEnd, Number(bits) * 4);
        assert.ok(
          trace
            .filter((s) => s.tick > result.tick)
            .every((s) => s.phase === result.phase),
        );
      }
});
test("explicit ACK stimulus, configurable deadlines, and low-bit payload masking", () => {
  for (const model of builtinModels) {
    const params = {
      ...defaultParameters(model),
      payload: 300,
      budget: 5,
      ackDelay: 5,
    };
    const success = model.simulate(params).find((s) => s.phase === "success");
    assert.equal(success?.registers.decoded, 44, model.id);
    const trace = model.simulate(params, {
      inputs: [{ tick: 38, signal: "ack", value: 1 }],
    });
    assert.equal(
      trace.find((s) => s.phase === "timeout")?.tick,
      model.id === "etpu" ? 39 : 37,
      model.id,
    );
    const immediate = model.simulate({ ...params, budget: 1, ackDelay: 0 });
    assert.equal(
      immediate.find((s) => s.phase === "success")?.phase,
      "success",
      model.id,
    );
    const exact = model.simulate(params, {
      inputs: [{ tick: 37, signal: "ack", value: 1 }],
    });
    assert.equal(
      exact.find((s) => s.phase === "success")?.tick,
      model.id === "etpu" ? 39 : 37,
      model.id,
    );
  }
});
test("resource constraints preserve distinct architecture behavior", () => {
  const results = Object.fromEntries(
    builtinModels.map((model) => {
      const trace = model.simulate({
        ...defaultParameters(model),
        stress: true,
      });
      return [
        model.id,
        trace.find((s) => ["success", "timeout", "fault"].includes(s.phase)),
      ];
    }),
  );
  assert.equal(results.pio.registers.actualEnd, 36);
  assert.equal(results.flexio.phase, "success");
  assert.equal(results.udb.phase, "success");
  assert.equal(results.xmos.phase, "fault");
  assert.equal(results.pru.phase, "success");
  assert.equal(results.pru.registers.actualEnd, 36);
  assert.equal(results.etpu.phase, "fault");
});
test("trace exports carry provenance, readable deltas, and digital transitions", () => {
  const model = builtinModels[0],
    parameters = defaultParameters(model),
    trace = model.simulate(parameters);
  const csv = exportCSV(model, trace),
    json = JSON.parse(exportJSON(model, trace, parameters)),
    vcd = exportVCD(model, trace);
  assert.match(csv, /"signal.data"/);
  assert.equal(csv.trim().split("\n").length, trace.length + 1);
  assert.equal(json.model.sources.length, 1);
  assert.equal(json.timing.cycleAccurate, false);
  assert.equal(json.trace.at(-1).phase, "success");
  assert.match(vcd, /\$enddefinitions \$end/);
  assert.match(vcd, /#2\nb1 v1/);
  assert.match(vcd, /normalized model tick/);
});
