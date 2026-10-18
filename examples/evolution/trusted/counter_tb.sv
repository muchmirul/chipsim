`timescale 1ns/1ps
module counter_tb;
  reg clk = 0;
  reg reset = 1;
  reg enable = 0;
  wire [3:0] count;
  integer cycle;
  counter dut (.clk(clk), .reset(reset), .enable(enable), .count(count));
  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, counter_tb);
    for (cycle = 0; cycle < 80; cycle = cycle + 1) begin
      reset = (cycle == 0 || cycle == 27 || cycle == 55);
      enable = (cycle % 7 != 3 && cycle % 7 != 4);
      #5 clk = 1;
      #5 clk = 0;
    end
    $finish;
  end
  initial begin
    #1000;
    $fatal(1, "trusted harness timeout");
  end
endmodule
