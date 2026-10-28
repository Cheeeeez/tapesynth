import type { Address, PublicClient } from 'viem';
import { factoryAbi, processorAbi } from './abi.js';
import { FACTORY } from './constants.js';
import {
  decodeNetlist, encodeNetlist, finalizeFlat, flattenBody, metrics, NetlistError,
  type FlatElement, type Metrics,
} from '../index.js';

export type OnchainCircuit = { netlist: Uint8Array; nIn: number; nOut: number; nState: number; gateCount: number };

export async function readCircuit(pc: PublicClient, cpu: Address, id: bigint): Promise<OnchainCircuit> {
  const [info, nl] = await Promise.all([
    pc.readContract({ address: cpu, abi: processorAbi, functionName: 'circuitInfo', args: [id] }),
    pc.readContract({ address: cpu, abi: processorAbi, functionName: 'netlist', args: [id] }),
  ]);
  const hex = nl.startsWith('0x') ? nl.slice(2) : nl;
  const netlist = new Uint8Array(hex.length / 2);
  for (let i = 0; i < netlist.length; i++) netlist[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return { netlist, nIn: info[0], nOut: info[1], nState: info[2], gateCount: info[3] };
}

/** `0x…` address, or a processor number P (= factory.cpuAt(P)). */
export async function resolveProcessor(pc: PublicClient, ref: string | number | bigint): Promise<Address> {
  if (typeof ref === 'string' && /^0x[0-9a-fA-F]{40}$/.test(ref)) return ref as Address;
  const s = String(ref).trim();
  if (!/^\d+$/.test(s)) throw new Error(`not a processor address or number: ${s}`);
  return pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'cpuAt', args: [BigInt(s)] });
}

export type ImportedCircuit = {
  cpu: Address;
  id: bigint;
  /** flat (REF-free) netlist, `outs` already trailing */
  elements: FlatElement[];
  netlist: Uint8Array;
  nIn: number;
  nOut: number;
  nState: number;
  /** on-chain gate count (REFs counted recursively) */
  gateCount: number;
  /** PoD metrics of the flat netlist */
  metrics: Metrics;
  /** true when the original contained REFs */
  hadRefs: boolean;
};

/** Read a circuit, inline REFs, and check the result against `circuitInfo` (else `import-mismatch`). */
export async function importCircuit(pc: PublicClient, cpu: Address, id: bigint): Promise<ImportedCircuit> {
  const c = await readCircuit(pc, cpu, id);
  const els = decodeNetlist(c.netlist);
  const hadRefs = els.some((e) => e.op === 'REF');
  const cache = new Map<string, OnchainCircuit>();
  const flat = await flattenBody(els, c.nIn, c.nOut, async (p, i) => {
    const k = `${p.toLowerCase()}:${i}`;
    let r = cache.get(k);
    if (!r) {
      try {
        r = await readCircuit(pc, p, i);
      } catch {
        return undefined;
      }
      cache.set(k, r);
    }
    return r;
  });
  const nLatch = flat.body.filter((e) => e.op === 'LATCH').length;
  if (flat.body.length !== c.gateCount || nLatch !== c.nState)
    throw new NetlistError('import-mismatch', `flattened ${flat.body.length} gates / ${nLatch} latches, chain says ${c.gateCount} / ${c.nState}`);
  const elements = finalizeFlat(flat);
  return {
    cpu, id, elements, netlist: encodeNetlist(elements), nIn: c.nIn, nOut: c.nOut, nState: c.nState, gateCount: c.gateCount,
    metrics: metrics(elements, c.nIn, c.nOut), hadRefs,
  };
}
