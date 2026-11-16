// SPDX-License-Identifier: MIT
// Independent public-pin tests. No hierarchical references to DUT registers.
`timescale 1ns/1ps
module tb;
    reg [7:0] ui_in = 0, uio_in = 0;
    reg ena = 1, clk = 0, rst_n = 1;
    wire [7:0] uo_out, uio_out, uio_oe;
    integer i, j, duty, highs, results;
    tt_um_chipsim_power_controller dut (
        .ui_in(ui_in), .uo_out(uo_out), .uio_in(uio_in),
        .uio_out(uio_out), .uio_oe(uio_oe),
        .ena(ena), .clk(clk), .rst_n(rst_n)
    );
    always #10 clk = ~clk;

    task tick;
        begin @(posedge clk); #2; end
    endtask
    task inputs;
        input run_req, pg, fault_pin, clear_pin;
        input [3:0] command;
        begin
            @(negedge clk);
            ui_in = {command, clear_pin, fault_pin, pg, run_req};
            #1;
        end
    endtask
    task expect_off;
        begin
            if (uo_out !== 8'h00) $fatal(1, "Expected OFF, got %h", uo_out);
            if (uio_out !== 0 || uio_oe !== 0) $fatal(1, "Unused bidirectional pins driven");
        end
    endtask
    task expect_fault;
        begin
            if (uo_out !== 8'h08) $fatal(1, "Expected latched FAULT, got %h", uo_out);
        end
    endtask
    task reset_healthy;
        begin
            @(negedge clk); rst_n = 0; ui_in = 0; ena = 1;
            #2; expect_off(); tick();
            @(negedge clk); rst_n = 1;
            tick(); expect_off();
        end
    endtask
    task enter_run;
        input [3:0] command;
        integer warm;
        begin
            reset_healthy();
            inputs(1, 1, 0, 0, command); tick();
            if (uo_out[3:0] !== 4'b0010) $fatal(1, "Request did not enter startup");
            for (warm = 1; warm <= 7; warm = warm + 1) begin
                tick();
                if (uo_out[3:0] !== 4'b0010) $fatal(1, "Startup ended before eight clocks");
            end
            tick();
            if (uo_out[3:1] !== 3'b011) $fatal(1, "Ready not asserted at eighth startup clock");
        end
    endtask
    task passed;
        input [8*80-1:0] name;
        begin
            $fwrite(results, "<testcase name='%0s'/>", name);
            $display("PASS %0s", name);
        end
    endtask

    initial begin
        $dumpfile("waveform.vcd"); $dumpvars(1, tb);
        results = $fopen("results.xml", "w");
        if (!results) $fatal(1, "Cannot create xUnit results");
        $fwrite(results, "<testsuite tests='14'>");

        reset_healthy();
        repeat (4) begin tick(); expect_off(); end
        passed("reset-and-idle");

        inputs(1, 1, 0, 0, 15); ena = 0;
        repeat (12) begin tick(); expect_off(); end
        ena = 1;
        passed("disabled-safe");

        enter_run(8);
        passed("minimum-startup-delay");

        reset_healthy(); inputs(1, 0, 0, 0, 8); tick();
        for (i = 1; i <= 20; i = i + 1) begin
            tick();
            if (uo_out[3:0] !== 4'b0010) $fatal(1, "Startup did not wait for power-good");
        end
        inputs(1, 1, 0, 0, 8); tick();
        if (uo_out[3:1] !== 3'b011) $fatal(1, "Late power-good was ignored");
        passed("startup-waits-for-power-good");

        reset_healthy(); inputs(1, 0, 0, 0, 8); tick();
        for (i = 1; i <= 255; i = i + 1) begin
            tick();
            if (uo_out[3:0] !== 4'b0010) $fatal(1, "Startup timed out early at %0d", i);
        end
        tick(); expect_fault();
        inputs(1, 1, 0, 0, 8); tick(); expect_fault();
        passed("startup-timeout-latches");

        reset_healthy(); inputs(1, 0, 0, 0, 8); tick();
        repeat (255) tick();
        inputs(1, 1, 0, 0, 8); tick();
        if (uo_out[3:1] !== 3'b011) $fatal(1, "Power-good at deadline did not win");
        passed("power-good-at-timeout-boundary");

        enter_run(15);
        inputs(1, 1, 1, 0, 15);
        if (uo_out[2:0] !== 0) $fatal(1, "Fault did not immediately inhibit drive");
        tick(); expect_fault();
        inputs(1, 1, 0, 0, 15); repeat (4) begin tick(); expect_fault(); end
        passed("fault-inhibit-and-latch");

        inputs(1, 1, 0, 1, 15); tick(); expect_fault();
        inputs(0, 1, 1, 1, 15); tick(); expect_fault();
        inputs(0, 1, 0, 0, 15); tick(); expect_fault();
        inputs(0, 0, 0, 1, 15); tick(); expect_off();
        inputs(1, 1, 0, 1, 15); tick();
        if (uo_out[3:0] !== 4'b0010) $fatal(1, "Safe fault clear did not permit restart");
        passed("fault-clear-interlock");

        enter_run(15);
        inputs(1, 0, 0, 0, 15);
        if (uo_out[2:0] !== 0) $fatal(1, "Loss of power-good did not inhibit drive");
        tick(); expect_fault();
        inputs(1, 1, 0, 0, 15); tick(); expect_fault();
        passed("running-power-good-loss");

        for (duty = 0; duty < 16; duty = duty + 1) begin
            enter_run(duty[3:0]);
            highs = uo_out[0];
            for (i = 1; i < 256; i = i + 1) begin
                tick();
                if (uo_out[3:1] !== 3'b011) $fatal(1, "Run flags changed during PWM");
                if (uo_out[0] !== (i < duty * 16)) $fatal(1, "PWM edge at wrong slot for command %0d slot %0d", duty, i);
                highs = highs + uo_out[0];
            end
            if (highs != duty * 16) $fatal(1, "Wrong high-slot count for command %0d: %0d", duty, highs);
        end
        passed("all-sixteen-duty-levels");

        enter_run(3);
        repeat (63) tick();
        inputs(1, 1, 0, 0, 12);
        if (uo_out[0] !== 0) $fatal(1, "Duty update changed partial pulse immediately");
        tick();
        for (i = 65; i < 256; i = i + 1) begin
            tick();
            if (uo_out[0] !== 0) $fatal(1, "Duty update took effect before boundary");
        end
        tick(); highs = uo_out[0];
        for (i = 1; i < 256; i = i + 1) begin tick(); highs = highs + uo_out[0]; end
        if (highs != 192) $fatal(1, "New PWM frame did not use command twelve");
        tick(); highs = uo_out[0];
        inputs(1, 1, 0, 0, 0); tick(); highs = highs + uo_out[0];
        for (i = 2; i < 256; i = i + 1) begin tick(); highs = highs + uo_out[0]; end
        if (highs != 192) $fatal(1, "Zero command shortened the current PWM frame");
        repeat (256) begin tick(); if (uo_out[0] !== 0) $fatal(1, "Zero command not applied at frame boundary"); end
        passed("duty-updates-only-at-frame-boundary");

        enter_run(15);
        inputs(0, 1, 0, 0, 15);
        if (uo_out[2:0] !== 0) $fatal(1, "Stop request did not inhibit drive");
        tick(); expect_off();
        inputs(1, 1, 0, 0, 15); tick();
        if (uo_out[3:0] !== 4'b0010) $fatal(1, "Restart skipped startup delay");
        passed("stop-and-restart");

        enter_run(15);
        @(negedge clk); ena = 0; #1;
        if (uo_out[2:0] !== 0) $fatal(1, "Clock-enable disable did not inhibit drive");
        tick(); expect_off(); ena = 1; tick();
        if (uo_out[3:0] !== 4'b0010) $fatal(1, "Re-enable skipped startup");
        @(negedge clk); ui_in[2] = 1; ena = 0;
        tick(); expect_fault(); ui_in[2] = 0;
        repeat (3) begin tick(); expect_fault(); end
        passed("enable-abort-and-independent-fault-capture");

        enter_run(15);
        @(negedge clk); #3; rst_n = 0; #1; expect_off();
        ui_in[2] = 1; #1; expect_off();
        repeat (2) begin tick(); expect_off(); end
        passed("asynchronous-reset-dominates");

        $fwrite(results, "</testsuite>"); $fclose(results);
        $display("All 14 public-pin acceptance cases passed"); $finish;
    end
    initial begin #1000000; $fatal(1, "Power-controller test deadline exceeded"); end
endmodule
