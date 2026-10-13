// Illustrative two-word peripheral. Not derived from a vendor specification.
module scratch (
  input wire clk, rst_n, valid, write_en, address,
  input wire [31:0] write_data,
  output wire [31:0] read_data,
  output reg [31:0] word0, word1
);
  always @(posedge clk) begin
    if (!rst_n) begin word0 <= 0; word1 <= 0; end
    else if (valid && write_en) begin
      if (address) word1 <= write_data;
      else word0 <= write_data;
    end
  end
  assign read_data = address ? word1 : word0;
endmodule
