`timescale 1ns/1ps
module priority_encoder_tb;
  reg [7:0] request;
  wire valid;
  wire [2:0] index;
  integer cycle;
  priority_encoder dut (.request(request), .valid(valid), .index(index));
  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, priority_encoder_tb);
    for (cycle = 0; cycle < 256; cycle = cycle + 1) begin
      request = cycle;
      #10;
    end
    $finish;
  end
endmodule
