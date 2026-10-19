// Deliberately incomplete baseline: wraps instead of saturating. Not a PPA benchmark.
module saturating_adder(input wire [3:0] a, b, output wire [3:0] sum);
  // EVOLVE-BLOCK-START
  assign sum = a + b;
  // EVOLVE-BLOCK-END
endmodule
