// SPDX-License-Identifier: MIT
// Original ChipSim example: digital PWM and power-good supervision.
module tt_um_chipsim_power_controller (
    input  wire [7:0] ui_in,
    output wire [7:0] uo_out,
    input  wire [7:0] uio_in,
    output wire [7:0] uio_out,
    output wire [7:0] uio_oe,
    input  wire       ena,
    input  wire       clk,
    input  wire       rst_n
);
    localparam [1:0] OFF = 2'd0, STARTUP = 2'd1,
                     RUN = 2'd2, FAULT = 2'd3;
    reg [1:0] state;
    reg [7:0] startup_ticks;
    reg [7:0] pwm_phase;
    reg [3:0] duty_active;

    wire request_on = ui_in[0];
    wire power_good = ui_in[1];
    wire fault_in = ui_in[2];
    wire clear_fault = ui_in[3];
    wire [3:0] duty_command = ui_in[7:4];
    wire fault_latched = (state == FAULT);
    wire allowed = rst_n && ena && request_on && !fault_in && !fault_latched;
    wire ready = allowed && (state == RUN) && power_good;
    wire power_enable = allowed && ((state == STARTUP) || ((state == RUN) && power_good));
    wire [7:0] high_slots = {duty_active, 4'b0000};
    wire pwm_out = ready && (pwm_phase < high_slots);
    wire _unused = &{1'b0, uio_in};

    assign uo_out = {4'b0000, fault_latched, ready, power_enable, pwm_out};
    assign uio_out = 8'b0;
    assign uio_oe = 8'b0;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state <= OFF;
            startup_ticks <= 8'd0;
            pwm_phase <= 8'd0;
            duty_active <= 4'd0;
        end else if (fault_in) begin
            state <= FAULT;
            startup_ticks <= 8'd0;
            pwm_phase <= 8'd0;
            duty_active <= 4'd0;
        end else if (state == FAULT) begin
            if (!request_on && clear_fault) begin
                state <= OFF;
            end
            startup_ticks <= 8'd0;
            pwm_phase <= 8'd0;
            duty_active <= 4'd0;
        end else if (!ena || !request_on) begin
            state <= OFF;
            startup_ticks <= 8'd0;
            pwm_phase <= 8'd0;
            duty_active <= 4'd0;
        end else begin
            case (state)
                OFF: begin
                    state <= STARTUP;
                    startup_ticks <= 8'd0;
                    pwm_phase <= 8'd0;
                    duty_active <= 4'd0;
                end
                STARTUP: begin
                    if ((startup_ticks >= 8'd7) && power_good) begin
                        state <= RUN;
                        startup_ticks <= 8'd0;
                        pwm_phase <= 8'd0;
                        duty_active <= duty_command;
                    end else if (startup_ticks == 8'd255) begin
                        state <= FAULT;
                        startup_ticks <= 8'd0;
                        pwm_phase <= 8'd0;
                        duty_active <= 4'd0;
                    end else begin
                        startup_ticks <= startup_ticks + 8'd1;
                    end
                end
                RUN: begin
                    if (!power_good) begin
                        state <= FAULT;
                        startup_ticks <= 8'd0;
                        pwm_phase <= 8'd0;
                        duty_active <= 4'd0;
                    end else begin
                        pwm_phase <= pwm_phase + 8'd1;
                        if (pwm_phase == 8'd255)
                            duty_active <= duty_command;
                    end
                end
                default: begin
                    state <= OFF;
                    startup_ticks <= 8'd0;
                    pwm_phase <= 8'd0;
                    duty_active <= 4'd0;
                end
            endcase
        end
    end
endmodule
