`timescale 1ns/1ps
module counter_tb;
  reg clk = 0;
  reg reset = 1;
  reg enable = 0;
  wire [3:0] count;
  counter dut (.clk(clk), .reset(reset), .enable(enable), .count(count));
  always #5 clk = ~clk;

  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, counter_tb);
    @(posedge clk); #1;
    if (count !== 4'd0) $fatal(1, "reset must clear count");
    @(negedge clk); reset = 0; enable = 1;
    repeat (3) @(posedge clk);
    #1;
    if (count !== 4'd3) $fatal(1, "three enabled edges must count to 3");
    @(negedge clk); enable = 0;
    repeat (2) @(posedge clk);
    #1;
    if (count !== 4'd3) $fatal(1, "disabled counter must hold");
    @(negedge clk); enable = 1;
    repeat (13) @(posedge clk);
    #1;
    if (count !== 4'd0) $fatal(1, "4-bit count must wrap after 16 edges");
    @(negedge clk); reset = 1;
    @(posedge clk); #1;
    if (count !== 4'd0) $fatal(1, "reset must take priority over enable");
    $display("PASS: reset, count, hold, wrap and reset priority");
    $finish;
  end
  initial begin
    #1000;
    $fatal(1, "testbench timeout");
  end
endmodule
