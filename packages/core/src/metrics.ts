import { NetlistError, type Element } from './tap02/types.js';
import { validate } from './tap02/validate.js';

export type Metrics = {
  nand: number;
  latch: number;
  /** NAND + LATCH */
  gateCount: number;
  nState: number;
  /** NAND count on the longest combinational path */
  depth: number;
  /** gateCount + 6 * latch */
  area: number;
  /** area * max(depth,1)^3 (a JS number; exact below 2^53) */
  cost: number;
  /** encoded netlist size in bytes */
  bytes: number;
};

/** PoD metrics (see tapeout.net/pod). Flat netlists only. */
export function metrics(els: readonly Element[], nIn: number, nOut: number): Metrics {
  for (const e of els) if (e.op === 'REF') throw new NetlistError('ref-not-flattened', 'netlist contains REF; flatten it first');
  const { S } = validate(els, nIn, nOut);
  const base = 2 + nIn;
  const dep = new Int32Array(S);
  let nand = 0;
  let latch = 0;
  for (let i = 0; i < els.length; i++) {
    const e = els[i]!;
    if (e.op === 'NAND') {
      nand++;
      dep[base + i] = 1 + Math.max(dep[e.a]!, dep[e.b]!);
    } else if (e.op === 'LATCH') {
      latch++;
    }
  }
  let depth = 0;
  for (let o = S - nOut; o < S; o++) depth = Math.max(depth, dep[o]!);
  for (const e of els) if (e.op === 'LATCH') depth = Math.max(depth, dep[e.d]!);
  const gateCount = nand + latch;
  const area = gateCount + 6 * latch;
  const cost = area * Math.max(depth, 1) ** 3;
  return { nand, latch, gateCount, nState: latch, depth, area, cost, bytes: 7 * nand + 4 * latch };
}

/** q = clamp(Cref / C, 1/4, 4). */
export const podQuality = (cost: number, cref: number): number => Math.min(4, Math.max(0.25, cref / cost));
