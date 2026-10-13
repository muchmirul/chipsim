// ChipSim observer, Icarus Verilog v12_0. GPL-2.0-or-later.
#ifndef CHIPSIM_DEBUG_H
#define CHIPSIM_DEBUG_H
#include <string>
#include "vpi_user.h"
void chipsim_start();
void chipsim_finish();
void chipsim_phase(const char* phase);
void chipsim_process(const std::string& id);
void chipsim_report(vpiHandle call);
#endif
