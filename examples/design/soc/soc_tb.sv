`timescale 1ns/1ps
module soc_tb;
  reg clk=0,resetn=0;
  wire trap;
  wire [31:0] word0,word1;
  soc dut(.*);
  always #5 clk=~clk;
  initial begin
    $dumpfile("trace.vcd"); $dumpvars(0,soc_tb);
    #22; resetn=1;
    wait(trap);
    if (word0 !== 32'h1234 || word1 !== 32'h1235) $fatal(1,"firmware MMIO result failed");
    $finish;
  end
  initial begin #100000; $fatal(1,"firmware did not finish"); end
endmodule
