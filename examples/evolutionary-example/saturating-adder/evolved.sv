// Deliberately incomplete baseline: wraps instead of saturating. Not a PPA benchmark.
module saturating_adder(input wire [3:0] a, b, output wire [3:0] sum);
  // EVOLVE-BLOCK-START
  wire [4:0] full_sum;
  assign full_sum = {1'b0, a} + {1'b0, b};
  assign sum = full_sum[4] ? 4'd15 : full_sum[3:0];
  // EVOLVE-BLOCK-END
endmodule
