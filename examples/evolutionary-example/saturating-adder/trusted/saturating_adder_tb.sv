`timescale 1ns/1ps
module saturating_adder_tb;
  reg [3:0] a = 0;
  reg [3:0] b = 0;
  wire [3:0] sum;
  integer cycle;
  saturating_adder dut (.a(a), .b(b), .sum(sum));
  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, saturating_adder_tb);
    for (cycle = 0; cycle < 256; cycle = cycle + 1) begin
      a = cycle / 16;
      b = cycle % 16;
      #10;
    end
    $finish;
  end
endmodule
