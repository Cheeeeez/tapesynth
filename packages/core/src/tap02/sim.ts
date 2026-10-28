import { NetlistError, type Element } from './types.js';
import { validate } from './validate.js';

export type Compiled = {
  nIn: number;
  nOut: number;
  nState: number;
  /** total signals (2 + nIn + elements) */
  S: number;
  /** per element: 0 = NAND, 1 = LATCH */
  kind: Uint8Array;
  x: Uint32Array; // NAND a | LATCH d
  y: Uint32Array; // NAND b
  /** for LATCH elements: state index */
  stateIdx: Uint32Array;
};

/** Compile a flat (REF-free) netlist for simulation. Throws `ref-not-flattened` on REF. */
export function compile(els: readonly Element[], nIn: number, nOut: number): Compiled {
  for (const e of els) if (e.op === 'REF') throw new NetlistError('ref-not-flattened', 'netlist contains REF; flatten it first');
  const { S, nState } = validate(els, nIn, nOut);
  const n = els.length;
  const kind = new Uint8Array(n);
  const x = new Uint32Array(n);
  const y = new Uint32Array(n);
  const stateIdx = new Uint32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const e = els[i]!;
    if (e.op === 'NAND') {
      x[i] = e.a;
      y[i] = e.b;
    } else if (e.op === 'LATCH') {
      kind[i] = 1;
      x[i] = e.d;
      stateIdx[i] = k++;
    }
  }
  return { nIn, nOut, nState, S, kind, x, y, stateIdx };
}

/** One beat on bit vectors (values 0/1). */
export function step(c: Compiled, state: ArrayLike<number>, inputs: ArrayLike<number>): { newState: Uint8Array; outputs: Uint8Array } {
  const a = new Uint8Array(c.S);
  a[1] = 1;
  for (let i = 0; i < c.nIn; i++) a[2 + i] = inputs[i] ? 1 : 0;
  const n = c.kind.length;
  const base = 2 + c.nIn;
  for (let i = 0; i < n; i++) {
    a[base + i] = c.kind[i] === 0 ? 1 - (a[c.x[i]!]! & a[c.y[i]!]!) : state[c.stateIdx[i]!] ? 1 : 0;
  }
  const newState = new Uint8Array(c.nState);
  for (let i = 0; i < n; i++) if (c.kind[i] === 1) newState[c.stateIdx[i]!] = a[c.x[i]!]!;
  return { newState, outputs: a.slice(c.S - c.nOut) };
}

/**
 * Bit-sliced beat: each signal is a uint32 holding 32 independent lanes.
 * `scratch` (length >= S) may be supplied to avoid allocation in hot loops.
 */
export function stepBatch(
  c: Compiled,
  stateWords: Uint32Array,
  inputWords: Uint32Array,
  scratch?: Uint32Array,
): { newState: Uint32Array; outputs: Uint32Array } {
  const a = scratch && scratch.length >= c.S ? scratch : new Uint32Array(c.S);
  a[0] = 0;
  a[1] = 0xffffffff;
  for (let i = 0; i < c.nIn; i++) a[2 + i] = inputWords[i] ?? 0;
  const n = c.kind.length;
  const base = 2 + c.nIn;
  for (let i = 0; i < n; i++) {
    a[base + i] = c.kind[i] === 0 ? ~(a[c.x[i]!]! & a[c.y[i]!]!) >>> 0 : (stateWords[c.stateIdx[i]!] ?? 0);
  }
  const newState = new Uint32Array(c.nState);
  for (let i = 0; i < n; i++) if (c.kind[i] === 1) newState[c.stateIdx[i]!] = a[c.x[i]!]!;
  const outputs = new Uint32Array(c.nOut);
  for (let o = 0; o < c.nOut; o++) outputs[o] = a[c.S - c.nOut + o]!;
  return { newState, outputs };
}
