SIM ?= verilator
TOPLEVEL_LANG = verilog
VERILOG_SOURCES = $(CURDIR)/rtl/scratch.sv
COCOTB_TOPLEVEL = scratch
COCOTB_TEST_MODULES = test_scratch
WAVES = 1
include $(shell cocotb-config --makefiles)/Makefile.sim
