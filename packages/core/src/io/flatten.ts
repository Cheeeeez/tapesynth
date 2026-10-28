import { decodeNetlist } from '../tap02/codec.js';
import { NetlistError, type Element, type FlatElement } from '../tap02/types.js';
import { placeOutputsIfNeeded } from '../place.js';
import type { Hex } from '../hex.js';

export type FetchedCircuit = { netlist: Uint8Array; nIn: number; nOut: number };
export type FetchCircuit = (cpu: Hex, id: bigint) => Promise<FetchedCircuit | undefined>;
export type FlattenOptions = { maxDepth?: number; maxGates?: number };

export type FlatBody = {
  /** REF-free body; state layout identical to the REF form (TAP-02 §4). */
  body: FlatElement[];
  /** output signals in body numbering */
  outs: number[];
  nIn: number;
};

/**
 * Inline every REF. Element order (and therefore LATCH/state order) follows the original; a REF is
 * replaced in place by its (recursively inlined) sub-circuit. Gate count equals the on-chain
 * `circuitInfo.gateCount`. Outputs are reported as signals in `outs`; call `finalizeFlat` to make
 * them the trailing signals.
 */
export async function flattenBody(
  els: readonly Element[],
  nIn: number,
  nOut: number,
  fetch: FetchCircuit,
  opts: FlattenOptions = {},
): Promise<FlatBody> {
  const maxDepth = opts.maxDepth ?? 16;
  const maxGates = opts.maxGates ?? 1_000_000;
  const base = 2 + nIn;
  const out: FlatElement[] = [];
  const cache = new Map<string, FetchedCircuit & { els: Element[] }>();

  async function inline(list: readonly Element[], cNIn: number, cNOut: number, ins: number[], depth: number): Promise<number[]> {
    if (depth > maxDepth) throw new NetlistError('size-overflow', `REF nesting deeper than ${maxDepth}`);
    const sig: number[] = [0, 1, ...ins];
    const pending: { idx: number; local: number }[] = [];
    for (const e of list) {
      if (e.op === 'NAND') {
        if (e.a >= sig.length || e.b >= sig.length) throw new NetlistError('nand-future', `NAND references unavailable signal`);
        sig.push(base + out.length);
        out.push({ op: 'NAND', a: sig[e.a]!, b: sig[e.b]! });
      } else if (e.op === 'LATCH') {
        pending.push({ idx: out.length, local: e.d });
        sig.push(base + out.length);
        out.push({ op: 'LATCH', d: -1 });
      } else {
        if (e.ins.some((s) => s >= sig.length)) throw new NetlistError('ref-future', 'REF references unavailable signal');
        const key = `${e.cpu.toLowerCase()}:${e.id}`;
        let sub = cache.get(key);
        if (!sub) {
          const f = await fetch(e.cpu, e.id);
          if (!f) throw new NetlistError('ref-unresolved', `REF target ${key} not found`);
          sub = { ...f, els: decodeNetlist(f.netlist) };
          cache.set(key, sub);
        }
        if (sub.nIn !== e.ins.length || sub.nOut !== e.nOuts)
          throw new NetlistError('ref-pin-mismatch', 'REF arity does not match the target circuit');
        const outsub = await inline(sub.els, sub.nIn, sub.nOut, e.ins.map((s) => sig[s]!), depth + 1);
        sig.push(...outsub);
      }
      if (out.length > maxGates) throw new NetlistError('size-overflow', `more than ${maxGates} gates after flattening`);
    }
    for (const p of pending) {
      if (p.local >= sig.length) throw new NetlistError('latch-out-of-range', `LATCH d=${p.local} out of range`);
      (out[p.idx] as { d: number }).d = sig[p.local]!;
    }
    if (sig.length - 2 - cNIn < cNOut) throw new NetlistError('too-few-signals', 'too few signals for outputs');
    return sig.slice(sig.length - cNOut);
  }

  const outs = await inline(els, nIn, nOut, Array.from({ length: nIn }, (_, i) => 2 + i), 0);
  return { body: out, outs, nIn };
}

/** Make the outputs the trailing signals; a no-op (no extra gates) when they already are. */
export function finalizeFlat(f: FlatBody): FlatElement[] {
  return placeOutputsIfNeeded(f.body, f.outs, f.nIn);
}

export async function flatten(
  els: readonly Element[],
  nIn: number,
  nOut: number,
  fetch: FetchCircuit,
  opts?: FlattenOptions,
): Promise<FlatElement[]> {
  return finalizeFlat(await flattenBody(els, nIn, nOut, fetch, opts));
}
