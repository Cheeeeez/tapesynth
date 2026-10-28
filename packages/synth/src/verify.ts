import { compile, stepBatch, type Compiled, type FlatElement, type Verification } from '@tapesynth/core';
import { SynthError } from './yosys.js';
import type { Sim } from './refsim.js';

export function simFromNetlist(els: readonly FlatElement[], nIn: number, nOut: number): Sim {
  const c: Compiled = compile(els, nIn, nOut);
  const scratch = new Uint32Array(c.S);
  return { nIn, nOut, nState: c.nState, step: (s, i) => stepBatch(c, s, i, scratch) };
}

function xorshift(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

export type VerifyOpts = {
  reference: Verification['reference'];
  /** seed, usually the first 4 bytes of the source sha256 */
  seed: number;
  /** direct truth table (one Uint8Array(2^nIn) per output, minterm bit i = input i) */
  table?: Uint8Array[];
};

function fail(msg: string): never {
  throw new SynthError('verification-failed', msg);
}

/**
 * Compare `cand` with `ref`: exhaustive for combinational circuits with <= 16 inputs, otherwise
 * 4096 random vectors; sequential circuits get 64 random sequences x 32 beats from the zero state
 * (plus one 256-beat sequence when there are no inputs). Throws SynthError('verification-failed').
 */
export function verifyEquivalent(ref: Sim, cand: Sim, opts: VerifyOpts): Verification {
  if (ref.nIn !== cand.nIn || ref.nOut !== cand.nOut) fail(`pin mismatch ref ${ref.nIn}/${ref.nOut} vs ${cand.nIn}/${cand.nOut}`);
  const { nIn, nOut } = ref;
  const rnd = xorshift(opts.seed);
  const sequential = ref.nState > 0 || cand.nState > 0;

  if (!sequential) {
    const zero = new Uint32Array(0);
    const exhaustive = nIn <= 16;
    const total = exhaustive ? 2 ** nIn : 4096;
    const batches = Math.ceil(total / 32);
    for (let b = 0; b < batches; b++) {
      const inputs = new Uint32Array(nIn);
      let laneMask = 0xffffffff;
      if (exhaustive) {
        for (let l = 0; l < 32; l++) {
          const vec = b * 32 + l;
          if (vec >= total) { laneMask &= ~(1 << l); continue; }
          for (let i = 0; i < nIn; i++) if ((vec >> i) & 1) inputs[i]! |= 1 << l;
        }
      } else for (let i = 0; i < nIn; i++) inputs[i] = rnd();
      laneMask >>>= 0;
      const r = ref.step(zero, inputs).outputs;
      const c = cand.step(zero, inputs).outputs;
      for (let o = 0; o < nOut; o++) {
        const diff = ((r[o]! ^ c[o]!) & laneMask) >>> 0;
        if (diff) fail(`output ${o} differs from the reference at ${describe(diff, inputs)}`);
        if (opts.table) {
          let want = 0;
          const t = opts.table[o]!;
          for (let l = 0; l < 32; l++) if (exhaustive && b * 32 + l < total && t[b * 32 + l]) want |= 1 << l;
          const dd = ((want ^ c[o]!) & laneMask) >>> 0;
          if (dd) fail(`output ${o} differs from the PLA table at ${describe(dd, inputs)}`);
        }
      }
    }
    return { reference: opts.reference, method: exhaustive ? 'exhaustive' : 'random', vectors: total, sequences: 0, beats: 0, passed: true };
  }

  // sequential
  const runSeq = (beats: number, lanes: number) => {
    let sr: Uint32Array = new Uint32Array(ref.nState);
    let sc: Uint32Array = new Uint32Array(cand.nState);
    const laneMask = lanes >= 32 ? 0xffffffff : ((1 << lanes) - 1) >>> 0;
    for (let t = 0; t < beats; t++) {
      const inputs = new Uint32Array(nIn);
      for (let i = 0; i < nIn; i++) inputs[i] = rnd();
      const a = ref.step(sr, inputs);
      const b = cand.step(sc, inputs);
      for (let o = 0; o < nOut; o++) {
        const diff = ((a.outputs[o]! ^ b.outputs[o]!) & laneMask) >>> 0;
        if (diff) fail(`output ${o} differs from the reference at beat ${t} (lane ${31 - Math.clz32(diff)})`);
      }
      sr = a.newState;
      sc = b.newState;
    }
  };
  runSeq(32, 32);
  runSeq(32, 32);
  if (nIn === 0) runSeq(256, 1); // input-free circuits: one long free-running sequence as well
  return { reference: opts.reference, method: 'random', vectors: 64 * 32, sequences: 64, beats: 32, passed: true };
}

function describe(diff: number, inputs: Uint32Array): string {
  const lane = 31 - Math.clz32(diff);
  const bits = Array.from(inputs, (w) => (w >>> lane) & 1).join('');
  return `inputs[0..]=${bits || '(none)'}`;
}
