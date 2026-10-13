--  ChipSim observer for GHDL 4.1.0 (mcode). GPL-2.0-or-later.
--  Read-only hooks: no scheduled callbacks, deposits, forces or HDL rewrites.
with Grt.Signals; use Grt.Signals;
with Grt.Rtis_Addr; use Grt.Rtis_Addr;
with Grt.Types; use Grt.Types;
with Grt.Vhdl_Types; use Grt.Vhdl_Types;
package Grt.Chipsim is
   function Requested return Boolean;
   procedure Register_Process (Proc : Process_Acc; Ctxt : Rti_Context);
   procedure Register_Read (Proc : Process_Acc; Sig : Ghdl_Signal_Ptr);
   procedure Initialize;
   procedure Run_Process (Proc : Process_Acc);
   procedure Change (Sig : Ghdl_Signal_Ptr);
   procedure Boundary (Phase : String);
   procedure Report (Kind : String; Msg : Std_String_Ptr;
                     Default_Msg : String; Severity : Integer;
                     Loc : Ghdl_Location_Ptr);
   procedure Finish;
end Grt.Chipsim;
