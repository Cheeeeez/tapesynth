import type { Hex } from './hex.js';
import type { Metrics } from './metrics.js';
import type { Pins } from './fromYosys.js';

export type Verification = {
  reference: 'pre-abc' | 'pla' | 'original-netlist' | 'onchain';
  method: 'exhaustive' | 'random';
  vectors: number;
  sequences: number;
  beats: number;
  passed: true;
};

export type SynthInfo = {
  version: string;
  yosys: string | null;
  objective: 'area' | 'depth' | 'pod';
  candidate: string;
  sourceKind: 'verilog' | 'pla' | 'netlist' | 'onchain';
  sourceSha256: string;
};

/** The `.tsyn.json` file produced by `tapesynth synth` / the API. */
export type TsynFile = {
  format: 'tapesynth/1';
  netlist: Hex;
  nIn: number;
  nOut: number;
  nState: number;
  pins: Pins;
  metrics: Metrics;
  verification: Verification;
  synth: SynthInfo;
};

export function assertTsyn(x: unknown): asserts x is TsynFile {
  const f = x as Partial<TsynFile> | null;
  if (!f || f.format !== 'tapesynth/1' || typeof f.netlist !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(f.netlist) ||
      !Number.isInteger(f.nIn) || !Number.isInteger(f.nOut) || !Number.isInteger(f.nState))
    throw new Error('not a tapesynth/1 file');
}
