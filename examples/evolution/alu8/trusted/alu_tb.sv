`timescale 1ns/1ps
// Fixed, bounded observation harness. Expected values are computed separately.
module alu_tb;
  reg [7:0] A, B;
  reg [2:0] opcode;
  wire [7:0] result;
  wire carry, zero, overflow;
  reg [18:0] vectors [0:524287];
  reg [2047:0] vector_file;
  integer count, i, observations;
  alu dut(.A(A), .B(B), .opcode(opcode), .result(result),
          .carry(carry), .zero(zero), .overflow(overflow));
  initial begin
    if (!$value$plusargs("VECTORS=%s", vector_file)) vector_file = "vectors.hex";
    if (!$value$plusargs("COUNT=%d", count)) count = 288;
    if (count < 1 || count > 524288) $fatal(1, "invalid vector count");
    $readmemh(vector_file, vectors, 0, count - 1);
    observations = $fopen("observations.txt", "w");
    if (!observations) $fatal(1, "cannot open observations");
    if ($test$plusargs("WAVE")) begin
      $dumpfile("trace.vcd");
      $dumpvars(0, alu_tb);
    end
    for (i = 0; i < count; i = i + 1) begin
      {A, B, opcode} = vectors[i];
      #1;
      $fdisplay(observations, "%05h %02h %b%b%b", {A,B,opcode}, result, carry, zero, overflow);
    end
    $fclose(observations);
    $finish;
  end
  initial begin
    #600000;
    $fatal(1, "harness timeout");
  end
endmodule
