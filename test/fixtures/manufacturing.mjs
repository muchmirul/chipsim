import { readFileSync } from "node:fs";
// Original independent counter/XOR fixture. The testbench's integer oracle
// follows the specification rather than copying the RTL update expression.
export const manufacturingMetadata = {
  id: "delivery-counter",
  title: "ChipSim delivery counter",
  top: "tt_um_chipsim_delivery_counter",
  author: "ChipSim",
  description:
    "Enabled eight-bit counter and independent combinational XOR with explicit output enables",
  clockHz: 50000000,
  tiles: "1x1",
  license: readFileSync(new URL("../../LICENSE", import.meta.url), "utf8"),
  pinout: {
    ui: Array.from({ length: 8 }, (_, i) => "xor_a_" + i),
    uo: Array.from({ length: 8 }, (_, i) => "count_" + i),
    uio: Array.from({ length: 8 }, (_, i) => "xor_b_and_result_" + i),
  },
};
export const cases = [
  "reset",
  "enable-hold",
  "count-wrap",
  "xor",
  "output-enable",
];
export const counterRTL = `// SPDX-License-Identifier: MIT
module ${manufacturingMetadata.top}(input wire [7:0] ui_in, output wire [7:0] uo_out,
 input wire [7:0] uio_in, output wire [7:0] uio_out, uio_oe, input wire ena, clk, rst_n);
 reg [7:0] count;
 always @(posedge clk) if (!rst_n) count <= 0; else if (ena) count <= count + 1;
 assign uo_out = count;
 assign uio_out = ui_in ^ uio_in;
 assign uio_oe = 8'hff;
endmodule
`;
export const counterTestbench = `// SPDX-License-Identifier: MIT
\`timescale 1ns/1ps
module tb;
reg [7:0] ui_in=0, uio_in=0;
reg ena=0,clk=0,rst_n=0;
wire [7:0] uo_out,uio_out,uio_oe;
integer i, expected, result;
${manufacturingMetadata.top} dut(.ui_in(ui_in),.uio_in(uio_in),.uo_out(uo_out),.uio_out(uio_out),.uio_oe(uio_oe),.ena(ena),.clk(clk),.rst_n(rst_n));
always #10 clk=~clk;
initial begin
 $dumpfile("waveform.vcd"); $dumpvars(0,tb);
 repeat(2) @(negedge clk);
 if(uo_out !== 0) $fatal(1,"reset failed");
 rst_n=1;
 repeat(3) @(negedge clk);
 if(uo_out !== 0) $fatal(1,"disabled counter changed");
 ena=1;
 for(i=1;i<=260;i=i+1) begin
  @(negedge clk); expected=i%256;
  if(uo_out !== expected[7:0]) $fatal(1,"counter/wrap failed at %0d",i);
 end
 ena=0;
 for(i=0;i<256;i=i+1) begin
  ui_in=i; uio_in=255-i; #1;
  if(uio_out !== 8'hff) $fatal(1,"xor failed");
  if(uio_oe !== 8'hff) $fatal(1,"output enable failed");
 end
 repeat(3) @(negedge clk);
 if(uo_out !== 4) $fatal(1,"enabled hold failed");
 result=$fopen("results.xml","w");
 $fwrite(result,"<testsuite tests='5'><testcase name='reset'/><testcase name='enable-hold'/><testcase name='count-wrap'/><testcase name='xor'/><testcase name='output-enable'/></testsuite>");
 $fclose(result); $finish;
end
initial begin #100000; $fatal(1,"test deadline exceeded"); end
endmodule
`;
