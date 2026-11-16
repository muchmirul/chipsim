import { readFileSync } from "node:fs";
import { manufacturingMetadata as base } from "./manufacturing.mjs";
const wrapper = (top, body) =>
  `module ${top}(input wire [7:0] ui_in, output wire [7:0] uo_out, input wire [7:0] uio_in, output wire [7:0] uio_out,uio_oe,input wire ena,clk,rst_n); ${body} endmodule`;
const bench = (top, body) => `\`timescale 1ns/1ps
module tb;
reg [7:0] ui_in=0,uio_in=0; reg clk=0,rst_n=0,ena=1; wire [7:0] uo_out,uio_out,uio_oe;
integer i,j,k,f,expected;
${top} dut(.*); always #10 clk=~clk;
task tick; begin @(posedge clk); #2; end endtask
initial begin
$dumpfile("waveform.vcd"); $dumpvars(1,tb); tick(); @(negedge clk); rst_n=1;
${body}
f=$fopen("results.xml","w"); $fwrite(f,"<testsuite><testcase name='public-pin-contract'/></testsuite>"); $fclose(f); $finish;
end
initial begin #1000000; $fatal(1,"watchdog"); end
endmodule`;
export function extraFixture(kind) {
  if (kind === "power") {
    const root = new URL("../../example/power-controller/", import.meta.url);
    const read = (p) => readFileSync(new URL(p, root), "utf8");
    return {
      manufacturingMetadata: JSON.parse(read("metadata.json")),
      cases: JSON.parse(read("acceptance.json")).cases,
      counterRTL: read("src/project.v"),
      counterTestbench: read("test/tb.sv"),
      mutation: ["!request_on && clear_fault", "clear_fault"],
      failurePattern: "Expected latched FAULT",
    };
  }
  const top = "tt_um_chipsim_" + kind;
  const manufacturingMetadata = {
    ...base,
    id: kind,
    title: "ChipSim " + kind,
    top,
    description:
      kind === "fifo"
        ? "Four-entry eight-bit synchronous FIFO; full write rejected, empty read rejected, simultaneous accepted operations preserve occupancy; no empty bypass."
        : "Synchronous 8N1 UART transmitter, four clocks per bit; start while busy ignored and data latched at acceptance.",
    pinout: {
      ui: Array.from({ length: 8 }, (_, i) => "data_" + i),
      uo: Array.from({ length: 8 }, (_, i) =>
        kind === "fifo" ? "head_" + i : ["tx", "busy"][i] || "zero",
      ),
      uio:
        kind === "fifo"
          ? ["push", "pop", "empty", "full", "zero", "zero", "zero", "zero"]
          : [
              "start",
              "unused",
              "unused",
              "unused",
              "unused",
              "unused",
              "unused",
              "unused",
            ],
    },
  };
  if (kind === "fifo")
    return {
      manufacturingMetadata,
      cases: ["public-pin-contract"],
      mutation: ["wr <= wr + 1", "wr <= wr + 2"],
      failurePattern: "FIFO",
      counterRTL: wrapper(
        top,
        `
reg [7:0] mem[0:3]; reg [1:0] rd,wr; reg [2:0] count;
wire pop=ena && uio_in[1] && count!=0;
wire push=ena && uio_in[0] && (count!=4 || pop);
assign uo_out=count==0 ? 0 : mem[rd]; assign uio_out={4'b0,count==4,count==0,2'b0}; assign uio_oe=8'h0c;
always @(posedge clk) if(!rst_n) begin rd<=0;wr<=0;count<=0;end else begin
if(push) begin mem[wr]<=ui_in;wr <= wr + 1;end
if(pop) rd<=rd+1;
case({push,pop}) 2'b10:count<=count+1;2'b01:count<=count-1;default:count<=count;endcase end
`,
      ),
      counterTestbench: bench(
        top,
        `
if(uio_out[3:2]!==1 || uo_out!==0 || uio_oe!==12) $fatal(1,"FIFO reset");
for(k=0;k<3;k=k+1) begin
 for(i=0;i<4;i=i+1) begin @(negedge clk); ui_in=k*16+i;uio_in=1;tick();end
 if(uio_out[3:2]!==2) $fatal(1,"FIFO full");
 @(negedge clk);ui_in=255;tick();
 for(i=0;i<4;i=i+1) begin
  expected=k*16+i;if(uo_out!==expected[7:0]) $fatal(1,"FIFO ordering");
  @(negedge clk);uio_in=2;tick();
 end
 tick();if(uio_out[3:2]!==1) $fatal(1,"FIFO empty read");
end
for(i=0;i<4;i=i+1) begin @(negedge clk);uio_in=1;ui_in=60+i;tick();end
@(negedge clk);uio_in=3;ui_in=99;tick();
if(uio_out[3:2]!==2 || uo_out!==61) $fatal(1,"FIFO full simultaneous");
for(i=0;i<4;i=i+1) begin
 expected=(i==3?99:61+i);if(uo_out!==expected[7:0]) $fatal(1,"FIFO replacement ordering");
 @(negedge clk);uio_in=2;tick();
end
@(negedge clk);uio_in=3;ui_in=42;tick();if(uo_out!==42) $fatal(1,"FIFO empty simultaneous");
@(negedge clk);ui_in=77;tick();if(uo_out!==77 || uio_out[3:2]!==0) $fatal(1,"FIFO simultaneous");
@(negedge clk);ena=0;ui_in=99;tick();if(uo_out!==77) $fatal(1,"FIFO disabled");
@(negedge clk);rst_n=0;tick();if(uio_out[3:2]!==1) $fatal(1,"FIFO active reset");
`,
      ),
    };
  if (kind !== "uart") throw Error("Unknown fixture");
  return {
    manufacturingMetadata,
    cases: ["public-pin-contract"],
    mutation: ["{1'b1,ui_in,1'b0}", "{1'b1,ui_in,1'b1}"],
    failurePattern: "UART",
    counterRTL: wrapper(
      top,
      `
reg [9:0] frame;reg [3:0] bitno;reg [1:0] phase;reg busy;
assign uo_out={6'b0,busy,busy?frame[0]:1'b1};assign uio_out=0;assign uio_oe=0;
always @(posedge clk) if(!rst_n) begin frame<=1023;bitno<=0;phase<=0;busy<=0;end
else if(!busy) begin if(ena && uio_in[0]) begin frame<={1'b1,ui_in,1'b0};bitno<=0;phase<=0;busy<=1;end end
else if(phase==3) begin phase<=0;if(bitno==9) busy<=0;else begin frame<={1'b1,frame[9:1]};bitno<=bitno+1;end end
else phase<=phase+1;
`,
    ),
    counterTestbench: bench(
      top,
      `
if(uo_out!==1 || uio_oe!==0) $fatal(1,"UART idle");
for(k=0;k<4;k=k+1) begin
 @(negedge clk);ui_in=(k==0?0:k==1?255:k==2?85:166);expected=ui_in;uio_in=1;tick();
 for(i=0;i<10;i=i+1) begin
  for(j=0;j<4;j=j+1) begin
   if(uo_out[1]!==1 || uo_out[0] !== (i==0?1'b0:i==9?1'b1:((expected>>(i-1))&1))) $fatal(1,"UART frame");
   @(negedge clk);ui_in=~expected;uio_in=(i==3);tick();
  end
 end
 if(uo_out!==1) $fatal(1,"UART completion");
end
@(negedge clk);ena=0;uio_in=1;tick();if(uo_out!==1) $fatal(1,"UART disabled");
@(negedge clk);ena=1;tick();@(negedge clk);rst_n=0;tick();if(uo_out!==1) $fatal(1,"UART reset");
`,
    ),
  };
}
