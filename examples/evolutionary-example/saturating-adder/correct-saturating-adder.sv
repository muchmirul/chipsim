// Known-correct manual acceptance fixture, NOT a recorded evolution result.
module saturating_adder(input wire [3:0] a, b, output wire [3:0] sum);
  // EVOLVE-BLOCK-START
  wire [4:0] total;
  assign total = {1'b0, a} + {1'b0, b};
  assign sum = total[4] ? 4'd15 : total[3:0];
  // EVOLVE-BLOCK-END
endmodule
