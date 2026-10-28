// 8-bit population count: the classic PoD (proof-of-design) benchmark shape.
module popcount8(input [7:0] x, output [3:0] count);
  assign count = x[0] + x[1] + x[2] + x[3] + x[4] + x[5] + x[6] + x[7];
endmodule
