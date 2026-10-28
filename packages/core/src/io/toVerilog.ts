import { NetlistError, type Element } from '../tap02/types.js';
import { validate } from '../tap02/validate.js';

/**
 * Netlist -> structural Verilog. Ports: `clk` (only when stateful), `x[nIn-1:0]`, `y[nOut-1:0]`.
 * LATCHes become `reg` flip-flops initialised to 0.
 */
export function netlistToVerilog(els: readonly Element[], nIn: number, nOut: number, top = 'imported'): string {
  for (const e of els) if (e.op === 'REF') throw new NetlistError('ref-not-flattened', 'netlist contains REF; flatten it first');
  const { S, nState } = validate(els, nIn, nOut);
  const ports: string[] = [];
  if (nState > 0) ports.push('input clk');
  if (nIn > 0) ports.push(`input [${nIn - 1}:0] x`);
  ports.push(`output [${nOut - 1}:0] y`);
  const L: string[] = [];
  L.push(`module ${top}(${ports.join(', ')});`);
  L.push(`  wire [${S - 1}:0] s;`);
  L.push(`  assign s[0] = 1'b0;`);
  L.push(`  assign s[1] = 1'b1;`);
  for (let i = 0; i < nIn; i++) L.push(`  assign s[${2 + i}] = x[${i}];`);
  const base = 2 + nIn;
  els.forEach((e, i) => {
    const k = base + i;
    if (e.op === 'NAND') L.push(`  assign s[${k}] = ~(s[${e.a}] & s[${e.b}]);`);
    else if (e.op === 'LATCH') {
      L.push(`  reg q_${k} = 1'b0;`);
      L.push(`  always @(posedge clk) q_${k} <= s[${(e as { d: number }).d}];`);
      L.push(`  assign s[${k}] = q_${k};`);
    }
  });
  for (let o = 0; o < nOut; o++) L.push(`  assign y[${o}] = s[${S - nOut + o}];`);
  L.push('endmodule', '');
  return L.join('\n');
}
