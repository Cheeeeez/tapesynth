import { ConvertError, type Pins, type YosysJson } from '@tapesynth/core';
import { SynthError } from './yosys.js';

export type Sim = {
  nIn: number;
  nOut: number;
  nState: number;
  step(state: Uint32Array, inputs: Uint32Array): { newState: Uint32Array; outputs: Uint32Array };
};

type Bit = number | string;
const OPS = new Set(['$_NOT_', '$_BUF_', '$_AND_', '$_NAND_', '$_OR_', '$_NOR_', '$_XOR_', '$_XNOR_', '$_ANDNOT_', '$_ORNOT_', '$_MUX_', '$_NMUX_', '$_DFF_P_']);

/**
 * Independent bit-sliced (32 lanes) simulator of a gate-level Yosys JSON. Used as the reference
 * for pre-ABC designs. `pins` fixes the input/output order so it matches the generated netlist.
 */
export function buildRefSim(json: YosysJson, top: string, pins: Pins): Sim {
  const mod = json.modules[top];
  if (!mod) throw new SynthError('ref-no-module', `module ${top} missing in reference`);
  const slot = new Map<Bit, number>();
  let nSlots = 2; // 0 = const0, 1 = const1
  const slotOf = (b: Bit): number => {
    if (b === '0' || b === 'x') return 0;
    if (b === '1') return 1;
    if (b === 'z') throw new ConvertError('high-impedance', 'z in reference');
    let s = slot.get(b);
    if (s === undefined) {
      s = nSlots++;
      slot.set(b, s);
    }
    return s;
  };

  const inSlots = pins.inputs.map((p) => slotOf(mod.ports[p.port]!.bits[p.bit]!));
  const outSlots = pins.outputs.map((p) => slotOf(mod.ports[p.port]!.bits[p.bit]!));

  type Op = { t: string; y: number; a: number; b: number; s: number };
  const comb: Op[] = [];
  const dffs: { q: number; d: number }[] = [];
  const driver = new Map<number, Op>();
  for (const c of Object.values(mod.cells ?? {})) {
    if (!OPS.has(c.type)) throw new SynthError('unsupported-cell-in-reference', `unsupported cell in reference: ${c.type}`);
    const k = c.connections;
    if (c.type === '$_DFF_P_') {
      dffs.push({ q: slotOf(k.Q![0]!), d: slotOf(k.D![0]!) });
      continue;
    }
    const op: Op = { t: c.type, y: slotOf(k.Y![0]!), a: k.A ? slotOf(k.A[0]!) : 0, b: k.B ? slotOf(k.B[0]!) : 0, s: k.S ? slotOf(k.S[0]!) : 0 };
    driver.set(op.y, op);
  }
  // Topological order (iterative DFS).
  const done = new Set<Op>();
  const visiting = new Set<Op>();
  const deps = (o: Op) => (o.t === '$_MUX_' || o.t === '$_NMUX_' ? [o.a, o.b, o.s] : o.t === '$_NOT_' || o.t === '$_BUF_' ? [o.a] : [o.a, o.b]);
  const emit = (root: number) => {
    const first = driver.get(root);
    if (!first || done.has(first)) return;
    const stack: { op: Op; i: number }[] = [{ op: first, i: 0 }];
    visiting.add(first);
    while (stack.length) {
      const f = stack[stack.length - 1]!;
      const ds = deps(f.op);
      if (f.i < ds.length) {
        const dep = driver.get(ds[f.i++]!);
        if (dep && !done.has(dep)) {
          if (visiting.has(dep)) throw new SynthError('ref-loop', 'combinational loop in reference');
          visiting.add(dep);
          stack.push({ op: dep, i: 0 });
        }
      } else {
        stack.pop();
        visiting.delete(f.op);
        done.add(f.op);
        comb.push(f.op);
      }
    }
  };
  for (const s of outSlots) emit(s);
  for (const d of dffs) emit(d.d);

  const nState = dffs.length;
  const nOut = outSlots.length;
  const v = new Uint32Array(nSlots);
  return {
    nIn: inSlots.length,
    nOut,
    nState,
    step(state, inputs) {
      v.fill(0);
      v[1] = 0xffffffff;
      for (let i = 0; i < inSlots.length; i++) v[inSlots[i]!] = inputs[i] ?? 0;
      for (let i = 0; i < nState; i++) v[dffs[i]!.q] = state[i] ?? 0;
      for (const o of comb) {
        const A = v[o.a]!;
        const B = v[o.b]!;
        let r: number;
        switch (o.t) {
          case '$_NOT_': r = ~A; break;
          case '$_BUF_': r = A; break;
          case '$_AND_': r = A & B; break;
          case '$_NAND_': r = ~(A & B); break;
          case '$_OR_': r = A | B; break;
          case '$_NOR_': r = ~(A | B); break;
          case '$_XOR_': r = A ^ B; break;
          case '$_XNOR_': r = ~(A ^ B); break;
          case '$_ANDNOT_': r = A & ~B; break;
          case '$_ORNOT_': r = A | ~B; break;
          case '$_MUX_': { const S = v[o.s]!; r = (S & B) | (~S & A); break; }
          default: { const S = v[o.s]!; r = ~((S & B) | (~S & A)); break; } // $_NMUX_
        }
        v[o.y] = r >>> 0;
      }
      const outputs = new Uint32Array(nOut);
      for (let i = 0; i < nOut; i++) outputs[i] = v[outSlots[i]!]!;
      const newState = new Uint32Array(nState);
      for (let i = 0; i < nState; i++) newState[i] = v[dffs[i]!.d]!;
      return { newState, outputs };
    },
  };
}
