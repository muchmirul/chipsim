module formal_top(input clk, reset, enable, output [3:0] count);
  reg started = 0;
  always @(posedge clk) started <= 1;
  counter dut(.clk(clk), .reset(reset | !started), .enable(enable), .count(count));
endmodule
