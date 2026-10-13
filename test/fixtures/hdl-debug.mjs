import { sourceDigest } from "../../src/hdl/debug/recording.js";

export function debugFixture(count = 520) {
  const text =
    "module top;\nreg clk = 0;\nreg [3:0] count = 0;\nalways @(posedge clk) count <= count + 1;\nendmodule\n";
  const objects = [
    {
      id: "b:top",
      kind: "instance",
      label: "top",
      path: "top",
      source: { file: "src", line: 1 },
    },
    {
      id: "p:count",
      kind: "process",
      label: "top.counter",
      path: "top.counter",
      parent: "b:top",
      source: { file: "src", line: 4 },
    },
    {
      id: "s:clk",
      kind: "signal",
      label: "top.clk",
      path: "top.clk",
      parent: "b:top",
      width: 1,
      observed: true,
      source: { file: "src", line: 2 },
    },
    {
      id: "s:count",
      kind: "signal",
      label: "top.count",
      path: "top.count",
      parent: "b:top",
      width: 4,
      observed: true,
      source: { file: "src", line: 3 },
    },
  ];
  const events = [
    {
      seq: 0,
      time: "0",
      phase: "initialization",
      kind: "initialize",
      changes: { "s:clk": "0", "s:count": "0000" },
    },
  ];
  for (let seq = 1; seq < count; seq++) {
    const round = Math.floor((seq - 1) / 4),
      part = (seq - 1) % 4;
    events.push({
      seq,
      time: String((round + 1) * 10),
      phase: part === 2 ? "nba" : "active",
      ...(part === 1
        ? { kind: "process", process: "p:count" }
        : part === 3
          ? { kind: "boundary" }
          : {
              kind: "signal",
              changes:
                part === 0
                  ? { "s:clk": round % 2 ? "0" : "1" }
                  : {
                      "s:count": ((round + 1) % 16)
                        .toString(2)
                        .padStart(4, "0"),
                    },
            }),
    });
  }
  return {
    format: "chipsim-hdl-debug",
    version: 1,
    run: { id: "fixture", name: "Counter debug fixture", language: "verilog" },
    timescale: { magnitude: "1", unit: "ns" },
    sources: [
      { id: "src", path: "counter.sv", text, sha256: sourceDigest(text) },
    ],
    design: {
      objects,
      connections: [
        { id: "e:clk", from: "s:clk", to: "p:count", kind: "posedge" },
        { id: "e:count", from: "p:count", to: "s:count", kind: "writes" },
      ],
    },
    events,
    capabilities: { processActivations: true, signalUpdates: true },
    status: { complete: true, reason: "finished" },
    diagnostics: [],
  };
}
