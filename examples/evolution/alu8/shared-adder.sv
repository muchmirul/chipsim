// Original equivalent acceptance fixture, not an AI-generated search result.
module alu(input [7:0] A, B, input [2:0] opcode,
           output reg [7:0] result, output reg carry, zero, overflow);
  // EVOLVE-BLOCK-START
  wire subtract = opcode == 1;
  wire [8:0] arithmetic = {1'b0, A} + {1'b0, (B ^ {8{subtract}})} + subtract;
  always @* begin
    carry = 0;
    overflow = 0;
    result = 0;
    case (opcode)
      0, 1: begin
        result = arithmetic[7:0];
        carry = arithmetic[8];
        overflow = (A[7] ^ result[7]) & ~(A[7] ^ B[7] ^ subtract);
      end
      2: result = A & B;
      3: result = A | B;
      4: result = A ^ B;
      5: result = ~A;
      6: result = {A[6:0], 1'b0};
      7: result = {1'b0, A[7:1]};
    endcase
    zero = result == 0;
  end
  // EVOLVE-BLOCK-END
endmodule
