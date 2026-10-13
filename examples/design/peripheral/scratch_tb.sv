`timescale 1ns/1ps
module scratch_tb;
  reg clk=0, rst_n=0, valid=0, write_en=0, address=0;
  reg [31:0] write_data=0;
  wire [31:0] read_data, word0, word1;
  scratch dut(.*);
  always #5 clk=~clk;
  initial begin
    $dumpfile("trace.vcd"); $dumpvars(0, scratch_tb);
    #12;
    if (word0 !== 0 || word1 !== 0) $fatal(1,"reset failed");
    rst_n=1; valid=1; write_en=1; write_data=32'h1234;
    #10; address=1; write_data=32'h1235;
    #10; valid=0; write_data=32'hdead;
    #10;
    if (word0 !== 32'h1234 || word1 !== 32'h1235) $fatal(1,"write/hold failed");
    if (read_data !== 32'h1235) $fatal(1,"read failed");
    rst_n=0; #10;
    if (word0 !== 0 || word1 !== 0) $fatal(1,"reset after writes failed");
    $finish;
  end
endmodule
