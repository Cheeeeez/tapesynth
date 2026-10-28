import type { FlatElement } from './tap02/types.js';

/**
 * Arrange a flat body so the requested output signals are the LAST `outs.length` signals, in order
 * (TAP-02 defines outputs as the final nOut signals). Relative order of the surviving body
 * elements (incl. LATCHes) is preserved; a LATCH that is moved into the output block changes the
 * state order only relative to the other latches.
 *
 * `body` signals are numbered 2 + nIn + index; `outs` are signals in that numbering.
 *
 *  (a) driver is a NAND/LATCH whose NAND users are all later output drivers: move it into the
 *      output block (LATCH only when it appears once; a LATCH `d` may point forward)
 *  (b) other NAND driver: append a copy NAND(g.a, g.b) to the output block
 *  (c) const0 -> NAND(1,1); const1 -> NAND(0,0)
 *  (d) input / LATCH output x: reuse or append nx = NAND(x,x) to the body, block gets NAND(nx,nx)
 */
export function placeOutputs(body: readonly FlatElement[], outs: readonly number[], nIn: number): FlatElement[] {
  const base = 2 + nIn;
  const n = body.length;

  // First occurrence position of each element-driver among the outputs.
  const pos = new Map<number, number>();
  const occurrences = new Map<number, number>();
  outs.forEach((s, k) => {
    if (s < base) return;
    if (!pos.has(s)) pos.set(s, k);
    occurrences.set(s, (occurrences.get(s) ?? 0) + 1);
  });
  // Candidates: drivers that could be moved into the block.
  const valid = new Set<number>();
  for (const [s] of pos) if (body[s - base]!.op === 'NAND' || occurrences.get(s) === 1) valid.add(s);
  const users = new Map<number, number[]>(); // candidate -> NAND element signals using it
  for (let i = 0; i < n; i++) {
    const e = body[i]!;
    if (e.op !== 'NAND') continue;
    for (const o of e.a === e.b ? [e.a] : [e.a, e.b]) if (valid.has(o)) (users.get(o) ?? users.set(o, []).get(o)!).push(base + i);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of [...valid]) {
      for (const u of users.get(g) ?? []) {
        if (!(valid.has(u) && pos.get(u)! > pos.get(g)!)) {
          valid.delete(g);
          changed = true;
          break;
        }
      }
    }
  }
  const moved = new Uint8Array(n);
  for (const g of valid) moved[g - base] = 1;

  // Surviving body numbering.
  const newIdx = new Int32Array(n).fill(-1);
  let next = base;
  for (let i = 0; i < n; i++) if (!moved[i]) newIdx[i] = next++;
  const survivors = next - base;

  // Decide appended NOT gates (rule d) before numbering the block.
  const notOf = new Map<number, number>(); // x (old signal) -> new signal of NAND(x,x) among survivors
  for (let i = 0; i < n; i++) {
    const e = body[i]!;
    if (!moved[i] && e.op === 'NAND' && e.a === e.b && !notOf.has(e.a)) notOf.set(e.a, newIdx[i]!);
  }
  const wrapNeeded: number[] = []; // old signals needing a fresh NAND(x,x)
  const blockKinds = outs.map((s) => {
    if (s === 0 || s === 1) return 'const';
    if (s >= base && body[s - base]!.op === 'NAND') return 'nand';
    if (s >= base && moved[s - base]) return 'moved-latch';
    if (!notOf.has(s)) {
      notOf.set(s, base + survivors + wrapNeeded.length);
      wrapNeeded.push(s);
    }
    return 'wrap';
  });
  const blockBase = base + survivors + wrapNeeded.length;
  // New signal of a moved driver = blockBase + its output position.
  const movedIdx = (s: number) => blockBase + pos.get(s)!;
  const mapSig = (s: number): number => {
    if (s < base) return s;
    return moved[s - base] ? movedIdx(s) : newIdx[s - base]!;
  };

  const result: FlatElement[] = [];
  for (let i = 0; i < n; i++) {
    if (moved[i]) continue;
    const e = body[i]!;
    result.push(e.op === 'NAND' ? { op: 'NAND', a: mapSig(e.a), b: mapSig(e.b) } : { op: 'LATCH', d: mapSig(e.d) });
  }
  for (const x of wrapNeeded) result.push({ op: 'NAND', a: mapSig(x), b: mapSig(x) });

  outs.forEach((s, k) => {
    const kind = blockKinds[k]!;
    if (kind === 'const') result.push(s === 0 ? { op: 'NAND', a: 1, b: 1 } : { op: 'NAND', a: 0, b: 0 });
    else if (kind === 'nand') {
      const g = body[s - base] as { op: 'NAND'; a: number; b: number };
      result.push({ op: 'NAND', a: mapSig(g.a), b: mapSig(g.b) });
    } else if (kind === 'moved-latch') {
      result.push({ op: 'LATCH', d: mapSig((body[s - base] as { op: 'LATCH'; d: number }).d) });
    } else {
      const nx = notOf.get(s)!;
      result.push({ op: 'NAND', a: nx, b: nx });
    }
  });
  return result;
}

/** True when `outs` are already the last outs.length signals, in order. */
export function outputsAreTail(bodyLength: number, outs: readonly number[], nIn: number): boolean {
  const total = 2 + nIn + bodyLength;
  return outs.length <= bodyLength && outs.every((s, k) => s === total - outs.length + k);
}

/** placeOutputs, but returns `body` untouched (no extra gates) when the outputs already are the trailing signals. */
export function placeOutputsIfNeeded(body: readonly FlatElement[], outs: readonly number[], nIn: number): FlatElement[] {
  return outputsAreTail(body.length, outs, nIn) ? [...body] : placeOutputs(body, outs, nIn);
}
