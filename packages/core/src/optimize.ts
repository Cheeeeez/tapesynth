import { placeOutputsIfNeeded } from './place.js';
import { NetlistError, type Element, type FlatElement } from './tap02/types.js';

/**
 * Semantics-preserving cleanup (output behaviour from the all-zero state is unchanged):
 * constant propagation, double-NOT removal, structural hashing, dead-logic removal.
 * Output order is untouched; LATCH semantics are untouched (a LATCH is only removed when it is
 * provably constant 0 or unobservable).
 */
export function peephole(els: readonly Element[], nIn: number, nOut: number): FlatElement[] {
  for (const e of els) if (e.op === 'REF') throw new NetlistError('ref-not-flattened', 'netlist contains REF; flatten it first');
  let body = els as readonly FlatElement[];
  let base = 2 + nIn;
  let outs = Array.from({ length: nOut }, (_, k) => base + body.length - nOut + k);

  for (;;) {
    const n = body.length;
    const rep = new Int32Array(base + n);
    for (let i = 0; i < rep.length; i++) rep[i] = i;
    const r = (s: number): number => {
      while (rep[s] !== s) s = rep[s]!;
      return s;
    };
    const gates: ({ a: number; b: number } | undefined)[] = new Array(n);
    const hash = new Map<number, number>(); // key a*2^25... use string-free numeric key
    const keyOf = (a: number, b: number) => Math.min(a, b) * 0x2000000 + Math.max(a, b); // signals < 2^24
    let changed = false;
    const newBody: (FlatElement | null)[] = new Array(n).fill(null);

    for (let i = 0; i < n; i++) {
      const s = base + i;
      const e = body[i]!;
      if (e.op === 'LATCH') {
        newBody[i] = e; // d patched below once all replacements are known
        continue;
      }
      let a = r(e.a);
      let b = r(e.b);
      if (a === 0 || b === 0) { rep[s] = 1; changed = true; continue; }
      if (a === 1 && b === 1) { rep[s] = 0; changed = true; continue; }
      if (a === 1) a = b;
      else if (b === 1) b = a;
      if (a === b) {
        const g = a >= base ? gates[a - base] : undefined;
        if (g && g.a === g.b) { rep[s] = g.a; changed = true; continue; } // NOT(NOT x) = x
      }
      const k = keyOf(a, b);
      const prev = hash.get(k);
      if (prev !== undefined) { rep[s] = prev; changed = true; continue; }
      hash.set(k, s);
      gates[i] = { a, b };
      if (a !== e.a || b !== e.b) changed = true;
      newBody[i] = { op: 'NAND', a, b };
    }
    // Patch LATCH d, detect constant-0 latches (needs another pass to propagate).
    for (let i = 0; i < n; i++) {
      const e = newBody[i];
      if (e && e.op === 'LATCH') {
        const d = r(e.d);
        if (d !== e.d) changed = true;
        if (d === 0) { rep[base + i] = 0; newBody[i] = null; changed = true; continue; }
        newBody[i] = { op: 'LATCH', d };
      }
    }
    // After latch replacement, signals using it were already rewritten with the old id; re-resolve outputs now.
    const newOuts = outs.map((s) => r(s));
    // Liveness.
    const live = new Uint8Array(base + n);
    const work: number[] = [];
    const mark = (s: number) => {
      s = r(s);
      if (s >= base && !live[s]) { live[s] = 1; work.push(s); }
    };
    for (const s of newOuts) mark(s);
    while (work.length) {
      const s = work.pop()!;
      const e = newBody[s - base];
      if (!e) continue;
      if (e.op === 'NAND') { mark(e.a); mark(e.b); } else mark(e.d);
    }
    for (let i = 0; i < n; i++) if (newBody[i] && !live[base + i]) { newBody[i] = null; changed = true; }
    // Compact with remap.
    const idx = new Int32Array(base + n);
    for (let s = 0; s < base; s++) idx[s] = s;
    let next = base;
    for (let i = 0; i < n; i++) if (newBody[i]) idx[base + i] = next++;
    // Signals replaced by something else map through rep.
    const fin = (s: number): number => {
      s = r(s);
      return s < base ? s : idx[s]!;
    };
    const compact: FlatElement[] = [];
    for (let i = 0; i < n; i++) {
      const e = newBody[i];
      if (!e) continue;
      compact.push(e.op === 'NAND' ? { op: 'NAND', a: fin(e.a), b: fin(e.b) } : { op: 'LATCH', d: fin(e.d) });
    }
    const finOuts = newOuts.map(fin);
    if (!changed) {
      return placeOutputsIfNeeded(compact, finOuts, nIn);
    }
    body = compact;
    outs = finOuts;
  }
}
