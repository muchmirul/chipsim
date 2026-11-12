// SPDX-License-Identifier: MIT
`timescale 1ns/1ps
module engine_tb;
  reg clk = 0, reset = 1, load = 0, execute = 0;
  reg [1:0] address = 0;
  reg [7:0] data = 0;
  reg [7:0] image [0:3];
  wire [3:0] value;
  wire [1:0] pc;
  integer i;
  control_engine dut(clk, reset, load, execute, address, data, value, pc);
  always #5 clk = ~clk;
  initial begin
    $dumpfile("trace.vcd"); $dumpvars(0, engine_tb);
    $readmemh("program.hex", image, 0, 3);
    #6; reset = 0; load = 1;
    for (i = 0; i < 4; i = i + 1) begin
      address = i; data = image[i]; #10;
    end
    load = 0; execute = 1;
    #40;
    if (value !== 4'd10) $fatal(1, "program result mismatch: expected 10, got %d", value);
    $finish;
  end
endmodule
