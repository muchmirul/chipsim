import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHDL } from "../src/hdl/run.js";
import { HDLRecording, debugLimits } from "../src/hdl/debug/recording.js";
import { scaleFs } from "../src/hdl/time.js";
const real = process.env.CHIPSIM_TEST_HDL_DEBUG === "1";
const options = { skip: !real, timeout: 120000 };
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "chipsim-debug-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function project(root, language, source, extra = {}) {
  const ext = language === "vhdl" ? "vhdl" : "sv",
    name = `${language}-${Math.random().toString(36).slice(2)}`;
  await writeFile(join(root, name + "." + ext), source);
  const path = join(root, name + ".json");
  await writeFile(
    path,
    JSON.stringify({
      format: "chipsim-hdl-project",
      version: 1,
      language,
      top: "tb",
      sources: [name + "." + ext],
      ...extra,
    }),
  );
  return path;
}
function settled(data, timeFs) {
  const values = {};
  for (const event of data.events) {
    if (BigInt(event.time) * scaleFs(data.timescale) > timeFs) break;
    Object.assign(values, event.changes);
  }
  return values;
}

test(
  "paired counter/handshake captures match stock runs, independent transfer oracle and fault assertions",
  options,
  async (t) => {
    const root = await workspace(t);
    for (const language of ["verilog", "vhdl"]) {
      const path = `examples/hdl/counter-${language}.project.json`;
      const normal = await runHDL(path, join(root, language + "-normal"));
      const debug = await runHDL(path, join(root, language + "-debug"), {
        debug: true,
      });
      assert.equal(normal.result.ok, true, normal.result.error);
      assert.equal(debug.result.ok, true, debug.result.error);
      assert.deepEqual(debug.waveform.events, normal.waveform.events);
      const { recording: data } = debug;
      for (let ns = 0; ns <= 100; ns++) {
        let expected = 0;
        for (let cycle = 0; cycle < 10 && 5 + cycle * 10 <= ns; cycle++)
          expected =
            cycle < 2
              ? 0
              : cycle % 3 !== 0 && cycle % 4 !== 0
                ? (expected + 1) % 16
                : expected;
        assert.equal(
          parseInt(
            settled(data, BigInt(ns) * 1000000n)["s:counter_tb.count"],
            2,
          ),
          expected,
          `${language} ${ns}ns`,
        );
      }
      const end = settled(data, 1000000000n);
      assert.equal(end["s:counter_tb.signed_probe"], "11111101");
      assert.equal(
        BigInt("0b" + end["s:counter_tb.wide_probe"]),
        0x123456789abcdef0123456789abcdef0n,
      );
      assert.equal(
        end["s:counter_tb.logic_probe"],
        language === "vhdl" ? "UX01ZWLH-" : "10XZ",
      );
      const signed = data.design.objects.find(
        (o) => o.path === "counter_tb.signed_probe",
      );
      assert.equal(signed.signed, true);
      const processes = data.design.objects.filter((o) => o.kind === "process");
      assert.ok(
        processes.every(
          (p) => p.source && data.sources.some((s) => s.id === p.source.file),
        ),
      );
      assert.ok(
        processes.some(
          (p) =>
            data.design.objects.find((o) => o.id === p.parent)?.path ===
            "counter_tb.dut",
        ),
      );
      if (language === "verilog")
        assert.ok(
          data.events.some((e) => e.kind === "signal" && e.phase === "nba"),
        );
      else assert.ok(data.events.some((e) => e.delta > 0));
      // Every alias declared as an entire net must agree at every event.
      const recording = new HDLRecording(data);
      for (const e of data.events) {
        const values = recording.snapshot(e.seq).signals;
        for (const edge of data.design.connections.filter(
          (e) => e.kind === "alias",
        ))
          if (values[edge.from] !== undefined && values[edge.to] !== undefined)
            assert.equal(values[edge.from], values[edge.to]);
      }
      const fault = await runHDL(
        `examples/hdl/counter-${language}-fault.project.json`,
        join(root, language + "-fault"),
        { debug: true },
      );
      assert.equal(fault.result.ok, false);
      assert.equal(fault.recording.status.complete, false);
      const assertion = fault.recording.events.find(
        (e) => e.kind === "assertion",
      );
      assert.match(assertion.message, /transfer counter mismatch/);
      assert.ok(
        fault.recording.diagnostics.some((message) =>
          message.includes("transfer counter mismatch"),
        ),
      );
      assert.ok(assertion.source);
      assert.equal(
        BigInt(assertion.time) * scaleFs(fault.recording.timescale),
        26000000n,
      );
      assert.ok(fault.result.artifacts.debug);
    }
  },
);

test(
  "elaborated generate paths, arrays, function/task execution and ascending nine-state vectors are retained",
  options,
  async (t) => {
    const root = await workspace(t);
    const verilog = await project(
      root,
      "verilog",
      `\`timescale 1ns/1ps
module child(input wire clk, output reg [7:0] value=0);
always @(posedge clk) value <= value+1;
endmodule
module tb;
reg clk=0;
reg [7:0] mem [0:3]; reg [7:0] other;
function [7:0] plus; input [7:0] x; begin plus=x+1; end endfunction
task setval; input [7:0] x; begin other=x; end endtask
for(genvar i=0;i<2;i=i+1) begin:g
wire [7:0] q; child dut(clk,q);
end
initial begin
mem[0]=3; other=plus(mem[0]); setval(2);
fork #1 clk=1; #2 clk=0; join
#1 mem[1]=other; #2; $finish;
end
endmodule`,
    );
    const vhdl = await project(
      root,
      "vhdl",
      `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity tb is end;
architecture test of tb is
signal clk : std_logic := '0';
type mem_t is array(0 to 3) of unsigned(7 downto 0);
signal mem : mem_t := (others=>(others=>'0'));
signal asc : std_logic_vector(0 to 8) := "UX01ZWLH-";
begin
clk <= not clk after 1 ns;
g : for i in 0 to 1 generate
 signal q : unsigned(7 downto 0) := (others=>'0');
begin
 p : process(clk) begin if rising_edge(clk) then q <= q+1; end if; end process;
end generate;
p : process begin wait for 2 ns; mem(1)<=to_unsigned(3,8); wait for 4 ns; std.env.finish; end process;
end;`,
    );
    for (const [language, path] of [
      ["verilog", verilog],
      ["vhdl", vhdl],
    ]) {
      const { result, recording: d } = await runHDL(
        path,
        join(root, language),
        { debug: true },
      );
      assert.equal(result.ok, true, result.error);
      const recording = new HDLRecording(d),
        end = recording.snapshot(d.events.length - 1).signals;
      assert.ok(
        d.design.objects.filter(
          (o) => o.kind === "instance" && /g[\[(]/.test(o.path),
        ).length >= 2,
      );
      const signals = recording.signals.filter((o) => /\.q$/.test(o.path));
      assert.equal(signals.length, 2);
      for (const s of signals)
        assert.equal(parseInt(end[s.id], 2), language === "verilog" ? 1 : 3);
      if (language === "verilog") {
        assert.equal(end["s:tb.mem[1]"], "00000010");
        assert.equal(end["s:tb.g[1].i"], "0".repeat(31) + "1");
        assert.ok(
          d.design.connections.some(
            (e) => e.from === "s:tb.mem" && e.kind === "reads",
          ),
        );
      } else {
        assert.equal(end["s:tb.asc"], "UX01ZWLH-");
        assert.equal(end["s:tb.mem"], "00000000000000110000000000000000");
        const obj = recording.objects.get("s:tb.asc");
        assert.equal(obj.bitNames[0], "(0)");
        assert.equal(obj.bitNames.at(-1), "(8)");
      }
    }
  },
);

test(
  "both backends retain partial event/byte/width/signal-limit and unsupported-type artifacts",
  options,
  async (t) => {
    const root = await workspace(t);
    for (const language of ["verilog", "vhdl"]) {
      const bodies =
        language === "verilog"
          ? {
              type: "module tb; real r=1.5; reg x=0; initial begin #1 x=1; #1 $finish; end endmodule",
              bytes:
                "module tb; reg [4095:0] x=0; integer i; initial begin for(i=0;i<18000;i=i+1) #1 x=~x; $finish; end endmodule",
              events:
                "module tb; reg x=0; integer i; initial begin for(i=0;i<40000;i=i+1) #1 x=~x; $finish; end endmodule",
              width:
                "module tb; reg [4095:0] ok=0; reg [4096:0] too_wide=0; initial #1 $finish; endmodule",
              signals:
                "module tb; " +
                Array.from({ length: 515 }, (_, i) => `reg s${i}=0;`).join(
                  "\n",
                ) +
                " initial #1 $finish; endmodule",
            }
          : {
              type: "entity tb is end; architecture a of tb is signal r:real:=1.5; signal x:bit; begin process begin x<='1'; wait for 1 ns; std.env.finish; end process; end;",
              bytes:
                "library ieee;use ieee.std_logic_1164.all; entity tb is end; architecture a of tb is signal x:std_logic_vector(4095 downto 0):=(others=>'0'); begin process begin for i in 1 to 5 loop wait for 1 ns; x<=not x; end loop; wait for 1 ns; std.env.finish; end process; end;",
              events:
                "entity tb is end; architecture a of tb is signal x:bit:='0'; begin process begin for i in 1 to 40000 loop wait for 1 ns; x<=not x; end loop; wait for 1 ns; std.env.finish; end process; end;",
              width:
                "library ieee; use ieee.std_logic_1164.all; entity tb is end; architecture a of tb is signal ok:std_logic_vector(4095 downto 0):=(others=>'0'); signal too_wide:std_logic_vector(4096 downto 0):=(others=>'0'); begin process begin wait for 1 ns; std.env.finish; end process; end;",
              signals:
                "entity tb is end; architecture a of tb is " +
                Array.from(
                  { length: 515 },
                  (_, i) => `signal s${i}:bit:='0';`,
                ).join("\n") +
                " begin process begin wait for 1 ns; std.env.finish; end process; end;",
            };
      for (const [kind, source] of Object.entries(bodies)) {
        const path = await project(root, language, source);
        const { result, recording: d } = await runHDL(
          path,
          join(root, language + "-" + kind),
          { debug: true },
        );
        assert.equal(result.ok, false, language + kind);
        assert.equal(d.status.complete, false);
        assert.ok(
          d.events.length > 0,
          `${language} ${kind}: retain a valid prefix: ${result.error}`,
        );
        assert.ok(d.events.length <= debugLimits.events);
        if (kind === "events")
          assert.equal(d.events.length, debugLimits.events);
        if (kind === "bytes") {
          assert.ok(d.events.length < debugLimits.events);
          assert.match(d.status.reason, /byte/);
        }
        if (kind === "type")
          assert.ok(
            d.diagnostics.some((message) => /non-digital/.test(message)),
          );
        if (kind === "signals")
          assert.equal(d.design.objects.filter((o) => o.observed).length, 512);
        if (kind === "width")
          assert.ok(
            d.design.objects.some((o) => o.observed && o.width === 4096),
          );
        assert.match(d.status.reason, /limit|width/);
        new HDLRecording(d);
      }
    }
  },
);

test(
  "debug compile failures, simulator timeout and cancellation preserve diagnostics and valid partial recordings",
  options,
  async (t) => {
    const root = await workspace(t);
    for (const language of ["verilog", "vhdl"]) {
      const broken = await project(root, language, "invalid syntax");
      const bad = await runHDL(broken, join(root, language + "-bad"), {
        debug: true,
      });
      assert.equal(bad.result.ok, false);
      assert.equal(bad.recording.events.length, 0);
      assert.equal(bad.recording.sources.length, 1);
      assert.ok(bad.recording.diagnostics.length > 1);
      const source =
        language === "verilog"
          ? "module tb; reg x=0; initial forever #1 x=~x; endmodule"
          : "entity tb is end; architecture a of tb is signal x:bit:='0'; begin x<=not x after 1 ns; end;";
      const path = await project(root, language, source, { timeoutMs: 1000 });
      for (const kind of ["timeout", "cancel"]) {
        const controller = new AbortController();
        let timer;
        const captured = await runHDL(path, join(root, language + "-" + kind), {
          debug: true,
          signal: controller.signal,
          onProgress: (stage) => {
            if (stage === "simulate" && kind === "cancel")
              timer = setTimeout(() => controller.abort(), 120);
          },
        });
        clearTimeout(timer);
        assert.equal(captured.result.ok, false);
        assert.match(
          captured.result.error,
          kind === "timeout" ? /timed out|timeout/ : /cancelled/,
        );
        assert.equal(captured.recording.status.complete, false);
        assert.ok(
          captured.recording.events.length > 0,
          captured.recording.status.reason,
        );
        assert.equal(
          JSON.parse(await readFile(captured.result.artifacts.debug, "utf8"))
            .status.complete,
          false,
        );
      }
    }
  },
);
