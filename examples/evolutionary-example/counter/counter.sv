// Deliberately incomplete baseline: ignores enable. Not a PPA benchmark.
module counter(input wire clk, reset, enable, output reg [3:0] count);
  // EVOLVE-BLOCK-START
  always @(posedge clk) begin
    if (reset) count <= 4'd0;
    else count <= count + 4'd1;
  end
  // EVOLVE-BLOCK-END
endmodule
