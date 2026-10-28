export type PlaRow = { inputs: string; outputs: string };
export type Pla = { nIn: number; nOut: number; inNames: string[] | null; outNames: string[] | null; rows: PlaRow[] };

export class PlaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlaError';
    this.code = code;
  }
}

export const PLA_MAX_INPUTS = 16;

/**
 * Berkeley PLA. Supports .i .o .ilb .ob .p .type .e. Input cube chars 0/1/-, output chars 0/1.
 * Column 1 is input 0. Minterms not covered by any row read 0. Overlapping rows must agree.
 */
export function parsePla(text: string): Pla {
  let nIn = -1;
  let nOut = -1;
  let inNames: string[] | null = null;
  let outNames: string[] | null = null;
  const rows: PlaRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('.')) {
      const [d, ...rest] = line.split(/\s+/);
      if (d === '.i') nIn = parseInt(rest[0] ?? '', 10);
      else if (d === '.o') nOut = parseInt(rest[0] ?? '', 10);
      else if (d === '.ilb') inNames = rest;
      else if (d === '.ob') outNames = rest;
      else if (d === '.e' || d === '.end') break;
      else if (d === '.p' || d === '.type' || d === '.phase') continue;
      else throw new PlaError('pla-syntax', `line ${ln + 1}: unsupported directive ${d}`);
      continue;
    }
    if (nIn < 0 || nOut < 0) throw new PlaError('pla-syntax', `line ${ln + 1}: .i and .o must precede data rows`);
    const flat = line.replace(/\s+/g, '');
    if (flat.length !== nIn + nOut) throw new PlaError('pla-syntax', `line ${ln + 1}: expected ${nIn}+${nOut} columns`);
    const inputs = flat.slice(0, nIn);
    const outputs = flat.slice(nIn);
    if (!/^[01\-]*$/.test(inputs)) throw new PlaError('pla-syntax', `line ${ln + 1}: bad input cube`);
    if (!/^[01~\-4]*$/.test(outputs)) throw new PlaError('pla-syntax', `line ${ln + 1}: bad output part`);
    rows.push({ inputs, outputs: outputs.replace(/[~\-4]/g, '0') });
  }
  if (nIn < 0 || nOut < 0) throw new PlaError('pla-syntax', 'missing .i/.o');
  if (!Number.isInteger(nIn) || !Number.isInteger(nOut) || nOut < 1) throw new PlaError('pla-syntax', 'bad .i/.o');
  if (nIn > PLA_MAX_INPUTS) throw new PlaError('pla-too-large', `at most ${PLA_MAX_INPUTS} inputs are supported`);
  if (inNames && inNames.length !== nIn) inNames = null;
  if (outNames && outNames.length !== nOut) outNames = null;
  const pla: Pla = { nIn, nOut, inNames, outNames, rows };
  plaTruthTable(pla); // throws pla-conflict
  return pla;
}

/** Truth table, one Uint8Array(2^nIn) per output. Minterm m has input i = bit i of m. Throws `pla-conflict`. */
export function plaTruthTable(pla: Pla): Uint8Array[] {
  const size = 1 << pla.nIn;
  const val = Array.from({ length: pla.nOut }, () => new Int8Array(size).fill(-1));
  for (const row of pla.rows) {
    let care = 0;
    let bits = 0;
    for (let i = 0; i < pla.nIn; i++) {
      const c = row.inputs[i];
      if (c === '1') { care |= 1 << i; bits |= 1 << i; }
      else if (c === '0') care |= 1 << i;
    }
    const dc = (size - 1) & ~care;
    for (let sub = dc; ; sub = (sub - 1) & dc) {
      const m = bits | sub;
      for (let o = 0; o < pla.nOut; o++) {
        const v = row.outputs[o] === '1' ? 1 : 0;
        const cur = val[o]![m]!;
        if (cur === -1) val[o]![m] = v;
        else if (cur !== v) throw new PlaError('pla-conflict', `rows overlap with contradictory output ${o} at minterm ${m}`);
      }
      if (sub === 0) break;
    }
  }
  return val.map((a) => Uint8Array.from(a, (x) => (x === 1 ? 1 : 0)));
}

/** Sum-of-products Verilog: input port `x`, output port `y` (bit i / bit o). */
export function plaToVerilog(pla: Pla, top = 'tt'): string {
  const outs: string[] = [];
  for (let o = 0; o < pla.nOut; o++) {
    const terms: string[] = [];
    for (const row of pla.rows) {
      if (row.outputs[o] !== '1') continue;
      const lits: string[] = [];
      for (let i = 0; i < pla.nIn; i++) {
        if (row.inputs[i] === '1') lits.push(`x[${i}]`);
        else if (row.inputs[i] === '0') lits.push(`~x[${i}]`);
      }
      terms.push(lits.length ? `(${lits.join(' & ')})` : `1'b1`);
    }
    outs.push(`  assign y[${o}] = ${terms.length ? terms.join(' | ') : `1'b0`};`);
  }
  const inPort = pla.nIn > 0 ? `input [${pla.nIn - 1}:0] x, ` : '';
  return `module ${top}(${inPort}output [${pla.nOut - 1}:0] y);\n${outs.join('\n')}\nendmodule\n`;
}
