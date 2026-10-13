// Minimal test SoC: PicoRV32, 4 KiB byte memory and two memory-mapped words.
// The simulation ROM image comes from the separate firmware task.
module soc(input clk, resetn, output trap, output reg [31:0] word0, word1);
  wire valid, instr;
  wire [31:0] addr, wdata;
  wire [3:0] wstrb;
  wire [31:0] rdata;
  reg [7:0] memory [0:4095];
  integer i;
  initial begin
    for (i=0;i<4096;i=i+1) memory[i]=0;
    $readmemh("firmware.hex", memory);
  end
  assign rdata = addr == 32'h10000000 ? word0 : addr == 32'h10000004 ? word1 :
    addr < 4096 ? {memory[{addr[11:2],2'b00}+3],memory[{addr[11:2],2'b00}+2],memory[{addr[11:2],2'b00}+1],memory[{addr[11:2],2'b00}]} : 0;
  picorv32 #(.PROGADDR_RESET(0), .STACKADDR(4096)) cpu (
    .clk(clk), .resetn(resetn), .trap(trap), .mem_valid(valid), .mem_instr(instr),
    .mem_ready(valid), .mem_addr(addr), .mem_wdata(wdata), .mem_wstrb(wstrb), .mem_rdata(rdata),
    .pcpi_wr(1'b0), .pcpi_rd(32'b0), .pcpi_wait(1'b0), .pcpi_ready(1'b0), .irq(32'b0)
  );
  always @(posedge clk) begin
    if (!resetn) begin word0 <= 0; word1 <= 0; end
    else if (valid && |wstrb) begin
      if (addr == 32'h10000000) word0 <= wdata;
      else if (addr == 32'h10000004) word1 <= wdata;
      else if (addr < 4096) begin
        if (wstrb[0]) memory[{addr[11:2],2'b00}] <= wdata[7:0];
        if (wstrb[1]) memory[{addr[11:2],2'b00}+1] <= wdata[15:8];
        if (wstrb[2]) memory[{addr[11:2],2'b00}+2] <= wdata[23:16];
        if (wstrb[3]) memory[{addr[11:2],2'b00}+3] <= wdata[31:24];
      end
    end
  end
endmodule
