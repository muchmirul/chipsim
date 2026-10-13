export DESIGN_NAME = scratch
export PLATFORM = sky130hd
export VERILOG_FILES = $(dir $(DESIGN_CONFIG))/rtl/scratch.sv
export SDC_FILE = $(dir $(DESIGN_CONFIG))/constraints.sdc
export DIE_AREA = 0 0 180 180
export CORE_AREA = 10 10 170 170
export PLACE_DENSITY_LB_ADDON = 0.20
export TNS_END_PERCENT = 100
