import { describe, expect, it } from 'vitest';
import {
  ConvertError, NetlistError, compile, fromYosysJson, metrics, netlistToVerilog, parsePla, peephole, placeOutputs,
  plaToVerilog, plaTruthTable, step, stepBatch,
  type Compiled, type FlatElement, type YosysJson,
} from '../src/index.js';

/** Deterministic PRNG. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Compare outputs of two compiled circuits over random sequences from the zero state. */
function sameBehaviour(a: Compiled, b: Compiled, seed: number, beats = 12): boolean {
  const r = rng(seed);
  let sa = new Uint32Array(a.nState);
  let sb = new Uint32Array(b.nState);
  for (let t = 0; t < beats; t++) {
    const inp = new Uint32Array(a.nIn).map(() => (r() * 0x100000000) >>> 0);
    const ra = stepBatch(a, sa, inp);
    const rb = stepBatch(b, sb, inp);
    for (let o = 0; o < a.nOut; o++) if (ra.outputs[o] !== rb.outputs[o]) return false;
    sa = ra.newState;
    sb = rb.newState;
  }
  return true;
}

/** Evaluate every signal of a flat body for given input bits (combinational bodies only; latch outs = 0). */
function evalBody(body: FlatElement[], nIn: number, inputs: number[]): number[] {
  const a = [0, 1, ...inputs];
  for (const e of body) a.push(e.op === 'NAND' ? 1 - (a[e.a]! & a[e.b]!) : 0);
  return a;
}

describe('placeOutputs', () => {
  const check = (body: FlatElement[], outs: number[], nIn: number, expectLen: number) => {
    const res = placeOutputs(body, outs, nIn);
    expect(res.length).toBe(expectLen);
    const c = compile(res, nIn, outs.length);
    for (let m = 0; m < 1 << nIn; m++) {
      const inputs = Array.from({ length: nIn }, (_, i) => (m >> i) & 1);
      const want = evalBody(body, nIn, inputs);
      expect(Array.from(step(c, [], inputs).outputs)).toEqual(outs.map((s) => want[s]));
    }
    return res;
  };
  it('(a) fanout-free NAND driver is moved, no extra gate', () => {
    check([{ op: 'NAND', a: 2, b: 3 }, { op: 'NAND', a: 4, b: 4 }], [5], 2, 2);
  });
  it('(a) outputs in a different order than the body', () => {
    const res = check([{ op: 'NAND', a: 2, b: 3 }, { op: 'NAND', a: 2, b: 2 }], [5, 4], 2, 2);
    expect(res[0]).toEqual({ op: 'NAND', a: 2, b: 2 });
  });
  it('(b) NAND with internal fanout is copied; duplicated output is copied too', () => {
    check([{ op: 'NAND', a: 2, b: 3 }, { op: 'NAND', a: 4, b: 4 }], [4, 5], 2, 2); // n0 feeds only a later output: moved
    check([{ op: 'NAND', a: 2, b: 3 }, { op: 'NAND', a: 4, b: 4 }], [4], 2, 3); // n0 feeds a non-output gate: copied
    check([{ op: 'NAND', a: 2, b: 3 }, { op: 'NAND', a: 4, b: 4 }], [5, 4], 2, 3); // user would precede its operand: copied
    check([{ op: 'NAND', a: 2, b: 3 }], [4, 4], 2, 2);
  });
  it('(c) constants', () => {
    const res = check([], [0, 1], 1, 2);
    expect(res).toEqual([{ op: 'NAND', a: 1, b: 1 }, { op: 'NAND', a: 0, b: 0 }]);
  });
  it('(d) input and LATCH output drivers reuse an existing NOT or add one', () => {
    check([], [2], 1, 2);
    check([{ op: 'NAND', a: 2, b: 2 }], [2], 1, 2); // reuses NAND(2,2)
    // LATCH read by an internal NAND that is not an output: cannot be moved, so it is wrapped
    const r = placeOutputs([{ op: 'LATCH', d: 2 }, { op: 'NAND', a: 3, b: 2 }, { op: 'NAND', a: 3, b: 4 }], [3], 1);
    expect(r.length).toBe(5);
    expect(r[3]).toEqual({ op: 'NAND', a: 3, b: 3 });
    expect(r[4]).toEqual({ op: 'NAND', a: 6, b: 6 });
  });
  it('(a) a LATCH output with no NAND users moves into the block; users later in the block are fine', () => {
    expect(placeOutputs([{ op: 'LATCH', d: 2 }], [3], 1)).toEqual([{ op: 'LATCH', d: 2 }]);
    // outs [L, N(L,x)]: N is a later output driver, so L can move too
    const res = placeOutputs([{ op: 'NAND', a: 2, b: 2 }, { op: 'LATCH', d: 3 }, { op: 'NAND', a: 4, b: 2 }], [4, 5], 1);
    expect(res).toEqual([{ op: 'NAND', a: 2, b: 2 }, { op: 'LATCH', d: 3 }, { op: 'NAND', a: 4, b: 2 }]);
  });
  it('preserves LATCH relative order and handles forward LATCH d', () => {
    const body: FlatElement[] = [{ op: 'LATCH', d: 5 }, { op: 'NAND', a: 2, b: 3 }, { op: 'LATCH', d: 4 }, { op: 'NAND', a: 4, b: 5 }];
    const res = placeOutputs(body, [6], 1);
    expect(res.filter((e) => e.op === 'LATCH')).toEqual([{ op: 'LATCH', d: 5 }, { op: 'LATCH', d: 4 }]);
    compile(res, 1, 1);
  });
});

describe('fromYosysJson', () => {
  const port = (direction: string, bits: (number | string)[]) => ({ direction, bits });
  const cell = (type: string, connections: Record<string, (number | string)[]>) => ({ type, connections });

  it('combinational: port order b,a (declaration order), NOT, BUF', () => {
    const json: YosysJson = {
      modules: {
        m: {
          ports: { b: port('input', [2]), a: port('input', [3]), y: port('output', [5]) },
          cells: {
            c1: cell('$_NAND_', { A: [3], B: [2], Y: [4] }),
            c2: cell('$_NOT_', { A: [4], Y: [6] }),
            c3: cell('$_BUF_', { A: [6], Y: [5] }),
          },
        },
      },
    };
    const r = fromYosysJson(json, { top: 'm' });
    expect(r.pins.inputs).toEqual([{ port: 'b', bit: 0 }, { port: 'a', bit: 0 }]);
    expect(r.pins.outputs).toEqual([{ port: 'y', bit: 0 }]);
    expect(r.elements).toEqual([{ op: 'NAND', a: 3, b: 2 }, { op: 'NAND', a: 4, b: 4 }]);
    const c = compile(r.elements, r.nIn, r.nOut);
    for (let m = 0; m < 4; m++) expect(step(c, [], [m & 1, (m >> 1) & 1]).outputs[0]).toBe((m & 1) & ((m >> 1) & 1));
  });

  it('sequential: clock port dropped, DFF -> LATCH, constants and x bits', () => {
    const json: YosysJson = {
      modules: {
        m: {
          ports: { clk: port('input', [2]), en: port('input', [3]), q: port('output', [4, '1', 'x']) },
          cells: {
            n: cell('$_NOT_', { A: [4], Y: [5] }),
            f: cell('$_DFF_P_', { C: [2], D: [5], Q: [4] }),
          },
        },
      },
    };
    const r = fromYosysJson(json, { top: 'm' });
    expect(r.pins.clock).toBe('clk');
    expect(r.nIn).toBe(1);
    expect(r.nOut).toBe(3);
    expect(r.warnings.some((w) => w.startsWith('undefined-bit'))).toBe(true);
    const c = compile(r.elements, r.nIn, r.nOut);
    expect(c.nState).toBe(1);
    let state = new Uint8Array(1);
    const seen: number[][] = [];
    for (let t = 0; t < 4; t++) {
      const s = step(c, state, [0]);
      seen.push(Array.from(s.outputs));
      state = s.newState;
    }
    expect(seen).toEqual([[0, 1, 0], [1, 1, 0], [0, 1, 0], [1, 1, 0]]);
  });

  it('rejects unsupported cells, loops, bad clocking, z', () => {
    const base = (cells: Record<string, ReturnType<typeof cell>>, ports?: Record<string, ReturnType<typeof port>>): YosysJson => ({
      modules: { m: { ports: ports ?? { a: port('input', [2]), y: port('output', [3]) }, cells } },
    });
    const code = (j: YosysJson) => { try { fromYosysJson(j, { top: 'm' }); return 'ok'; } catch (e) { return (e as ConvertError).code; } };
    expect(code(base({ c: cell('$_AND_', { A: [2], B: [2], Y: [3] }) }))).toBe('unsupported-cell:$_AND_');
    expect(code(base({ c: cell('$_NAND_', { A: [3], B: [2], Y: [3] }) }))).toBe('combinational-loop');
    expect(code(base({ c: cell('$_NAND_', { A: [4], B: [2], Y: [3] }) }))).toBe('undriven-bit');
    expect(code(base({ c: cell('$_BUF_', { A: [3], Y: [3] }) }))).toBe('combinational-loop');
    expect(code(base({ f: cell('$_DFF_P_', { C: [2], D: [2], Q: [3] }) }))).toBe('unsupported-clocking');
    expect(code(base({}, { a: port('input', [2]), y: port('output', ['z']) }))).toBe('high-impedance');
  });
});

describe('peephole', () => {
  it('constant propagation, double NOT, hashing, dead logic', () => {
    // x=in0. n1=NOT x; n2=NOT n1 (=x); n3=NAND(x,0)=1; n4=NAND(n3,n3)=0; dup=NAND(2,3)x2; dead=NAND(2,2)
    const els: FlatElement[] = [
      { op: 'NAND', a: 2, b: 2 }, // 4
      { op: 'NAND', a: 4, b: 4 }, // 5 = x
      { op: 'NAND', a: 2, b: 0 }, // 6 = 1
      { op: 'NAND', a: 6, b: 6 }, // 7 = 0
      { op: 'NAND', a: 5, b: 3 }, // 8
      { op: 'NAND', a: 2, b: 3 }, // 9 == 8
      { op: 'NAND', a: 8, b: 9 }, // 10 -> NOT(8)
    ];
    const out = peephole(els, 2, 1);
    expect(out.length).toBe(2);
    expect(sameBehaviourSimple(els, out, 2, 1)).toBe(true);
  });

  it('constant-0 latch disappears and propagates', () => {
    const els: FlatElement[] = [
      { op: 'LATCH', d: 0 }, // 3 (nIn=1) -> always 0
      { op: 'NAND', a: 2, b: 3 }, // 4 -> 1
      { op: 'NAND', a: 4, b: 2 }, // 5 -> NOT x
    ];
    const out = peephole(els, 1, 1);
    expect(out.some((e) => e.op === 'LATCH')).toBe(false);
    expect(out.length).toBe(1);
    expect(sameBehaviourSimple(els, out, 1, 1)).toBe(true);
  });

  it('is idempotent and never changes output order on 200 random netlists', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 7919);
      const nIn = 1 + Math.floor(r() * 4);
      const nEl = 4 + Math.floor(r() * 28);
      const nOut = 1 + Math.floor(r() * Math.min(3, nEl));
      const els: FlatElement[] = [];
      const total = 2 + nIn + nEl;
      for (let i = 0; i < nEl; i++) {
        const cur = 2 + nIn + i;
        if (r() < 0.2) els.push({ op: 'LATCH', d: Math.floor(r() * total) });
        else {
          const pick = () => (r() < 0.1 ? Math.floor(r() * 2) : Math.floor(r() * cur));
          els.push({ op: 'NAND', a: pick(), b: pick() });
        }
      }
      const a = compile(els, nIn, nOut);
      const opt = peephole(els, nIn, nOut);
      const b = compile(opt, nIn, nOut);
      expect(sameBehaviour(a, b, seed), `seed ${seed}`).toBe(true);
      const again = peephole(opt, nIn, nOut);
      expect(metrics(again, nIn, nOut).gateCount, `idempotent seed ${seed}`).toBe(metrics(opt, nIn, nOut).gateCount);
      expect(sameBehaviour(b, compile(again, nIn, nOut), seed + 1000)).toBe(true);
    }
  });
});

function sameBehaviourSimple(a: FlatElement[], b: FlatElement[], nIn: number, nOut: number) {
  return sameBehaviour(compile(a, nIn, nOut), compile(b, nIn, nOut), 42);
}

describe('PLA', () => {
  const xor3 = `.i 3\n.o 1\n.ilb a b c\n.ob p\n100 1\n010 1\n001 1\n111 1\n.e\n`;
  it('parses and tabulates (column 1 = input 0)', () => {
    const p = parsePla(xor3);
    const t = plaTruthTable(p)[0]!;
    for (let m = 0; m < 8; m++) expect(t[m]).toBe(((m & 1) ^ ((m >> 1) & 1) ^ ((m >> 2) & 1)) as 0 | 1);
    expect(plaToVerilog(p)).toContain('module tt(input [2:0] x, output [0:0] y);');
  });
  it('rejects contradicting overlaps, accepts agreeing ones; missing rows read 0', () => {
    expect(() => parsePla('.i 2\n.o 1\n1- 1\n-1 0\n.e\n')).toThrow(/overlap/);
    const p = parsePla('.i 2\n.o 1\n1- 1\n-1 1\n.e\n');
    expect(Array.from(plaTruthTable(p)[0]!)).toEqual([0, 1, 1, 1]);
    expect(() => parsePla('.i 17\n.o 1\n.e\n')).toThrow(/at most 16/);
  });
});

describe('netlistToVerilog', () => {
  it('emits ports, NAND assigns and latches', () => {
    const v = netlistToVerilog([{ op: 'LATCH', d: 4 }, { op: 'NAND', a: 3, b: 2 }], 1, 1, 'top');
    expect(v).toContain('module top(input clk, input [0:0] x, output [0:0] y);');
    expect(v).toContain('always @(posedge clk) q_3 <= s[4];');
    expect(v).toContain('assign s[4] = ~(s[3] & s[2]);');
    expect(() => netlistToVerilog([], 1, 1)).toThrow(NetlistError);
  });
});
