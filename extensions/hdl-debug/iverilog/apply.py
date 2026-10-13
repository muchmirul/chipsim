#!/usr/bin/env python3
"""Apply the read-only observer to an unmodified Icarus Verilog v12_0 tree."""
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
        raise SystemExit(f"Unsupported Icarus sources: {name}: expected {count} matches for {old!r}")
    pending[path] = text.replace(old, new)


edit("tgt-vvp/Makefile.in", "O = vvp.o", "O = chipsim-design.o vvp.o")
edit("tgt-vvp/vvp.c", "int target_design(ivl_design_t des)",
     "extern void chipsim_design_start(ivl_design_t);\n"
     "extern void chipsim_design_finish(void);\n\nint target_design(ivl_design_t des)")
edit("tgt-vvp/vvp.c", "      draw_module_declarations(des);",
     "      chipsim_design_start(des);\n      draw_module_declarations(des);")
edit("tgt-vvp/vvp.c", "      fclose(vvp_out);",
     "      chipsim_design_finish();\n      fclose(vvp_out);")
edit("tgt-vvp/vvp_process.c", "int draw_process(ivl_process_t net, void*x)",
     "extern void chipsim_design_process(ivl_process_t, unsigned);\n"
     "int draw_process(ivl_process_t net, void*x)")
edit("tgt-vvp/vvp_process.c", "      local_count = 0;\n      fprintf(vvp_out, \"    .scope S_%p;\\n\", scope);",
     "      chipsim_design_process(net, thread_count);\n"
     "      local_count = 0;\n      fprintf(vvp_out, \"    .scope S_%p;\\n\", scope);")
edit("vvp/Makefile.in", "O = main.o", "O = chipsim-debug.o main.o")
for file in ("schedule.cc", "vthread.cc", "vpi_tasks.cc"):
    edit("vvp/" + file, "# include  \"config.h\"",
         "# include  \"config.h\"\n# include \"chipsim-debug.h\"")
edit("vvp/vthread.h", "extern void vthread_run(vthread_t thr);",
     "extern void vthread_run(vthread_t thr);\n"
     "extern void chipsim_thread_id(vthread_t thr, const char* id);")
edit("vvp/vthread.cc", "      struct vthread_s*parent;",
     "      std::string chipsim_id;\n      struct vthread_s*parent;")
edit("vvp/vthread.cc", "void vthread_run(vthread_t thr)\n{",
     "void chipsim_thread_id(vthread_t thr, const char* id) { thr->chipsim_id = id; }\n"
     "void vthread_run(vthread_t thr)\n{")
edit("vvp/vthread.cc", "            running_thread = thr;",
     "            running_thread = thr;\n"
     "            vthread_t owner = thr;\n"
     "            while (owner->chipsim_id.empty() && owner->parent) owner = owner->parent;\n"
     "            chipsim_process(owner->chipsim_id);")
edit("vvp/compile.cc", "      vthread_t thr = vthread_new(pc, vpip_peek_current_scope());",
     "      vthread_t thr = vthread_new(pc, vpip_peek_current_scope());\n"
     "      chipsim_thread_id(thr, start_sym);")
edit("vvp/schedule.cc", "      virtual void run_run(void) =0;",
     "      const char* chipsim_region = \"active\";\n      virtual void run_run(void) =0;")
edit("vvp/schedule.cc", "      vpiEndOfCompile();",
     "      vpiEndOfCompile();\n      chipsim_start();")
edit("vvp/schedule.cc", "      vpiPostsim();",
     "      vpiPostsim();\n      chipsim_finish();")
# Record the original queue when an event is scheduled. This avoids calling
# a drained NBA queue 'active' merely because vvp moves it into the active list.
edit("vvp/schedule.cc", "      cur->next = cur;\n      struct event_time_s*ctim = sched_list;",
     "      cur->next = cur;\n      cur->chipsim_region = select_queue == SEQ_NBASSIGN ? \"nba\" :\n"
     "        select_queue == SEQ_INACTIVE ? \"inactive\" :\n"
     "        select_queue == SEQ_RWSYNC ? \"read-write\" :\n"
     "        select_queue == SEQ_ROSYNC ? \"read-only\" : \"active\";\n"
     "      struct event_time_s*ctim = sched_list;")
path = root / "vvp/schedule.cc"
text = pending[path]
text = text.replace("cur->run_run();", "chipsim_phase(cur->chipsim_region);\n\t    cur->run_run();")
pending[path] = text
edit("vvp/vpi_tasks.cc", "\t    vpi_mode_flag = VPI_MODE_CALLTF;",
     "\t    vpi_mode_flag = VPI_MODE_CALLTF;\n            chipsim_report(ref);")

for path, text in pending.items():
    path.write_text(text)
for name in ("chipsim-debug.h", "chipsim-debug.cc"):
    shutil.copyfile(here / name, root / "vvp" / name)
shutil.copyfile(here / "chipsim-design.c", root / "tgt-vvp/chipsim-design.c")
