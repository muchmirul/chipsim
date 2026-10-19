// Deliberately faulty baseline: lowest bit wins, not highest. Not a PPA benchmark.
module priority_encoder(input wire [7:0] request, output reg valid, output reg [2:0] index);
  // EVOLVE-BLOCK-START
  integer bit_index;
  always @* begin
    valid = |request;
    index = 3'd0;
    for (bit_index = 7; bit_index >= 0; bit_index = bit_index - 1)
      if (request[bit_index]) index = bit_index;
  end
  // EVOLVE-BLOCK-END
endmodule
