`timescale 1ns/1ps
module fifo_case #(
    parameter integer WIDTH = 8,
    parameter integer DEPTH = 4,
    parameter integer RANDOM_CYCLES = 64,
    parameter integer NETLIST = 0
)(output reg done = 0);
    reg clk = 0;
    always #5 clk = !clk;
    reg rst = 1, in_valid = 0, out_ready = 0;
    reg [WIDTH-1:0] in_data = 0;
    wire in_ready, out_valid;
    wire [WIDTH-1:0] out_data;
    wire [$clog2(DEPTH):0] level;
    generate if (NETLIST) begin
        rv_fifo dut (.*); // synthesized default configuration has fixed ports
    end else begin
        rv_fifo #(.WIDTH(WIDTH), .DEPTH(DEPTH)) dut (.*);
    end endgenerate

    // Independent transaction queue. No DUT pointer/next-state logic is copied.
    reg [WIDTH-1:0] expected [0:DEPTH-1];
    integer occupancy = 0, cycles = 0;
    integer slot;
    integer pushes = 0, pops = 0, full_replaces = 0, stalls = 0;
    integer empty_reads = 0, reset_nonempty = 0;
    reg [31:0] rng = 32'h132457ab ^ DEPTH ^ (WIDTH << 16);
    integer i;
    task step(input reg reset_i, input reg valid_i, input reg ready_i,
              input reg [WIDTH-1:0] data_i);
        reg want_valid, want_ready, do_pop, do_push;
        begin
            @(negedge clk);
            rst = reset_i;
            in_valid = valid_i;
            out_ready = ready_i;
            in_data = data_i;
            #1;
            cycles = cycles + 1;
            want_valid = !reset_i && occupancy > 0;
            want_ready = !reset_i && (occupancy < DEPTH || ready_i);
            if (out_valid !== want_valid || in_ready !== want_ready)
                $fatal(1, "HANDSHAKE depth=%0d width=%0d cycle=%0d occupancy=%0d expected ready/valid=%b/%b actual=%b/%b",
                    DEPTH, WIDTH, cycles, occupancy, want_ready, want_valid, in_ready, out_valid);
            if (want_valid && out_data !== expected[0])
                $fatal(1, "ORDER depth=%0d cycle=%0d expected=%h actual=%h", DEPTH, cycles, expected[0], out_data);
            do_pop = want_valid && ready_i;
            do_push = want_ready && valid_i;
            if (reset_i) begin
                if (occupancy != 0) reset_nonempty = reset_nonempty + 1;
                occupancy = 0;
            end else begin
                if (occupancy == DEPTH && do_pop && do_push) full_replaces = full_replaces + 1;
                if (want_valid && !ready_i) stalls = stalls + 1;
                if (occupancy == 0 && ready_i) empty_reads = empty_reads + 1;
                if (do_pop) begin
                    for (slot = 0; slot < DEPTH-1; slot = slot + 1) expected[slot] = expected[slot+1];
                    occupancy = occupancy - 1; pops = pops + 1;
                end
                if (do_push) begin expected[occupancy] = data_i; occupancy = occupancy + 1; pushes = pushes + 1; end
            end
            @(posedge clk);
            #1;
            if (level !== occupancy)
                $fatal(1, "LEVEL depth=%0d cycle=%0d expected=%0d actual=%0d", DEPTH, cycles, occupancy, level);
            if (!reset_i && occupancy != 0 && out_data !== expected[0])
                $fatal(1, "POST_ORDER depth=%0d cycle=%0d expected=%h actual=%h", DEPTH, cycles, expected[0], out_data);
        end
    endtask
    initial begin
        repeat (2) @(posedge clk);
        step(1, 1, 1, 'hff);
        step(0, 0, 1, 0);
        // Empty simultaneous requests enqueue; there is no combinational bypass.
        step(0, 1, 1, 'ha5);
        step(0, 0, 1, 0);
        for (i = 0; i < DEPTH; i = i + 1) step(0, 1, 0, i + 'h20);
        repeat (4) step(0, 1, 0, 'hee); // full reject + stable backpressure
        for (i = 0; i < 4*DEPTH; i = i + 1) step(0, 1, 1, i + 'h40);
        for (i = 0; i < DEPTH+2; i = i + 1) step(0, 0, 1, 0);
        step(0, 1, 0, 'h89);
        step(1, 1, 1, 'hff); // reset discards occupied queue and dominates traffic
        step(0, 0, 1, 0);
        for (i = 0; i < RANDOM_CYCLES; i = i + 1) begin
            rng = rng ^ (rng << 13);
            rng = rng ^ (rng >> 17);
            rng = rng ^ (rng << 5);
            step(rng[7:2] == 0, rng[0], rng[1], rng >> 8);
        end
        for (i = 0; i < DEPTH+2; i = i + 1) step(0, 0, 1, 0);
        if (occupancy != 0 || full_replaces < 4*DEPTH || stalls < 4 ||
            empty_reads < 2 || reset_nonempty < 1 || pushes < 4*DEPTH)
            $fatal(1, "COVERAGE missing required scenario depth=%0d", DEPTH);
        $display("PASS depth=%0d width=%0d cycles=%0d pushes=%0d pops=%0d full_replaces=%0d stalls=%0d empty_reads=%0d reset_nonempty=%0d seed=%h",
            DEPTH, WIDTH, cycles, pushes, pops, full_replaces, stalls, empty_reads, reset_nonempty, 32'h132457ab ^ DEPTH ^ (WIDTH << 16));
        done = 1;
    end
endmodule

module fifo_tb #(
    parameter integer MATRIX = 0,
    parameter integer RANDOM_CYCLES = 64,
    parameter integer NETLIST = 0
);
    wire d0, d1, d2;
    fifo_case #(.WIDTH(8), .DEPTH(4), .RANDOM_CYCLES(RANDOM_CYCLES), .NETLIST(NETLIST)) main_case(d0);
    generate if (MATRIX) begin
        fifo_case #(.WIDTH(1), .DEPTH(2), .RANDOM_CYCLES(RANDOM_CYCLES)) small_case(d1);
        fifo_case #(.WIDTH(16), .DEPTH(8), .RANDOM_CYCLES(RANDOM_CYCLES)) wide_case(d2);
    end else begin
        assign d1 = 1;
        assign d2 = 1;
    end endgenerate
    initial begin
        $dumpfile("trace.vcd");
        $dumpvars(0, fifo_tb);
        wait (d0 && d1 && d2);
        $display("ALL FIFO CASES PASSED");
        $finish;
    end
    initial begin #1000000; $fatal(1, "WATCHDOG"); end
endmodule
