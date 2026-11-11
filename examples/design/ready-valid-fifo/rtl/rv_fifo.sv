// Original synchronous, first-word-fall-through FIFO for the ChipSim evaluation.
// DEPTH must be a power of two >= 2. out_data is meaningful only if out_valid.
module rv_fifo #(
    parameter integer WIDTH = 8,
    parameter integer DEPTH = 4,
    parameter integer PTR_W = $clog2(DEPTH)
) (
    input wire clk, rst,
    input wire in_valid,
    output wire in_ready,
    input wire [WIDTH-1:0] in_data,
    output wire out_valid,
    input wire out_ready,
    output wire [WIDTH-1:0] out_data,
    output reg [PTR_W:0] level
);
    reg [WIDTH-1:0] mem [0:DEPTH-1];
    reg [PTR_W-1:0] rd_ptr, wr_ptr;
    wire pop = out_valid && out_ready;
    wire push = in_valid && in_ready;
    assign out_valid = !rst && (level != 0);
    // Full occupancy can accept a replacement on the same edge as a dequeue.
    assign in_ready = !rst && ((level < DEPTH) || pop);
    assign out_data = mem[rd_ptr];
    always @(posedge clk) begin
        if (rst) begin
            rd_ptr <= 0;
            wr_ptr <= 0;
            level <= 0;
        end else begin
            if (push) begin
                mem[wr_ptr] <= in_data;
                wr_ptr <= wr_ptr + 1'b1;
            end
            if (pop) rd_ptr <= rd_ptr + 1'b1;
            case ({push, pop})
                2'b10: level <= level + 1'b1;
                2'b01: level <= level - 1'b1;
                default: level <= level;
            endcase
        end
    end
endmodule
