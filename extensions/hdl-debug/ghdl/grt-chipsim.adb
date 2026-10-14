-- SPDX-License-Identifier: GPL-2.0-or-later
-- Copyright (c) 2026 Muchmirul Yusa Setiaji
-- See ../COPYING and ../NOTICE for license and upstream attribution.
--  ChipSim observer for GHDL 4.1.0 (mcode). GPL-2.0-or-later.
with Ada.Text_IO;
with Ada.Environment_Variables;
with Ada.Strings.Fixed;
with Ada.Strings.Unbounded; use Ada.Strings.Unbounded;
with Ada.Containers.Hashed_Maps;
with Ada.Unchecked_Conversion;
with System; use System;
with System.Storage_Elements; use System.Storage_Elements;
with Grt.Rtis; use Grt.Rtis;
with Grt.Rtis_Utils; use Grt.Rtis_Utils;
with Grt.Rtis_Addr; use Grt.Rtis_Addr;
with Grt.Rstrings;
with Grt.Vstrings;

package body Grt.Chipsim is
   Stream : Ada.Text_IO.File_Type;
   Enabled : Boolean := False;
   Started : Boolean := False;
   Limit_Reached : Boolean := False;
   Signal_Limit : Boolean := False;
   Metadata_Limit : Boolean := False;
   Seq : Natural := 0;
   Bytes : Natural := 0;
   Phase_Name : Unbounded_String := To_Unbounded_String ("initialization");
   Max_Events : constant Natural := 100_000;
   Max_Bytes : constant Natural := 64 * 1024 * 1024;
   Max_Signals : constant Natural := 512;
   Max_Width : constant Natural := 4096;

   function Requested return Boolean is
   begin
      return Ada.Environment_Variables.Exists ("CHIPSIM_DEBUG_STREAM");
   end Requested;

   function N (V : Integer) return String is
   begin
      return Ada.Strings.Fixed.Trim (Integer'Image (V), Ada.Strings.Both);
   end N;

   function C (S : Ghdl_C_String) return String is
      Len : Natural := 0;
   begin
      if S = null then return ""; end if;
      while S (Len + 1) /= Character'Val (0) loop Len := Len + 1; end loop;
      return S (1 .. Len);
   end C;

   function Q (S : String) return String is
      R : Unbounded_String := To_Unbounded_String ("""");
      Hex : constant String := "0123456789abcdef";
      V : Natural;
   begin
      for Ch of S loop
         V := Character'Pos (Ch);
         if Ch = '"' or Ch = '\' then Append (R, '\'); Append (R, Ch);
         elsif V < 32 then
            Append (R, "\u00" & Hex (V / 16 + 1) & Hex (V mod 16 + 1));
         else Append (R, Ch); end if;
      end loop;
      Append (R, '"');
      return To_String (R);
   end Q;

   function Path (Ctxt : Rti_Context) return String is
      R : Grt.Rstrings.Rstring;
   begin
      if Ctxt.Block = null then return ""; end if;
      Get_Path_Name (R, Ctxt, '.', False);
      declare
         S : String (1 .. Grt.Rstrings.Length (R));
         Len : Natural;
      begin
         Grt.Rstrings.Copy (R, S, Len);
         Grt.Rstrings.Free (R);
         if S'Length > 0 and then S (1) = '.' then return S (2 .. Len); end if;
         return S;
      end;
   end Path;

   function Location (Ctxt : Rti_Context; Linecol : Ghdl_Index_Type)
                     return String is
   begin
      if Ctxt.Block = null then return "null"; end if;
      return "{""file"":" & Q (C (Get_Filename (Ctxt))) &
        ",""line"":" & N (Integer (Get_Linecol_Line (Linecol))) &
        ",""column"":" & N (Integer (Get_Linecol_Col (Linecol))) & "}";
   end Location;

   procedure Put (S : String) is
   begin
      if Enabled then
         Ada.Text_IO.Put_Line (Stream, S);
         Ada.Text_IO.Flush (Stream);
         Bytes := Bytes + S'Length + 1;
      end if;
   end Put;

   procedure Limit (Reason : String) is
   begin
      if not Limit_Reached then
         Put ("{""record"":""limit"",""reason"":" & Q (Reason) & "}");
         Limit_Reached := True;
      end if;
   end Limit;

   procedure Event (Kind : String; Fields : String := "") is
   begin
      if not Enabled or not Started or Limit_Reached then return; end if;
      if Seq >= Max_Events or Bytes >= Max_Bytes then
         Limit ("event or byte limit"); return;
      end if;
      Put ("{""record"":""event"",""seq"":" & N (Seq) &
        ",""time"":" & Q (Ada.Strings.Fixed.Trim
           (Std_Time'Image (Current_Time), Ada.Strings.Both)) &
        ",""delta"":" & N (Current_Delta) &
        ",""phase"":" & Q (To_String (Phase_Name)) &
        ",""kind"":" & Q (Kind) & Fields & "}");
      Seq := Seq + 1;
   end Event;

   type Process_Info is record
      Proc : Process_Acc;
      Ctxt : Rti_Context;
   end record;
   Process_List : array (1 .. 16384) of Process_Info;
   Process_Count : Natural := 0;
   type Read_Info is record
      Proc : Process_Acc;
      Sig : Ghdl_Signal_Ptr;
   end record;
   Read_List : array (1 .. 65536) of Read_Info;
   Read_Count : Natural := 0;
   procedure Register_Read (Proc : Process_Acc; Sig : Ghdl_Signal_Ptr) is
   begin
      if Requested and Read_Count < Read_List'Last then
         Read_Count := Read_Count + 1;
         Read_List (Read_Count) := (Proc, Sig);
      elsif Requested then
         Metadata_Limit := True;
      end if;
   end Register_Read;
   function Process_Id (Proc : Process_Acc) return String is
   begin
      for I in 1 .. Process_Count loop
         if Process_List (I).Proc = Proc then return "p:" & N (I); end if;
      end loop;
      return "";
   end Process_Id;

   procedure Register_Process (Proc : Process_Acc; Ctxt : Rti_Context) is
   begin
      if not Ada.Environment_Variables.Exists ("CHIPSIM_DEBUG_STREAM") then
         return;
      end if;
      if Process_Count < Process_List'Last then
         Process_Count := Process_Count + 1;
         Process_List (Process_Count) := (Proc, Ctxt);
      else
         Metadata_Limit := True;
      end if;
   end Register_Process;

   type Scalar_Info is record
      Sig : Ghdl_Signal_Ptr;
      Typ : Ghdl_Rti_Access;
      Width : Natural;
   end record;
   type Scalar_Array is array (Positive range <>) of Scalar_Info;
   type Scalar_Array_Acc is access Scalar_Array;
   type Signal_Info is record
      Id : Unbounded_String;
      Bits : Scalar_Array_Acc;
   end record;
   Signal_List : array (1 .. Max_Signals) of Signal_Info;
   Signal_Count : Natural := 0;
   type Group_Link;
   type Group_Link_Acc is access Group_Link;
   type Group_Link is record
      Group : Natural;
      Next : Group_Link_Acc;
   end record;
   function Ptr_Address is new Ada.Unchecked_Conversion
     (Ghdl_Signal_Ptr, Address);
   function Hash (P : Ghdl_Signal_Ptr) return Ada.Containers.Hash_Type is
   begin
      return Ada.Containers.Hash_Type
        (System.Storage_Elements.To_Integer (Ptr_Address (P)) mod 2 ** 32);
   end Hash;
   package Signal_Map is new Ada.Containers.Hashed_Maps
     (Ghdl_Signal_Ptr, Group_Link_Acc, Hash, "=");
   Signal_Groups : Signal_Map.Map;

   function Binary (Value : Ghdl_U64; Width : Natural) return String is
      R : String (1 .. Width);
      V : Ghdl_U64 := Value;
   begin
      for I in reverse R'Range loop
         if V mod 2 = 0 then R (I) := '0'; else R (I) := '1'; end if;
         V := V / 2;
      end loop;
      return R;
   end Binary;

   function Value (Bit : Scalar_Info) return String is
      Val : constant Value_Union := Read_Value (Bit.Sig.Value_Ptr, Bit.Sig.Mode);
      Logic : constant String := "UX01ZWLH-";
   begin
      case Bit.Sig.Mode is
         when Mode_B1 =>
            if Val.B1 then return "1"; else return "0"; end if;
         when Mode_E8 =>
            if Bit.Width = 1 then
               return "" & Logic (Integer (Val.E8) + 1);
            end if;
            return Binary (Ghdl_U64 (Val.E8), Bit.Width);
         when Mode_E32 => return Binary (Ghdl_U64 (Val.E32), Bit.Width);
         when Mode_I32 => return Binary (To_Ghdl_U64 (Ghdl_I64 (Val.I32)), 32);
         when Mode_I64 => return Binary (To_Ghdl_U64 (Val.I64), 64);
         when others => return "";
      end case;
   end Value;

   function Signal_Value (Idx : Natural) return String is
      R : Unbounded_String;
   begin
      for Bit of Signal_List (Idx).Bits.all loop Append (R, Value (Bit)); end loop;
      return To_String (R);
   end Signal_Value;

   procedure Edge (From_Id, To_Id, Kind : String) is
   begin
      if From_Id /= "" and To_Id /= "" then
         Put ("{""record"":""edge"",""from"":" & Q (From_Id) &
           ",""to"":" & Q (To_Id) & ",""kind"":" & Q (Kind) & "}");
      end if;
   end Edge;

   function Object (Ctxt : Rti_Context; Obj : Ghdl_Rti_Access)
                   return Traverse_Result is
      Sig : Ghdl_Rtin_Object_Acc;
      Temp : Scalar_Array (1 .. Max_Width);
      Count : Natural := 0;
      Width : Natural := 0;
      Bit_Names : Unbounded_String;
      Unsupported : Boolean := False;
      procedure Scalar (Val_Addr : Address; Val_Name : Grt.Vstrings.Vstring;
                        Val_Type : Ghdl_Rti_Access; Param : Natural) is
         pragma Unreferenced (Param);
         P : constant Ghdl_Signal_Ptr := To_Signal_Arr_Ptr (Val_Addr)(0);
         W : Natural;
         Type_Name : constant String := C
           (To_Ghdl_Rtin_Type_Enum_Acc (Val_Type).Name);
      begin
         case P.Mode is
            when Mode_B1 => W := 1;
            when Mode_E8 =>
               if Type_Name = "std_ulogic" then W := 1; else W := 8; end if;
            when Mode_E32 | Mode_I32 => W := 32;
            when Mode_I64 => W := 64;
            when others => Unsupported := True; return;
         end case;
         if Width + W > Max_Width then Unsupported := True; return; end if;
         Count := Count + 1;
         Width := Width + W;
         Temp (Count) := (P, Val_Type, W);
         if Count > 1 then Append (Bit_Names, ","); end if;
         --  Foreach_Scalar supplies declaration-order indexes, including TO.
         declare
            function Str is new Ada.Unchecked_Conversion
              (Address, Ghdl_C_String);
            S : constant Ghdl_C_String := Str (Grt.Vstrings.Get_Address (Val_Name));
         begin
            if Grt.Vstrings.Length (Val_Name) = 0 then
               Append (Bit_Names, Q (""));
            else
               Append (Bit_Names, Q (S (1 .. Grt.Vstrings.Length (Val_Name))));
            end if;
         end;
      end Scalar;
      procedure Scalars is new Foreach_Scalar (Natural, Scalar);
   begin
      if Obj.Kind = Ghdl_Rtik_Architecture or Obj.Kind = Ghdl_Rtik_Block or
        Obj.Kind = Ghdl_Rtik_Generate_Body then
         Put ("{""record"":""object"",""kind"":""instance"",""id"":" &
           Q ("b:" & Path (Ctxt)) & ",""path"":" & Q (Path (Ctxt)) &
           ",""source"":" & Location (Ctxt,
             To_Ghdl_Rtin_Block_Acc (Obj).Linecol) & "}");
      elsif Obj.Kind = Ghdl_Rtik_Signal or Obj.Kind = Ghdl_Rtik_Port then
         if Signal_Count = Max_Signals then
            if not Signal_Limit then
               Put ("{""record"":""limit"",""reason"":""signal limit""}");
               Signal_Limit := True;
            end if;
            return Traverse_Skip;
         end if;
         Sig := To_Ghdl_Rtin_Object_Acc (Obj);
         Scalars (Ctxt, Sig.Obj_Type,
           Loc_To_Addr (Sig.Common.Depth, Sig.Loc, Ctxt), True, 0);
         if Unsupported or Count = 0 then
            Put ("{""record"":""unsupported"",""path"":" &
              Q (Path (Ctxt) & "." & C (Sig.Name)) &
              ",""reason"":""non-digital type or width exceeds 4096""}");
            return Traverse_Ok;
         end if;
         Signal_Count := Signal_Count + 1;
         declare
            Id : constant String := "s:" & Path (Ctxt) & "." & C (Sig.Name);
            Type_Name : constant String := C (To_Ghdl_Rtin_Type_Scalar_Acc
              (Get_Base_Type (Sig.Obj_Type)).Name);
            Signed_Value : constant Boolean := Type_Name = "signed" or
              Type_Name = "unresolved_signed" or
              (Count = 1 and then Temp (1).Sig.Mode in Mode_I32 | Mode_I64);
         begin
            Signal_List (Signal_Count) :=
              (To_Unbounded_String (Id), new Scalar_Array'(Temp (1 .. Count)));
            Put ("{""record"":""object"",""kind"":""signal"",""id"":" &
              Q (Id) & ",""path"":" & Q (Path (Ctxt) & "." & C (Sig.Name)) &
              ",""scope"":" & Q (Path (Ctxt)) & ",""width"":" & N (Width) &
              ",""type"":" & Q (Type_Name) &
              ",""signed"":" & (if Signed_Value then "true" else "false") &
              ",""mode"":" & N (Integer (Sig.Common.Mode mod 16)) &
              ",""bitNames"":" & "[" & To_String (Bit_Names) & "]" &
              ",""source"":" & Location (Ctxt, Sig.Linecol) & "}");
            for J in 1 .. Count loop
               declare
                  P : constant Ghdl_Signal_Ptr := Temp (J).Sig;
                  Head : Group_Link_Acc := null;
                  A : Action_List_Acc;
               begin
                  if Signal_Groups.Contains (P) then
                     Head := Signal_Groups.Element (P);
                     Edge (To_String (Signal_List (Head.Group).Id), Id, "shares-bits");
                  end if;
                  Signal_Groups.Include (P, new Group_Link'(Signal_Count, Head));
                  if P.S.Mode_Sig in Mode_Signal_User then
                     for D in 1 .. P.S.Nbr_Drivers loop
                        Edge (Process_Id (P.S.Drivers (D - 1).Proc), Id, "writes");
                     end loop;
                  end if;
                  A := P.Event_List;
                  while A /= null loop
                     Edge (Id, Process_Id (A.Proc), "sensitivity"); A := A.Next;
                  end loop;
               end;
            end loop;
         end;
      end if;
      return Traverse_Ok;
   end Object;

   function Walk is new Traverse_Blocks (Object);

   procedure Initialize is
      Res : Traverse_Result;
      pragma Unreferenced (Res);
   begin
      if not Ada.Environment_Variables.Exists ("CHIPSIM_DEBUG_STREAM") then
         return;
      end if;
      Ada.Text_IO.Create (Stream, Ada.Text_IO.Out_File,
        Ada.Environment_Variables.Value ("CHIPSIM_DEBUG_STREAM"));
      Enabled := True;
      Put ("{""record"":""header"",""protocol"":1,""backend"":""ghdl-4.1.0""," &
        """instrumentation"":""chipsim-1"",""timeUnit"":""fs""}");
      for I in 1 .. Process_Count loop
         declare
            Ctxt : constant Rti_Context := Process_List (I).Ctxt;
            Loc : Unbounded_String := To_Unbounded_String ("null");
            Scope : Unbounded_String;
         begin
            if Ctxt.Block /= null then
               Loc := To_Unbounded_String (Location
                 (Ctxt, To_Ghdl_Rtin_Block_Acc (Ctxt.Block).Linecol));
               Scope := To_Unbounded_String (Path (Get_Parent_Context (Ctxt)));
            end if;
            Put ("{""record"":""object"",""kind"":""process"",""id"":" &
              Q ("p:" & N (I)) & ",""path"":" & Q (Path (Ctxt)) &
              ",""scope"":" & Q (To_String (Scope)) &
              ",""source"":" & To_String (Loc) & "}");
         end;
      end loop;
      Res := Walk (Get_Top_Context);
      for I in 1 .. Read_Count loop
         if Signal_Groups.Contains (Read_List (I).Sig) then
            declare
               Link : Group_Link_Acc := Signal_Groups.Element (Read_List (I).Sig);
            begin
               while Link /= null loop
                  Edge (To_String (Signal_List (Link.Group).Id),
                    Process_Id (Read_List (I).Proc), "reads");
                  Link := Link.Next;
               end loop;
            end;
         end if;
      end loop;
      if Metadata_Limit then
         Put ("{""record"":""limit"",""reason"":""process/read metadata limit""}");
      end if;
      Started := True;
      declare
         Initial : Unbounded_String;
      begin
         for I in 1 .. Signal_Count loop
            if I > 1 then Append (Initial, ","); end if;
            Append (Initial, Q (To_String (Signal_List (I).Id)) &
              ":" & Q (Signal_Value (I)));
         end loop;
         Event ("initialize", ",""changes"":{" & To_String (Initial) & "}");
      end;
   end Initialize;

   procedure Run_Process (Proc : Process_Acc) is
   begin
      if Process_Id (Proc) /= "" then
         Event ("process", ",""process"":" & Q (Process_Id (Proc)));
      end if;
   end Run_Process;

   procedure Change (Sig : Ghdl_Signal_Ptr) is
      Link : Group_Link_Acc;
      Fields : Unbounded_String;
      Seen : array (1 .. Max_Signals) of Boolean := (others => False);
   begin
      if not Enabled or not Started or Limit_Reached then return; end if;
      if not Signal_Groups.Contains (Sig) then return; end if;
      Link := Signal_Groups.Element (Sig);
      while Link /= null loop
         if not Seen (Link.Group) then
            if Length (Fields) > 0 then Append (Fields, ","); end if;
            Append (Fields, Q (To_String (Signal_List (Link.Group).Id)) &
              ":" & Q (Signal_Value (Link.Group)));
            Seen (Link.Group) := True;
         end if;
         Link := Link.Next;
      end loop;
      Event ("signal", ",""changes"":{" & To_String (Fields) & "}");
   end Change;

   procedure Boundary (Phase : String) is
   begin
      Phase_Name := To_Unbounded_String (Phase);
      Event ("boundary");
   end Boundary;

   procedure Report (Kind : String; Msg : Std_String_Ptr;
                     Default_Msg : String; Severity : Integer;
                     Loc : Ghdl_Location_Ptr) is
      Message : Unbounded_String := To_Unbounded_String (Default_Msg);
   begin
      if Msg /= null then
         Message := Null_Unbounded_String;
         for I in 1 .. Msg.Bounds.Dim_1.Length loop
            Append (Message, Msg.Base (I - 1));
         end loop;
      end if;
      Event ("assertion", ",""message"":" & Q (To_String (Message)) &
        ",""reportKind"":" & Q (Kind) & ",""severity"":" & N (Severity mod 256) &
        ",""source"":{""file"":" & Q (C (Loc.Filename)) &
        ",""line"":" & N (Integer (Loc.Line)) &
        ",""column"":" & N (Integer (Loc.Col)) & "}");
   end Report;

   procedure Finish is
   begin
      if Enabled then
         Phase_Name := To_Unbounded_String ("finish");
         Event ("finish");
         Put ("{""record"":""end"",""events"":" & N (Seq) & "}");
         Ada.Text_IO.Close (Stream);
         Enabled := False;
      end if;
   end Finish;
end Grt.Chipsim;
