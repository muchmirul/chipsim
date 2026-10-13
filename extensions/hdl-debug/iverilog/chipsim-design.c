/* ChipSim elaboration observer, Icarus Verilog v12_0. GPL-2.0-or-later. */
#include "ivl_target.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static FILE* out;
static unsigned object_count;
static void quote(const char* s) {
  fputc('"', out);
  if (s) for (; *s; ++s) {
    unsigned char c = *s;
    if (c == '"' || c == '\\') { fputc('\\', out); fputc(c, out); }
    else if (c < 32) fprintf(out, "\\u%04x", c);
    else fputc(c, out);
  }
  fputc('"', out);
}
static void source(const char* file, unsigned line) {
  fputs(",\"source\":{\"file\":", out); quote(file);
  fprintf(out, ",\"line\":%u}", line);
}
static void id(const char* prefix, const char* name) {
  char* s = malloc(strlen(prefix) + strlen(name) + 1);
  strcpy(s, prefix); strcat(s, name); quote(s); free(s);
}
static void signal_id(ivl_signal_t s) {
  id("s:", ivl_signal_name(s));
}
static void edge_signal(const char* process, ivl_signal_t sig, const char* kind) {
  if (!sig) return;
  fputs("{\"record\":\"edge\",\"from\":", out);
  if (!strcmp(kind,"writes")) quote(process); else signal_id(sig);
  fputs(",\"to\":", out);
  if (!strcmp(kind,"writes")) signal_id(sig); else quote(process);
  fputs(",\"kind\":", out); quote(kind); fputs("}\n", out);
}
static void statement(ivl_statement_t, const char*, unsigned);
static void expression(ivl_expr_t e, const char* p, unsigned depth) {
  unsigned i;
  if (!e || depth > 256) return;
  switch (ivl_expr_type(e)) {
    case IVL_EX_SIGNAL:
      edge_signal(p, ivl_expr_signal(e), "reads");
      expression(ivl_expr_oper1(e), p, depth+1); break;
    case IVL_EX_BINARY: case IVL_EX_SELECT: case IVL_EX_SHALLOWCOPY:
      expression(ivl_expr_oper1(e), p, depth+1);
      expression(ivl_expr_oper2(e), p, depth+1); break;
    case IVL_EX_TERNARY:
      expression(ivl_expr_oper1(e), p, depth+1);
      expression(ivl_expr_oper2(e), p, depth+1);
      expression(ivl_expr_oper3(e), p, depth+1); break;
    case IVL_EX_UNARY:
      expression(ivl_expr_oper1(e), p, depth+1); break;
    case IVL_EX_UFUNC:
      statement(ivl_scope_def(ivl_expr_def(e)),p,depth+1);
      for (i=0; i<ivl_expr_parms(e); ++i) expression(ivl_expr_parm(e,i), p, depth+1);
      break;
    case IVL_EX_CONCAT: case IVL_EX_SFUNC: case IVL_EX_ARRAY_PATTERN:
      for (i=0; i<ivl_expr_parms(e); ++i) expression(ivl_expr_parm(e,i), p, depth+1);
      break;
    default: break;
  }
}
static void nexus_edge(ivl_nexus_t nex, const char* other, const char* kind, int output) {
  unsigned i;
  if (!nex) return;
  for (i=0; i<ivl_nexus_ptrs(nex); ++i) {
    ivl_signal_t sig = ivl_nexus_ptr_sig(ivl_nexus_ptr(nex,i));
    if (!sig) continue;
    fputs("{\"record\":\"edge\",\"from\":", out);
    if (output) quote(other); else signal_id(sig);
    fputs(",\"to\":", out);
    if (output) signal_id(sig); else quote(other);
    fputs(",\"kind\":", out); quote(kind); fputs("}\n", out);
  }
}
static void statement(ivl_statement_t s, const char* p, unsigned depth) {
  unsigned i,j;
  if (!s || depth > 256) return;
  switch (ivl_statement_type(s)) {
    case IVL_ST_ASSIGN: case IVL_ST_ASSIGN_NB: case IVL_ST_CASSIGN: case IVL_ST_FORCE:
      for (i=0; i<ivl_stmt_lvals(s); ++i) {
        ivl_lval_t l = ivl_stmt_lval(s,i);
        edge_signal(p, ivl_lval_sig(l), "writes");
        expression(ivl_lval_idx(l), p, depth+1);
        expression(ivl_lval_part_off(l), p, depth+1);
      }
      expression(ivl_stmt_rval(s), p, depth+1); break;
    case IVL_ST_BLOCK: case IVL_ST_FORK: case IVL_ST_FORK_JOIN_ANY: case IVL_ST_FORK_JOIN_NONE:
      for(i=0; i<ivl_stmt_block_count(s); ++i) statement(ivl_stmt_block_stmt(s,i),p,depth+1);
      break;
    case IVL_ST_CONDIT:
      expression(ivl_stmt_cond_expr(s),p,depth+1);
      statement(ivl_stmt_cond_true(s),p,depth+1);
      statement(ivl_stmt_cond_false(s),p,depth+1); break;
    case IVL_ST_CASE: case IVL_ST_CASEX: case IVL_ST_CASEZ: case IVL_ST_CASER:
      expression(ivl_stmt_cond_expr(s),p,depth+1);
      for(i=0; i<ivl_stmt_case_count(s); ++i) {
        expression(ivl_stmt_case_expr(s,i),p,depth+1);
        statement(ivl_stmt_case_stmt(s,i),p,depth+1);
      } break;
    case IVL_ST_WAIT:
      for (i=0; i<ivl_stmt_nevent(s); ++i) {
        ivl_event_t e = ivl_stmt_events(s,i);
        for(j=0;j<ivl_event_nany(e);++j) nexus_edge(ivl_event_any(e,j),p,"sensitivity",0);
        for(j=0;j<ivl_event_npos(e);++j) nexus_edge(ivl_event_pos(e,j),p,"posedge",0);
        for(j=0;j<ivl_event_nneg(e);++j) nexus_edge(ivl_event_neg(e,j),p,"negedge",0);
      }
      statement(ivl_stmt_sub_stmt(s),p,depth+1); break;
    case IVL_ST_WHILE: case IVL_ST_DO_WHILE: case IVL_ST_REPEAT:
      expression(ivl_stmt_cond_expr(s),p,depth+1);
      statement(ivl_stmt_sub_stmt(s),p,depth+1); break;
    case IVL_ST_DELAYX:
      expression(ivl_stmt_delay_expr(s),p,depth+1);
      statement(ivl_stmt_sub_stmt(s),p,depth+1); break;
    case IVL_ST_DELAY: case IVL_ST_FOREVER:
      statement(ivl_stmt_sub_stmt(s),p,depth+1); break;
    case IVL_ST_STASK:
      for (i=0; i<ivl_stmt_parm_count(s); ++i) expression(ivl_stmt_parm(s,i),p,depth+1);
      break;
    case IVL_ST_UTASK:
      statement(ivl_scope_def(ivl_stmt_call(s)),p,depth+1); break;
    default: break;
  }
}
void chipsim_design_process(ivl_process_t proc, unsigned thread) {
  char p[48];
  if (!out) return;
  snprintf(p,sizeof p,"p:T_%u",thread);
  fputs("{\"record\":\"object\",\"kind\":\"process\",\"id\":",out); quote(p);
  fputs(",\"scope\":",out); quote(ivl_scope_name(ivl_process_scope(proc)));
  fprintf(out,",\"processType\":%u",ivl_process_type(proc));
  source(ivl_process_file(proc),ivl_process_lineno(proc)); fputs("}\n",out);
  statement(ivl_process_stmt(proc),p,0);
}
static int scope(ivl_scope_t s, void* unused) {
  unsigned i,j;
  (void)unused;
  if (++object_count > 16384) return 0;
  fputs("{\"record\":\"object\",\"kind\":\"instance\",\"id\":",out); id("b:",ivl_scope_name(s));
  fputs(",\"path\":",out); quote(ivl_scope_name(s));
  if(ivl_scope_parent(s)) { fputs(",\"scope\":",out); quote(ivl_scope_name(ivl_scope_parent(s))); }
  fprintf(out,",\"scopeType\":%u",ivl_scope_type(s));
  source(ivl_scope_def_file(s),ivl_scope_def_lineno(s)); fputs("}\n",out);
  for(i=0;i<ivl_scope_sigs(s);++i) {
    ivl_signal_t sig=ivl_scope_sig(s,i);
    const char* name=ivl_signal_name(sig);
    unsigned count=ivl_signal_array_count(sig);
    if(ivl_signal_data_type(sig)!=IVL_VT_BOOL && ivl_signal_data_type(sig)!=IVL_VT_LOGIC) {
      fputs("{\"record\":\"unsupported\",\"path\":",out); quote(name);
      fputs(",\"reason\":\"non-digital signal type\"}\n",out);
    }

    if (ivl_signal_dimensions(sig)) {
      fputs("{\"record\":\"object\",\"kind\":\"net\",\"id\":",out); signal_id(sig);
      fputs(",\"path\":",out); quote(name);
      fputs(",\"scope\":",out); quote(ivl_scope_name(s));
      fputs(",\"aggregate\":true",out);
      source(ivl_signal_file(sig),ivl_signal_lineno(sig)); fputs("}\n",out);
    }
    for(j=0;j<count;++j) {
      char path[4096];
      if (ivl_signal_dimensions(sig)) snprintf(path,sizeof path,"%s[%d]",name,ivl_signal_array_base(sig)+(int)j);
      else snprintf(path,sizeof path,"%s",name);
      fputs("{\"record\":\"object\",\"kind\":\"signal\",\"id\":",out); id("s:",path);
      fputs(",\"path\":",out); quote(path);
      fputs(",\"scope\":",out); quote(ivl_scope_name(s));
      fprintf(out,",\"dataType\":%u",ivl_signal_data_type(sig));
      fprintf(out,",\"width\":%u,\"signed\":%s,\"mode\":%u,\"local\":%s,\"variable\":%s",
        ivl_signal_width(sig),ivl_signal_signed(sig)?"true":"false",ivl_signal_port(sig),
        ivl_signal_local(sig)?"true":"false",ivl_signal_type(sig)==IVL_SIT_REG?"true":"false");
      if(ivl_signal_packed_dimensions(sig)) fprintf(out,",\"left\":%d,\"right\":%d",ivl_signal_packed_msb(sig,0),ivl_signal_packed_lsb(sig,0));
      source(ivl_signal_file(sig),ivl_signal_lineno(sig)); fputs("}\n",out);
      if (ivl_signal_dimensions(sig)) {
        fputs("{\"record\":\"edge\",\"from\":",out); signal_id(sig);
        fputs(",\"to\":",out); id("s:",path); fputs(",\"kind\":\"contains\"}\n",out);
      }
    }
  }
  for(i=0;i<ivl_scope_params(s);++i) {
    ivl_parameter_t p=ivl_scope_param(s,i);
    if(ivl_parameter_is_type(p) || ivl_expr_type(ivl_parameter_expr(p))!=IVL_EX_NUMBER) continue;
    char path[4096]; snprintf(path,sizeof path,"%s.%s",ivl_scope_name(s),ivl_parameter_basename(p));
    fputs("{\"record\":\"object\",\"kind\":\"signal\",\"id\":",out); id("s:",path);
    fputs(",\"path\":",out); quote(path);
    fputs(",\"scope\":",out); quote(ivl_scope_name(s));
    fprintf(out,",\"constant\":true,\"width\":%u,\"signed\":%s",ivl_parameter_width(p),ivl_parameter_signed(p)?"true":"false");
    source(ivl_parameter_file(p),ivl_parameter_lineno(p)); fputs("}\n",out);
  }
  for(i=0;i<ivl_scope_logs(s);++i) {
    ivl_net_logic_t gate=ivl_scope_log(s,i);
    char op[64]; snprintf(op,sizeof op,"o:logic:%p",(void*)gate);
    fputs("{\"record\":\"object\",\"kind\":\"operation\",\"id\":",out); quote(op);
    fputs(",\"scope\":",out); quote(ivl_scope_name(s));
    fprintf(out,",\"operation\":\"logic:%u\",\"width\":%u}\n",ivl_logic_type(gate),ivl_logic_width(gate));
    for(j=0;j<ivl_logic_pins(gate);++j) nexus_edge(ivl_logic_pin(gate,j),op,j?"reads":"writes",j==0);
  }
  for(i=0;i<ivl_scope_lpms(s);++i) {
    ivl_lpm_t lpm=ivl_scope_lpm(s,i);
    char op[64]; snprintf(op,sizeof op,"o:lpm:%p",(void*)lpm);
    fputs("{\"record\":\"object\",\"kind\":\"operation\",\"id\":",out); quote(op);
    fputs(",\"scope\":",out); quote(ivl_scope_name(s));
    fprintf(out,",\"operation\":\"lpm:%u\",\"width\":%u}\n",ivl_lpm_type(lpm),ivl_lpm_width(lpm));
    /* Output and input connectivity is enumerated from nexus pointer roles
       below; no type-specific ivl_lpm_data accessors on unsupported kinds. */
  }
  return ivl_scope_children(s,scope,0);
}
static int connections(ivl_scope_t s, void* unused) {
  unsigned i,j,k;
  (void)unused;
  for(i=0;i<ivl_scope_sigs(s);++i) {
    ivl_signal_t sig=ivl_scope_sig(s,i);
    for(j=0;j<ivl_signal_array_count(sig);++j) {
      ivl_nexus_t nex=ivl_signal_nex(sig,j);
      if(!nex) continue;
      for(k=0;k<ivl_nexus_ptrs(nex);++k) {
        ivl_nexus_ptr_t ptr=ivl_nexus_ptr(nex,k);
        ivl_lpm_t lpm=ivl_nexus_ptr_lpm(ptr);
        ivl_signal_t other=ivl_nexus_ptr_sig(ptr);
        if(lpm) {
          char op[64]; snprintf(op,sizeof op,"o:lpm:%p",(void*)lpm);
          int output=ivl_nexus_ptr_drive0(ptr)!=IVL_DR_HiZ || ivl_nexus_ptr_drive1(ptr)!=IVL_DR_HiZ;
          edge_signal(op,sig,output?"writes":"reads");
        } else if(other && other!=sig) {
          fputs("{\"record\":\"edge\",\"from\":",out); signal_id(sig);
          fputs(",\"to\":",out); signal_id(other); fputs(",\"kind\":\"alias\"}\n",out);
        }
      }
    }
  }
  return ivl_scope_children(s,connections,0);
}
void chipsim_design_start(ivl_design_t design) {
  const char* path=getenv("CHIPSIM_DEBUG_DESIGN");
  ivl_scope_t* roots; unsigned count,i;
  if(!path) return;
  out=fopen(path,"w"); if(!out) { perror("ChipSim design observer"); return; }
  fputs("{\"record\":\"design\",\"protocol\":1,\"instrumentation\":\"chipsim-1\"}\n",out);
  ivl_design_roots(design,&roots,&count);
  for(i=0;i<count;++i) scope(roots[i],0);
  for(i=0;i<count;++i) connections(roots[i],0);
}
void chipsim_design_finish(void) {
  if(out) { fputs("{\"record\":\"design-end\"}\n",out); fclose(out); out=0; }
}
