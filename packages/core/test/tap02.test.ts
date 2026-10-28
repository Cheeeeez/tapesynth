import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  NetlistError, compile, decodeNetlist, encodeNetlist, flatten, hexToBytes, bytesToHex, metrics,
  pack, podQuality, step, stepBatch, unpack, validate,
  type Element, type Hex, type RefInfo,
} from '../src/index.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/tap02-vectors.json', import.meta.url), 'utf8'));

type Ref = { cpu: string; id: number; nIn: number; nOut: number; netlist: string };
const key = (cpu: string, id: bigint | number) => `${cpu.toLowerCase()}:${id}`;

function refInfoFor(refs: Ref[]) {
  const m = new Map<string, RefInfo>();
  for (const r of refs) {
    const { nState, gateCount } = validate(decodeNetlist(hexToBytes(r.netlist)), r.nIn, r.nOut);
    m.set(key(r.cpu, r.id), { nIn: r.nIn, nOut: r.nOut, nState, gateCount });
  }
  return (cpu: Hex, id: bigint) => m.get(key(cpu, id));
}
const fetchFor = (refs: Ref[]) => async (cpu: Hex, id: bigint) => {
  const r = refs.find((x) => key(x.cpu, x.id) === key(cpu, id));
  return r && { netlist: hexToBytes(r.netlist), nIn: r.nIn, nOut: r.nOut };
};

describe('TAP-02 vectors: valid', () => {
  for (const v of V.valid) {
    it(v.name, async () => {
      const els = decodeNetlist(hexToBytes(v.netlist));
      expect(bytesToHex(encodeNetlist(els))).toBe(v.netlist);
      const info = validate(els, v.nIn, v.nOut, refInfoFor(v.refs));
      expect(info.nState).toBe(v.nState);
      const flat = await flatten(els, v.nIn, v.nOut, fetchFor(v.refs));
      const c = compile(flat, v.nIn, v.nOut);
      expect(c.nState).toBe(v.nState);
      for (const row of v.truthTable ?? []) {
        const r = step(c, new Uint8Array(c.nState), unpack(hexToBytes(row.inputs), v.nIn));
        expect(bytesToHex(pack(r.outputs))).toBe(`0x${row.outputs}`);
      }
      for (const b of v.beats ?? []) {
        const r = step(c, unpack(hexToBytes(b.state), v.nState), unpack(hexToBytes(b.inputs), v.nIn));
        expect(bytesToHex(pack(r.newState))).toBe(`0x${b.newState}`);
        expect(bytesToHex(pack(r.outputs))).toBe(`0x${b.outputs}`);
      }
    });
  }
});

describe('TAP-02 vectors: ill-formed', () => {
  const expected: Record<string, string> = {
    unknown_opcode: 'bad-opcode',
    truncated_record: 'truncated',
    nand_forward_reference: 'nand-future',
    nOut_zero: 'no-outputs',
    output_is_an_input: 'too-few-signals',
    more_outputs_than_elements: 'too-few-signals',
    ref_arity_mismatch: 'ref-pin-mismatch',
    ref_target_not_registered: 'ref-unresolved',
  };
  for (const v of V.illFormed) {
    it(v.name, () => {
      let code = '';
      try {
        validate(decodeNetlist(hexToBytes(v.netlist)), v.nIn, v.nOut, refInfoFor(v.refs));
      } catch (e) {
        expect(e).toBeInstanceOf(NetlistError);
        code = (e as NetlistError).code;
      }
      expect(code).toBe(expected[v.name]);
    });
  }
});

describe('TAP-02 packing', () => {
  it('lenient unpack on the nand circuit', () => {
    const nand = V.valid.find((v: any) => v.name === 'nand');
    const c = compile(decodeNetlist(hexToBytes(nand.netlist)), 2, 1);
    for (const k of V.packingEdgeCases.cases) {
      const r = step(c, new Uint8Array(0), unpack(hexToBytes(k.inputs), 2));
      expect(bytesToHex(pack(r.outputs)), k.case).toBe(`0x${k.outputs}`);
    }
  });
});

describe('stepBatch', () => {
  it('matches step lane by lane on the 55-gate popcount', () => {
    const v = V.valid.find((x: any) => x.name === 'popcount8_3151');
    const c = compile(decodeNetlist(hexToBytes(v.netlist)), 8, 4);
    const inWords = new Uint32Array(8);
    for (let lane = 0; lane < 32; lane++) for (let i = 0; i < 8; i++) if (((lane * 7 + 3) >> i) & 1) inWords[i]! |= 1 << lane;
    const r = stepBatch(c, new Uint32Array(0), inWords);
    for (let lane = 0; lane < 32; lane++) {
      const bits = Array.from({ length: 8 }, (_, i) => (inWords[i]! >>> lane) & 1);
      const s = step(c, [], bits);
      for (let o = 0; o < 4; o++) expect((r.outputs[o]! >>> lane) & 1).toBe(s.outputs[o]);
    }
  });
});

describe('metrics', () => {
  it('PoD formula: 4 NAND + 1 LATCH, depth 3 -> area 11, C = 297 (cf. pod task 74)', () => {
    const els: Element[] = [
      { op: 'NAND', a: 2, b: 2 }, // 3, depth 1
      { op: 'LATCH', d: 3 }, // 4
      { op: 'NAND', a: 3, b: 3 }, // 5, depth 2
      { op: 'NAND', a: 5, b: 4 }, // 6, depth 3
      { op: 'NAND', a: 2, b: 3 }, // 7, depth 2
    ];
    const m = metrics(els, 1, 2);
    expect(m).toMatchObject({ nand: 4, latch: 1, gateCount: 5, nState: 1, depth: 3, area: 11, cost: 297, bytes: 32 });
  });
  it('depth counts through latch d inputs, not through latch outputs', () => {
    const els: Element[] = [
      { op: 'LATCH', d: 5 }, // 2
      { op: 'NAND', a: 2, b: 2 }, // 3 depth 1
      { op: 'NAND', a: 3, b: 3 }, // 4 depth 2
      { op: 'NAND', a: 4, b: 4 }, // 5 depth 3 -> feeds LATCH d only
      { op: 'NAND', a: 2, b: 2 }, // 6 depth 1 (output)
    ];
    expect(metrics(els, 0, 1).depth).toBe(3);
  });
  it('podQuality clamps to [1/4, 4]', () => {
    expect(podQuality(1, 100)).toBe(4);
    expect(podQuality(100, 1)).toBe(0.25);
    expect(podQuality(200, 100)).toBe(0.5);
  });
});
