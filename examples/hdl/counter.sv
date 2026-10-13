`timescale 1ns/1ps
// Original ChipSim example, CC0-1.0. One transfer increments the counter.
module transfer_counter #(parameter FAULT = 0)(
  input wire clk, reset, valid, ready,
  output reg [3:0] count = 0,
  output wire accept
);
  assign accept = valid & ready;
  always @(posedge clk) begin
    if (reset) count <= 0;
    else if (accept) count <= count + (FAULT ? 2 : 1);
  end
endmodule

module counter_tb;
  parameter FAULT = 0;
  reg clk = 0, reset = 1, valid = 0, ready = 0;
  wire [3:0] count;
  wire accept;
  reg signed [7:0] signed_probe = -3;
  reg [127:0] wide_probe = 128'h123456789abcdef0123456789abcdef0;
  reg [3:0] logic_probe = 4'b10xz;
  integer cycle, expected = 0;
  transfer_counter #(.FAULT(FAULT)) dut(clk, reset, valid, ready, count, accept);
  always #5 clk = ~clk;
  // Runs on every clock transition, including steps without output changes.
  always @(clk) begin : passive_observer
    if (clk && valid && ready) begin end
  end
  initial begin
    $dumpfile("trace.vcd"); $dumpvars(0, counter_tb);
    #1;
    for (cycle = 0; cycle < 10; cycle = cycle + 1) begin
      reset = cycle < 2;
      valid = cycle % 3 != 0;
      ready = cycle % 4 != 0;
      #5; // Sample one nanosecond after the rising edge and its NBA updates.
      if (reset) expected = 0;
      else if (valid && ready) expected = (expected + 1) % 16;
      if (count !== expected[3:0]) $fatal(1, "transfer counter mismatch");
      #5;
    end
    $finish;
  end
endmodule
