import { bytesToHex, type TsynFile } from '@tapesynth/core';
import { importCircuit } from '@tapesynth/core/chain';
import type { Address } from 'viem';
import { publicClient, parseProcessor } from './chain';
import type { DesignKind, Objective, SynthBody } from './types';

export type DesignState = {
  kind: DesignKind;
  text: string;
  top: string;
  clock: string;
  objective: Objective;
  example: string;
  cpu: string;
  circuitId: string;
};

export type Prepared = { body: SynthBody; before?: TsynFile['metrics']; cpu?: Address; id?: bigint };

/** Turn the form into an API request; on-chain circuits are imported (REFs flattened) in the browser. */
export async function prepare(d: DesignState): Promise<Prepared> {
  if (d.kind === 'onchain') {
    const cpu = await parseProcessor(d.cpu);
    if (!/^\d+$/.test(d.circuitId.trim())) throw new Error('circuit id must be a number');
    const id = BigInt(d.circuitId.trim());
    const imp = await importCircuit(publicClient, cpu, id);
    return {
      body: { kind: 'netlist', source: JSON.stringify({ netlist: bytesToHex(imp.netlist), nIn: imp.nIn, nOut: imp.nOut }), objective: d.objective },
      before: imp.metrics, cpu, id,
    };
  }
  return { body: { kind: d.kind, source: d.text, top: d.top.trim() || undefined, clock: d.clock.trim() || undefined, objective: d.objective } };
}
