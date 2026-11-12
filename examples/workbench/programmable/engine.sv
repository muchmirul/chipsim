// SPDX-License-Identifier: MIT
// Original finite fixture: four control words; no automatic waits or scheduling.
module control_engine(input wire clk, reset, load, execute,
  input wire [1:0] address, input wire [7:0] data,
  output reg [3:0] value, output reg [1:0] pc);
  reg [7:0] memory [0:3];
  wire [7:0] instruction = memory[pc];
  always @(posedge clk) begin
    if (reset) begin value <= 0; pc <= 0; end
    else if (load) memory[address] <= data;
    else if (execute) begin
      case (instruction[7:4])
        1: value <= value + instruction[3:0];
        2: value <= value ^ instruction[3:0];
        default: value <= value;
      endcase
      pc <= pc + 1;
    end
  end
endmodule
