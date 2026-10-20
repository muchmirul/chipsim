`timescale 1ns/1ps
// Illustrative delayed digital action path, not a qualified pin/analog model.
module environment_tb;
    parameter REQUIRE_TARGET = 0;
    wire [0:0] nominal, disturbed;
    chipsim_environment env(.nominal(nominal), .disturbed(disturbed));
    reg clk = 0;
    reg [3:0] review_step = 0;
    reg sampled = 0;
    reg target = 0;
    reg checked = 0, target_met = 0;
    // 20 MHz sampling clock. Target path effect is 150 ns; observe at 175 ns.
    always #25 clk = ~clk;
    always @(posedge clk) begin
        sampled <= disturbed[0];
        #1; review_step = review_step + 1;
    end
    initial begin
        $dumpfile("trace.vcd");
        $dumpvars(0, environment_tb);
        #150; target = 1;
        #1; target_met = (disturbed[0] === 1'b1); checked = 1;
        if (REQUIRE_TARGET && !target_met)
            $fatal(1, "target missed: delayed action not present at 150 ns");
        #125;
        $display("DEMO COMPLETE: target_met=%b (single digital observation, not a timing proof)", target_met);
        $finish;
    end
endmodule
