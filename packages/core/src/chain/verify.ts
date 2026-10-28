import type { Address, PublicClient } from 'viem';
import { processorAbi } from './abi.js';
import { pool, xorshift } from './util.js';
import { bytesToHex, compile, decodeNetlist, hexToBytes, pack, step, unpack, type FlatElement, type TsynFile } from '../index.js';

export type VerifyOnChainResult = {
  calls: number;
  matched: number;
  mismatches: string[];
  /** set when the public RPC refused the call (gas cap); structural checks still ran */
  skipped?: 'rpc-gas-cap';
};

const isGasCap = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return /gas/i.test(m) && /(cap|limit|exceed)/i.test(m);
};

/**
 * Compare a taped-out circuit with the local file: circuitInfo, byte-for-byte netlist, and
 * eval/step results on random inputs against the local simulator.
 */
export async function verifyOnChain(
  pc: PublicClient,
  cpu: Address,
  id: bigint,
  file: Pick<TsynFile, 'netlist' | 'nIn' | 'nOut' | 'nState'> & { metrics: Pick<TsynFile['metrics'], 'gateCount'> },
  opts: { vectors?: number; sequences?: number; beats?: number; concurrency?: number; seed?: number; /** compare behaviour only (e.g. a flattened import of a circuit that uses REF) */ behaviourOnly?: boolean } = {},
): Promise<VerifyOnChainResult> {
  const vectors = opts.vectors ?? 64;
  const sequences = opts.sequences ?? 4;
  const beats = opts.beats ?? 16;
  const conc = opts.concurrency ?? 8;
  const mismatches: string[] = [];
  let calls = 0;
  let matched = 0;

  const [info, nl] = await Promise.all([
    pc.readContract({ address: cpu, abi: processorAbi, functionName: 'circuitInfo', args: [id] }),
    pc.readContract({ address: cpu, abi: processorAbi, functionName: 'netlist', args: [id] }),
  ]);
  calls += 2;
  const want = [file.nIn, file.nOut, file.nState, file.metrics.gateCount];
  if (info.some((v, i) => v !== want[i])) mismatches.push(`circuitInfo ${JSON.stringify(Array.from(info))} != file ${JSON.stringify(want)}`);
  else matched++;
  if (!opts.behaviourOnly) {
    if (nl.toLowerCase() !== file.netlist.toLowerCase()) mismatches.push('on-chain netlist differs from file');
    else matched++;
  }
  if (mismatches.length) return { calls, matched, mismatches };

  const c = compile(decodeNetlist(hexToBytes(file.netlist)) as FlatElement[], file.nIn, file.nOut);
  const rnd = xorshift(opts.seed ?? 1);
  const randBits = (n: number) => Uint8Array.from({ length: n }, () => rnd() & 1);
  let skipped: VerifyOnChainResult['skipped'];

  if (file.nState === 0) {
    const exhaustive = file.nIn <= 6 && 2 ** file.nIn <= vectors;
    const inputs: Uint8Array[] = exhaustive
      ? Array.from({ length: 2 ** file.nIn }, (_, v) => Uint8Array.from({ length: file.nIn }, (_, i) => (v >> i) & 1))
      : Array.from({ length: vectors }, () => randBits(file.nIn));
    await pool(conc, inputs.map((bits) => async () => {
      if (skipped) return;
      try {
        const out = await pc.readContract({ address: cpu, abi: processorAbi, functionName: 'eval', args: [id, bytesToHex(pack(bits))] });
        calls++;
        const got = bytesToHex(pack(unpack(hexToBytes(out), file.nOut)));
        const exp = bytesToHex(pack(step(c, new Uint8Array(0), bits).outputs));
        if (got === exp) matched++;
        else mismatches.push(`eval(${bytesToHex(pack(bits))}) = ${got}, expected ${exp}`);
      } catch (e) {
        if (isGasCap(e)) skipped = 'rpc-gas-cap';
        else throw e;
      }
    }));
  } else {
    await pool(conc, Array.from({ length: sequences }, (_, s) => async () => {
      let state: Uint8Array = new Uint8Array(file.nState);
      for (let t = 0; t < beats && !skipped; t++) {
        const bits = randBits(file.nIn);
        const exp = step(c, state, bits);
        try {
          const [ns, out] = await pc.readContract({
            address: cpu, abi: processorAbi, functionName: 'step', args: [id, bytesToHex(pack(state)), bytesToHex(pack(bits))],
          });
          calls++;
          const gotOut = bytesToHex(pack(unpack(hexToBytes(out), file.nOut)));
          const gotState = bytesToHex(pack(unpack(hexToBytes(ns), file.nState)));
          const expOut = bytesToHex(pack(exp.outputs));
          const expState = bytesToHex(pack(exp.newState));
          if (gotOut === expOut && gotState === expState) matched++;
          else {
            mismatches.push(`seq ${s} beat ${t}: out ${gotOut}/${expOut} state ${gotState}/${expState}`);
            return;
          }
        } catch (e) {
          if (isGasCap(e)) skipped = 'rpc-gas-cap';
          else throw e;
        }
        state = exp.newState;
      }
    }));
  }
  return { calls, matched, mismatches, ...(skipped ? { skipped } : {}) };
}
