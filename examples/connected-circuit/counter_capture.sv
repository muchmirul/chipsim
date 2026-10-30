// Original MIT example; counter/capture state changes commit together.
module counter_capture(
  input wire clk, reset, enable, capture, external,
  input wire [1:0] data,
  output reg [1:0] count = 2'd1,
  output reg [1:0] captured = 2'd0
);
  always @(posedge clk) begin
    if (reset) begin count <= 0; captured <= 0; end
    else begin
      if (enable) count <= count + 2'd1;
      if (capture) captured <= external ? data : count;
    end
  end
endmodule
