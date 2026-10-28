import type { TsynFile } from '@tapesynth/core';

export type CandidateReport = {
  name: string;
  round: number;
  ok: boolean;
  error?: string;
  metrics?: TsynFile['metrics'];
  selected?: boolean;
};

export type SynthResponse = TsynFile & { candidates: CandidateReport[]; warnings: string[] };

export type DesignKind = 'verilog' | 'pla' | 'onchain';
export type Objective = 'area' | 'depth' | 'pod';

export type SynthBody = {
  kind: 'verilog' | 'pla' | 'netlist';
  source: string;
  top?: string;
  clock?: string;
  objective: Objective;
};

export type Deployments = {
  processor: `0x${string}` | null;
  transistors: `0x${string}` | null;
  processorNumber: number | null;
  circuits: { id: number; name: string; file: string; txHash?: string }[];
  siteCircuitId: number | null;
};

/** What the Optimize tab shows after an on-chain optimization run. */
export type OptimizeRun = {
  cpu: `0x${string}`;
  id: bigint;
  before: TsynFile['metrics'];
  result: SynthResponse;
};
