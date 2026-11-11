// Force one initial reset edge; thereafter external reset and traffic are free.
module formal_top (
    input clk, rst, in_valid, out_ready,
    input [7:0] in_data,
    output in_ready, out_valid,
    output [7:0] out_data,
    output [2:0] level
);
    reg started = 0;
    always @(posedge clk) started <= 1;
    wire [7:0] raw_data;
    rv_fifo dut(.clk(clk), .rst(rst || !started), .in_valid(in_valid),
        .in_ready(in_ready), .in_data(in_data), .out_valid(out_valid),
        .out_ready(out_ready), .out_data(raw_data), .level(level));
    // The interface contract makes empty-queue data unspecified.
    assign out_data = out_valid ? raw_data : 8'b0;
endmodule
