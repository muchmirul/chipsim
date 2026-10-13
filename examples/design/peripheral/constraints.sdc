create_clock -name clk -period 20 [get_ports clk]
set_input_delay 1 -clock clk [get_ports {rst_n valid write_en address write_data*}]
set_output_delay 1 -clock clk [all_outputs]
