// Original ChipSim ALU baseline. Generic cell count is the optimization objective.
module alu(input [7:0] A, B, input [2:0] opcode,
           output reg [7:0] result, output reg carry, zero, overflow);
  // EVOLVE-BLOCK-START
  always @* begin
    result = 0;
    carry = 0;
    overflow = 0;
    case (opcode)
      0: begin
        {carry, result} = {1'b0, A} + {1'b0, B};
        overflow = (A[7] == B[7]) && (result[7] != A[7]);
      end
      1: begin
        result = A - B;
        carry = A >= B;
        overflow = (A[7] != B[7]) && (result[7] != A[7]);
      end
      2: result = A & B;
      3: result = A | B;
      4: result = A ^ B;
      5: result = ~A;
      6: result = A << 1;
      7: result = A >> 1;
    endcase
    zero = result == 0;
  end
  // EVOLVE-BLOCK-END
endmodule
