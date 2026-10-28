import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile, decodeNetlist, hexToBytes, pack, bytesToHex, step, unpack, type FlatElement } from '@tapesynth/core';
import { SynthError, simFromNetlist, synthesize, verifyEquivalent, type SynthResult } from '../src/index.js';

const ex = (n: string) => readFileSync(new URL(`../../../examples/${n}`, import.meta.url), 'utf8');
const compiled = (r: SynthResult) => compile(decodeNetlist(hexToBytes(r.netlist)) as FlatElement[], r.nIn, r.nOut);
const run = (r: SynthResult, inputs: number[]) => Array.from(step(compiled(r), new Uint8Array(r.nState), inputs).outputs);

describe('input port order (declaration order, LSB first)', () => {
  it('module m(input b, input a, output y): input 0 is b', async () => {
    const r = await synthesize({ kind: 'verilog', source: 'module m(input b, input a, output y); assign y = b & ~a; endmodule', objective: 'area', tier: 'free' });
    expect(r.pins.inputs).toEqual([{ port: 'b', bit: 0 }, { port: 'a', bit: 0 }]);
    expect(run(r, [1, 0])).toEqual([1]);
    expect(run(r, [0, 1])).toEqual([0]);
    expect(r.verification).toMatchObject({ reference: 'pre-abc', method: 'exhaustive', vectors: 4, passed: true });
  });
});

describe('synthesize', () => {
  it('popcount8 (pod, pro): exhaustive 256 vectors and correct counts', async () => {
    const r = await synthesize({ kind: 'verilog', source: ex('popcount8.v'), objective: 'pod', tier: 'pro' });
    expect([r.nIn, r.nOut, r.nState]).toEqual([8, 4, 0]);
    expect(r.verification).toMatchObject({ reference: 'pre-abc', method: 'exhaustive', vectors: 256, passed: true });
    const c = compiled(r);
    for (let v = 0; v < 256; v++) {
      const bits = Array.from({ length: 8 }, (_, i) => (v >> i) & 1);
      const out = step(c, [], bits).outputs;
      expect(out[0]! + 2 * out[1]! + 4 * out[2]! + 8 * out[3]!).toBe(bits.reduce((a, b) => a + b, 0));
    }
    console.log('popcount8', JSON.stringify(r.metrics), r.synth.candidate);
  });

  it('counter4: clock dropped, 4 state bits, 64x32 random sequences, LATCH delays one beat', async () => {
    const r = await synthesize({ kind: 'verilog', source: ex('counter4.v'), objective: 'area', tier: 'free' });
    expect([r.nIn, r.nOut, r.nState]).toEqual([1, 4, 4]);
    expect(r.pins.clock).toBe('clk');
    expect(r.verification).toMatchObject({ method: 'random', sequences: 64, beats: 32 });
    const c = compiled(r);
    let st = new Uint8Array(4);
    const seen: number[] = [];
    for (let t = 0; t < 4; t++) {
      const s = step(c, st, [1]);
      seen.push(s.outputs[0]! + 2 * s.outputs[1]! + 4 * s.outputs[2]! + 8 * s.outputs[3]!);
      st = s.newState;
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    console.log('counter4', JSON.stringify(r.metrics));
  });

  it('spend_policy: >16 inputs use 4096 random vectors', async () => {
    const r = await synthesize({ kind: 'verilog', source: ex('spend_policy.v'), objective: 'pod', tier: 'pro' });
    expect([r.nIn, r.nOut, r.nState]).toEqual([23, 1, 0]);
    expect(r.verification).toMatchObject({ method: 'random', vectors: 4096 });
    const mk = (amount: number, limit: number, mask: number, rcpt: number, frozen: number) => [
      ...Array.from({ length: 8 }, (_, i) => (amount >> i) & 1), ...Array.from({ length: 8 }, (_, i) => (limit >> i) & 1),
      ...Array.from({ length: 4 }, (_, i) => (mask >> i) & 1), rcpt & 1, (rcpt >> 1) & 1, frozen,
    ];
    expect(run(r, mk(5, 10, 0b0100, 2, 0))).toEqual([1]);
    expect(run(r, mk(11, 10, 0b0100, 2, 0))).toEqual([0]);
    expect(run(r, mk(5, 10, 0b0100, 1, 0))).toEqual([0]);
    expect(run(r, mk(5, 10, 0b0100, 2, 1))).toEqual([0]);
    console.log('spend_policy', JSON.stringify(r.metrics));
  });

  it('PLA input is checked against the PLA table', async () => {
    const r = await synthesize({ kind: 'pla', source: ex('xor3.pla'), objective: 'area', tier: 'free' });
    expect(r.verification).toMatchObject({ reference: 'pla', method: 'exhaustive', vectors: 8 });
    for (let m = 0; m < 8; m++) expect(run(r, [m & 1, (m >> 1) & 1, (m >> 2) & 1])[0]).toBe(((m & 1) ^ ((m >> 1) & 1) ^ ((m >> 2) & 1)));
  });

  it('netlist input: re-synthesis is verified against the original netlist', async () => {
    const p = await synthesize({ kind: 'verilog', source: ex('adder8.v'), objective: 'area', tier: 'free' });
    const r = await synthesize({ kind: 'netlist', source: JSON.stringify({ netlist: p.netlist, nIn: p.nIn, nOut: p.nOut }), objective: 'area', tier: 'pro' });
    expect(r.verification.reference).toBe('original-netlist');
    expect(r.metrics.gateCount).toBeLessThanOrEqual(p.metrics.gateCount);
    console.log('adder8 free', p.metrics.gateCount, 'pro-reopt', r.metrics.gateCount);
  });

  it('reports yosys syntax errors with a code', async () => {
    await expect(synthesize({ kind: 'verilog', source: 'module m(input a, output y); assign y = ; endmodule', objective: 'area', tier: 'free' })).rejects.toMatchObject({ code: 'yosys-failed' });
  });

  it('rejects an unsafe top name (no script injection)', async () => {
    await expect(synthesize({ kind: 'verilog', source: 'module m(input a, output y); assign y = a; endmodule', top: 'm; write_file x', objective: 'area', tier: 'free' })).rejects.toMatchObject({ code: 'bad-top' });
  });
});

describe('verifyEquivalent', () => {
  it('detects a wrong netlist', () => {
    const good: FlatElement[] = [{ op: 'NAND', a: 2, b: 3 }];
    const bad: FlatElement[] = [{ op: 'NAND', a: 2, b: 2 }];
    expect(() => verifyEquivalent(simFromNetlist(good, 2, 1), simFromNetlist(bad, 2, 1), { reference: 'pre-abc', seed: 1 })).toThrow(SynthError);
    expect(verifyEquivalent(simFromNetlist(good, 2, 1), simFromNetlist(good, 2, 1), { reference: 'pre-abc', seed: 1 }).passed).toBe(true);
  });
  it('detects a sequential mismatch', () => {
    // q' = en (latch) vs q' = !en
    const a: FlatElement[] = [{ op: 'LATCH', d: 2 }];
    const b: FlatElement[] = [{ op: 'LATCH', d: 4 }, { op: 'NAND', a: 2, b: 2 }];
    const bb: FlatElement[] = [{ op: 'NAND', a: 2, b: 2 }, { op: 'LATCH', d: 3 }];
    expect(() => verifyEquivalent(simFromNetlist(a, 1, 1), simFromNetlist(bb, 1, 1), { reference: 'pre-abc', seed: 2 })).toThrow(/differs/);
    void b; void pack; void unpack; void bytesToHex;
  });
});
