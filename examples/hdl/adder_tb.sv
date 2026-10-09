// SPDX-License-Identifier: CC0-1.0
// ChipSim testbench for cocotb's unmodified CC0 adder.
`timescale 1ns/1ps
module adder_tb;
  reg [3:0] A = 0, B = 0;
  wire [4:0] X;
  wire nand_a = A[0], nand_b = B[0];
  wire nand_probe = ~(nand_a & nand_b);
  reg clk = 0;
  reg [7:0] edges = 0;
  reg [3:0] logic_probe = 4'b10xz;
  integer a, b;
  adder dut (.A(A), .B(B), .X(X));
  always #2.5 clk = ~clk;
  always @(posedge clk) edges <= edges + 1;
  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, adder_tb);
    for (a = 0; a < 16; a = a + 1)
      for (b = 0; b < 16; b = b + 1) begin
        A = a; B = b;
        #1;
        if (X !== a + b) $fatal(1, "Adder mismatch A=%d B=%d X=%d", a, b, X);
        #4;
      end
    $finish;
  end
endmodule
