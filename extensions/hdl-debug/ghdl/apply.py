#!/usr/bin/env python3
"""Apply the observer to the unmodified GHDL v4.1.0 source release."""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1]).resolve()
here = Path(__file__).resolve().parent
pending = {}


def edit(name, old, new, count=1):
    path = root / name
    text = pending.get(path, path.read_text())
    if text.count(old) != count:
        raise SystemExit(f"Unsupported GHDL sources: {name}: expected {count} matches")
    pending[path] = text.replace(old, new)


# The mcode elaborator has the correct RTI and instance storage, but upstream
# does not pass them to the runtime process registrar. Preserve them for tracing.
path = root / "src/simul/simul-vhdl_compile.adb"
text = path.read_text()
start = text.index("      for I in Processes_Table.First .. Processes_Table.Last loop\n         declare\n            P : Process_State_Type renames Processes_State (I);")
end = text.index("               when Iir_Kind_Psl_Assert_Directive", start)
part = text[start:end]
old = "(P.This, P.Subprg, null, System.Null_Address)"
assert part.count(old) == 4
part = part.replace(old,
    "(P.This, P.Subprg, Grt.Rtis.To_Ghdl_Rti_Access\n"
    "                          (Get_Address (Get_Info (Proc).Process_Rti_Const)),\n"
    "                        To_Address (P.Mem))")
pending[path] = text[:start] + part + text[end:]
edit("src/simul/simul-vhdl_compile.adb", "package body Simul.Vhdl_Compile is",
     "with Vhdl.Canon;\nwith Grt.Chipsim;\nwith Grt.Threads;\n"
     "package body Simul.Vhdl_Compile is")
edit("src/simul/simul-vhdl_compile.adb", "   procedure Create_Process_Drivers (I : Process_Index_Type) is",
     (here / "chipsim-reads.inc").read_text() +
     "   procedure Create_Process_Drivers (I : Process_Index_Type) is")
edit("src/simul/simul-vhdl_compile.adb", "   end Create_Process_Drivers;",
     "      Chipsim_Process_Reads (I);\n   end Create_Process_Drivers;")
edit("src/vhdl/vhdl-canon.adb", "         when Iir_Kind_Break_Statement\n           | Iir_Kind_Wait_Statement =>",
     "         when Iir_Kind_Wait_Statement =>\n"
     "            Canon_Extract_Sensitivity_If_Not_Null\n"
     "              (Get_Condition_Clause (Stmt), List);\n"
     "            Canon_Extract_Sensitivity_If_Not_Null\n"
     "              (Get_Timeout_Clause (Stmt), List);\n"
     "         when Iir_Kind_Break_Statement =>")

for name in ("grt-processes.adb", "grt-signals.adb", "grt-lib.adb", "grt-main.adb"):
    edit("src/grt/" + name, "package body ", "with Grt.Chipsim;\npackage body ")
edit("src/grt/grt-processes.adb", "      Process_Table.Append (P);",
     "      Process_Table.Append (P);\n      Grt.Chipsim.Register_Process (P, P.Rti);", 2)
edit("src/grt/grt-processes.adb", "         Proc.Subprg.all (Proc.This);",
     "         Grt.Chipsim.Run_Process (Proc);\n         Proc.Subprg.all (Proc.This);", 2)
edit("src/grt/grt-processes.adb", "      Init_Signals;",
     "      Init_Signals;\n      Grt.Chipsim.Initialize;")
edit("src/grt/grt-processes.adb", "      --  LRM 1076.1-2017 d)",
     "      Grt.Chipsim.Boundary (\"signal-update\");\n\n      --  LRM 1076.1-2017 d)")
edit("src/grt/grt-processes.adb", "   begin\n      if Postponed then",
     "   begin\n      if Postponed then\n         Grt.Chipsim.Boundary (\"postponed\");\n"
     "      else\n         Grt.Chipsim.Boundary (\"process\");\n      end if;\n      if Postponed then")
edit("src/grt/grt-signals.adb", "      Sig.Event := True;\n      Sig.Last_Event := Current_Time;",
     "      Grt.Chipsim.Change (Sig);\n      Sig.Event := True;\n      Sig.Last_Event := Current_Time;")
edit("src/grt/grt-lib.adb", "   begin\n      Report_S;\n      Diag_C (Loc.Filename);",
     "   begin\n      Grt.Chipsim.Report (Msg, Str, Default_Str, Severity, Loc);\n"
     "      Report_S;\n      Diag_C (Loc.Filename);")
edit("src/grt/grt-main.adb", "      Grt.Hooks.Call_Finish_Hooks;",
     "      Grt.Chipsim.Finish;\n      Grt.Hooks.Call_Finish_Hooks;")

for path, text in pending.items():
    path.write_text(text)
for name in ("grt-chipsim.ads", "grt-chipsim.adb"):
    shutil.copyfile(here / name, root / "src/grt" / name)
