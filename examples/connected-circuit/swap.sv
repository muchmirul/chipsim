// Original MIT example. Authoritative RTL for the separate HDL-import workflow.
module swap(input wire clk, output reg A = 1'b0, output reg B = 1'b1);
  always @(posedge clk) begin
    A <= B;
    B <= A;
  end
endmodule
