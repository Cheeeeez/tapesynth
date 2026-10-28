// 4-bit counter with enable. `clk` is the beat; q changes one beat after `en`.
module counter4(input clk, input en, output [3:0] q);
  reg [3:0] q_r = 4'd0;
  always @(posedge clk) if (en) q_r <= q_r + 4'd1;
  assign q = q_r;
endmodule
