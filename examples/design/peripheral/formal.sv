module formal(input clk, rst_n, valid, write_en, address, input [31:0] write_data);
  wire [31:0] word0, word1, read_data;
  scratch dut(.*);
  reg past_valid = 0;
  always @(posedge clk) begin
    past_valid <= 1;
    if (!past_valid) assume(!rst_n);
    if (past_valid) begin
      if (!$past(rst_n)) begin assert(word0 == 0); assert(word1 == 0); end
      else begin
        if ($past(valid && write_en && !address)) assert(word0 == $past(write_data));
        else assert(word0 == $past(word0));
        if ($past(valid && write_en && address)) assert(word1 == $past(write_data));
        else assert(word1 == $past(word1));
      end
      assert(read_data == (address ? word1 : word0));
    end
  end
endmodule
