// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 Muchmirul Yusa Setiaji
// See ../COPYING and ../NOTICE for license and upstream attribution.
// ChipSim observer, Icarus Verilog v12_0. GPL-2.0-or-later.
// No simulator writes or scheduler callbacks. Value-change callbacks only read.
#include "chipsim-debug.h"
#include "schedule.h"
#include "vpi_priv.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <vector>
#include <set>
#include <algorithm>

namespace {
FILE* stream = nullptr;
unsigned sequence = 0, bytes = 0;
bool limited = false, signal_limit = false;
std::string phase = "initialization";
struct observed { vpiHandle handle; std::string id, last; };
std::vector<observed*> signals;
std::set<std::string> paths;

std::string quote(const std::string& value) {
  std::string result = "\"";
  char escape[7];
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { result += '\\'; result += c; }
    else if (c < 32) { std::snprintf(escape, sizeof escape, "\\u%04x", c); result += escape; }
    else result += c;
  }
  return result + '"';
}
std::string property(int kind, vpiHandle obj) {
  const char* value = vpi_get_str(kind, obj);
  return value ? value : "";
}
void put(const std::string& line) {
  if (!stream) return;
  std::fputs(line.c_str(), stream); std::fputc('\n', stream); std::fflush(stream);
  bytes += line.size() + 1;
}
void limit(const std::string& reason) {
  if (!limited) put("{\"record\":\"limit\",\"reason\":" + quote(reason) + "}");
  limited = true;
}
void event(const char* kind, const std::string& fields = "") {
  if (!stream || limited) return;
  if (sequence >= 100000 || bytes >= 64 * 1024 * 1024) { limit("event or byte limit"); return; }
  put("{\"record\":\"event\",\"seq\":" + std::to_string(sequence++) +
      ",\"time\":" + quote(std::to_string(schedule_simtime())) +
      ",\"phase\":" + quote(phase) + ",\"kind\":" + quote(kind) + fields + "}");
}
std::string value(vpiHandle obj) {
  s_vpi_value v; v.format = vpiBinStrVal; vpi_get_value(obj, &v);
  std::string bits = v.value.str ? v.value.str : "";
  std::transform(bits.begin(), bits.end(), bits.begin(), ::toupper);
  return bits;
}
PLI_INT32 change(p_cb_data data) {
  (void)data;
  // Multiple VPI handles may alias the same net. Read the observed set at the
  // callback boundary so a snapshot never gives aliases contradictory values.
  std::string changes;
  for (auto sig : signals) {
    auto bits = value(sig->handle);
    if (bits == sig->last) continue;
    if (!changes.empty()) changes += ',';
    changes += quote(sig->id) + ":" + quote(bits);
    sig->last = bits;
  }
  if (!changes.empty()) event("signal", ",\"changes\":{" + changes + "}");
  return 0;
}
void observe(vpiHandle obj, bool constant = false) {
  auto path = property(vpiFullName, obj);
  if (!paths.insert(path).second) return;
  const int width = vpi_get(vpiSize, obj);
  if (width < 1 || width > 4096) {
    put("{\"record\":\"unsupported\",\"path\":" + quote(path) +
        ",\"reason\":\"width exceeds 4096\"}"); return;
  }
  if (signals.size() >= 512) {
    if (!signal_limit) put("{\"record\":\"limit\",\"reason\":\"signal limit\"}");
    signal_limit = true; return;
  }
  auto sig = new observed{obj, "s:" + path, value(obj)};
  signals.push_back(sig);
  put("{\"record\":\"observe\",\"id\":" + quote(sig->id) +
      ",\"path\":" + quote(path) + ",\"width\":" + std::to_string(width) + "}");
  if (constant) return;
  s_vpi_time time{}; time.type = vpiSimTime;
  s_vpi_value val{}; val.format = vpiSuppressVal;
  s_cb_data cb{}; cb.reason = cbValueChange; cb.cb_rtn = change;
  cb.obj = obj; cb.time = &time; cb.value = &val;
  cb.user_data = reinterpret_cast<PLI_BYTE8*>(sig);
  vpi_register_cb(&cb);
}
void scope(vpiHandle parent) {
  for (int kind : {vpiNet, vpiReg, vpiIntegerVar, vpiMemoryWord}) {
    vpiHandle it = vpi_iterate(kind, parent), obj;
    while (it && (obj = vpi_scan(it))) observe(obj);
  }
  vpiHandle params = vpi_iterate(vpiParameter, parent), param;
  while (params && (param = vpi_scan(params))) {
    if (vpi_get(vpiConstType, param) != vpiStringConst && vpi_get(vpiConstType, param) != vpiRealConst)
      observe(param, true);
  }
  for (int kind : {vpiModule, vpiGenScope, vpiNamedBegin, vpiNamedFork, vpiMemory}) {
    vpiHandle it = vpi_iterate(kind, parent), obj;
    while (it && (obj = vpi_scan(it))) scope(obj);
  }
}
}

void chipsim_start() {
  const char* file = std::getenv("CHIPSIM_DEBUG_STREAM");
  if (!file) return;
  stream = std::fopen(file, "w");
  if (!stream) { std::perror("ChipSim observer"); return; }
  const auto previous_mode = vpi_mode_flag;
  vpi_mode_flag = VPI_MODE_ROSYNC;
  put("{\"record\":\"header\",\"protocol\":1,\"backend\":\"iverilog-12.0\","
      "\"instrumentation\":\"chipsim-1\",\"precision\":" +
      std::to_string(vpi_get(vpiTimePrecision, nullptr)) + "}");
  // Root iteration accepts modules only, unlike iteration within a scope.
  vpiHandle it = vpi_iterate(vpiModule, nullptr), obj;
  while (it && (obj = vpi_scan(it))) scope(obj);
  std::string initial;
  for (auto sig : signals) {
    if (!initial.empty()) initial += ',';
    initial += quote(sig->id) + ":" + quote(sig->last);
  }
  event("initialize", ",\"changes\":{" + initial + "}");
  vpi_mode_flag = previous_mode;
}
void chipsim_finish() {
  if (!stream) return;
  phase = "finish";
  event("finish");
  put("{\"record\":\"end\",\"events\":" + std::to_string(sequence) + "}");
  std::fclose(stream); stream = nullptr;
}
void chipsim_phase(const char* next) {
  if (!stream) return;
  if (phase != next) { phase = next; event("boundary"); }
}
void chipsim_process(const std::string& id) {
  if (stream) event("process", ",\"process\":" + quote("p:" + id));
}
void chipsim_report(vpiHandle call) {
  if (!stream) return;
  auto kind = property(vpiName, call);
  if (kind != "$error" && kind != "$fatal" && kind != "$warning" && kind != "$info") return;
  std::string arguments = "[";
  vpiHandle it = vpi_iterate(vpiArgument, call), arg;
  while (it && (arg = vpi_scan(it))) {
    s_vpi_value v{};
    v.format = vpi_get(vpiType, arg) == vpiConstant &&
      vpi_get(vpiConstType, arg) == vpiStringConst ? vpiStringVal : vpiBinStrVal;
    vpi_get_value(arg, &v);
    if (arguments.size() > 1) arguments += ',';
    arguments += quote(v.value.str ? v.value.str : "");
  }
  event("assertion", ",\"reportKind\":" + quote(kind) + ",\"arguments\":" + arguments +
    "],\"source\":{\"file\":" + quote(property(vpiFile, call)) +
    ",\"line\":" + std::to_string(vpi_get(vpiLineNo, call)) + "}");
}
