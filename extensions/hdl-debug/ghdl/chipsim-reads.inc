   --  Use the compiler's signal-read analysis on the elaborated process.
   --  This is static connectivity, not a claim that a read happened at runtime.
   procedure Chipsim_Process_Reads (I : Process_Index_Type)
   is
      P : Proc_Record_Type renames Processes_Table.Table (I);
      List : Iir_List;
      It : List_Iterator;
      Decl : Node;
      Val : Valtyp;
   begin
      if not Grt.Chipsim.Requested then return; end if;
      List := Vhdl.Canon.Canon_Extract_Sensitivity_Process (P.Proc);
      It := List_Iterate_Safe (List);
      while Is_Valid (It) loop
         Decl := Get_Object_Prefix (Get_Element (It));
         if Get_Kind (Decl) = Iir_Kind_Signal_Declaration or
           Get_Kind (Decl) = Iir_Kind_Interface_Signal_Declaration then
            Val := Get_Value (P.Inst, Decl);
            if Val /= No_Valtyp and then Val.Val.Kind = Value_Signal then
               declare
                  S : Signal_Entry renames Signals_Table.Table (Val.Val.S);
               begin
                  for J in 1 .. Uns32'Min (S.Typ.W, 4096) loop
                     Grt.Chipsim.Register_Read
                       (Grt.Threads.Get_Current_Process,
                        Simul.Vhdl_Simul.Read_Sig
                          (Simul.Vhdl_Simul.Sig_Index (S.Sig, J - 1)));
                  end loop;
               end;
            end if;
         end if;
         Next (It);
      end loop;
      Destroy_Iir_List (List);
   end Chipsim_Process_Reads;
