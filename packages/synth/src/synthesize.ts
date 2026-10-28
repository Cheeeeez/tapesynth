import { createHash } from 'node:crypto';
import {
  decodeNetlist, fromYosysJson, hexToBytes, bytesToHex, metrics, netlistToVerilog, parsePla, peephole, plaToVerilog, plaTruthTable,
  validate, encodeNetlist, type FlatElement, type Metrics, type Pins, type TsynFile, type Verification, type YosysJson,
} from '@tapesynth/core';
import { SynthError, isIdentifier, runYosysScript, yosysVersion } from './yosys.js';
import { buildRefSim, type Sim } from './refsim.js';
import { simFromNetlist, verifyEquivalent } from './verify.js';

export const SYNTH_VERSION = '0.1.0';

export type Objective = 'area' | 'depth' | 'pod';
export type SynthRequest = {
  kind: 'verilog' | 'pla' | 'netlist';
  /** verilog / pla text, or for `netlist` a JSON string {netlist: "0x..", nIn, nOut} (already flattened) */
  source: string;
  top?: string;
  clock?: string;
  objective: Objective;
  tier: 'free' | 'pro';
};

export type CandidateReport = {
  name: string;
  round: number;
  ok: boolean;
  error?: string;
  metrics?: Metrics;
  selected?: boolean;
};

export type SynthResult = TsynFile & { candidates: CandidateReport[]; warnings: string[]; log: string };

const CANDIDATES: { name: string; abc: string }[] = [
  { name: 'default', abc: 'abc -g NAND' },
  { name: 'delay', abc: 'abc -g NAND -D 1' },
];

const script = (top: string, abc: string) => `read_verilog -sv design.v
synth -flatten -top ${top} -noabc
dfflegalize -cell $_DFF_P_ 0
setundef -zero
opt_clean -purge
write_json pre.json
${abc}
opt_clean -purge
write_json post.json
`;

type Built = {
  name: string;
  round: number;
  elements: FlatElement[];
  nIn: number;
  nOut: number;
  pins: Pins;
  metrics: Metrics;
  warnings: string[];
};

const rankKey = (m: Metrics, obj: Objective): number[] =>
  obj === 'area' ? [m.gateCount, m.depth] : obj === 'depth' ? [m.depth, m.gateCount] : [m.cost, m.gateCount];
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

function detectTop(src: string): string {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const m = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/.exec(stripped);
  if (!m) throw new SynthError('no-module', 'no module found in the source');
  return m[1]!;
}

type Normalized = {
  verilog: string;
  top: string;
  reference: Verification['reference'];
  table?: Uint8Array[];
  originalSim?: Sim;
  /** pins of the source (netlist kind: x/y ports) */
  fixedNote?: string;
};

function normalize(req: SynthRequest): Normalized {
  if (req.kind === 'verilog') {
    const top = req.top ?? detectTop(req.source);
    return { verilog: req.source, top, reference: 'pre-abc' };
  }
  if (req.kind === 'pla') {
    const pla = parsePla(req.source);
    const top = req.top ?? 'tt';
    return { verilog: plaToVerilog(pla, top), top, reference: 'pla', table: plaTruthTable(pla) };
  }
  let obj: { netlist: string; nIn: number; nOut: number };
  try {
    obj = JSON.parse(req.source);
  } catch {
    throw new SynthError('bad-source', 'netlist source must be JSON {netlist, nIn, nOut}');
  }
  const els = decodeNetlist(hexToBytes(obj.netlist));
  validate(els, obj.nIn, obj.nOut);
  const flat = els as FlatElement[];
  if (els.some((e) => e.op === 'REF')) throw new SynthError('ref-not-flattened', 'netlist contains REF; flatten it first');
  const top = req.top ?? 'imported';
  return { verilog: netlistToVerilog(els, obj.nIn, obj.nOut, top), top, reference: 'original-netlist', originalSim: simFromNetlist(flat, obj.nIn, obj.nOut) };
}

async function runCandidate(
  verilog: string, top: string, clock: string, cand: { name: string; abc: string }, round: number,
): Promise<{ built: Built; pre: YosysJson; log: string }> {
  const { files, log } = await runYosysScript(verilog, script(top, cand.abc));
  if (!files['post.json'] || !files['pre.json']) throw new SynthError('yosys-failed', 'yosys produced no output', log);
  const pre = JSON.parse(files['pre.json']) as YosysJson;
  const post = JSON.parse(files['post.json']) as YosysJson;
  const conv = fromYosysJson(post, { top, clock });
  const elements = peephole(conv.elements, conv.nIn, conv.nOut);
  return {
    built: { name: cand.name, round, elements, nIn: conv.nIn, nOut: conv.nOut, pins: conv.pins, metrics: metrics(elements, conv.nIn, conv.nOut), warnings: conv.warnings },
    pre,
    log,
  };
}

export async function synthesize(req: SynthRequest): Promise<SynthResult> {
  const norm = normalize(req);
  if (!isIdentifier(norm.top)) throw new SynthError('bad-top', `invalid top module name: ${norm.top}`);
  const clock = req.clock ?? 'clk';
  const sourceSha256 = createHash('sha256').update(req.source).digest('hex');
  const seed = parseInt(sourceSha256.slice(0, 8), 16);
  const reports: CandidateReport[] = [];
  const pool: Built[] = [];
  const warnings: string[] = [];
  let log = '';
  let preJson: YosysJson | null = null;
  let pins0: Pins | null = null;

  const cands = req.tier === 'free' ? [req.objective === 'depth' ? CANDIDATES[1]! : CANDIDATES[0]!] : CANDIDATES;

  // stage 0
  let lastErr: SynthError | null = null;
  for (const cand of cands) {
    try {
      const r = await runCandidate(norm.verilog, norm.top, clock, cand, 0);
      log += r.log;
      preJson ??= r.pre;
      pins0 ??= r.built.pins;
      pool.push(r.built);
      warnings.push(...r.built.warnings);
      reports.push({ name: cand.name, round: 0, ok: true, metrics: r.built.metrics });
    } catch (e) {
      const err = e instanceof SynthError ? e : new SynthError((e as { code?: string }).code ?? 'synth-failed', (e as Error).message);
      lastErr = err;
      log += err.log;
      reports.push({ name: cand.name, round: 0, ok: false, error: `${err.code}: ${err.message}` });
      warnings.push(`candidate ${cand.name} failed: ${err.code}`);
    }
  }
  if (!pool.length || !preJson || !pins0) throw lastErr ?? new SynthError('synth-failed', 'no candidate succeeded', log);

  // pro: re-synthesise the best result through ABC again, at most 3 rounds
  if (req.tier === 'pro') {
    let best = [...pool].sort((a, b) => cmp(rankKey(a.metrics, req.objective), rankKey(b.metrics, req.objective)))[0]!;
    for (let round = 1; round <= 3; round++) {
      const v = netlistToVerilog(best.elements, best.nIn, best.nOut, 'imported');
      let roundBest: Built | null = null;
      for (const cand of CANDIDATES) {
        try {
          const r = await runCandidate(v, 'imported', 'clk', cand, round);
          log += r.log;
          const built = { ...r.built, pins: { ...pins0, clock: r.built.pins.clock ? pins0.clock ?? 'clk' : null } };
          if (built.nIn !== pins0.inputs.length || built.nOut !== pins0.outputs.length) continue;
          pool.push(built);
          reports.push({ name: cand.name, round, ok: true, metrics: built.metrics });
          if (!roundBest || cmp(rankKey(built.metrics, req.objective), rankKey(roundBest.metrics, req.objective)) < 0) roundBest = built;
        } catch (e) {
          reports.push({ name: cand.name, round, ok: false, error: String((e as Error).message) });
        }
      }
      if (!roundBest || cmp(rankKey(roundBest.metrics, req.objective), rankKey(best.metrics, req.objective)) >= 0) break;
      best = roundBest;
    }
  }

  // Rank, then verify in order; never return an unverified netlist.
  const ranked = [...pool].sort((a, b) => cmp(rankKey(a.metrics, req.objective), rankKey(b.metrics, req.objective)));
  let ref: Sim;
  try {
    ref = norm.originalSim ?? buildRefSim(preJson, norm.top, pins0);
  } catch (e) {
    if (e instanceof SynthError) throw new SynthError(e.code, e.message, log);
    throw e;
  }
  let verifyErr: SynthError | null = null;
  for (const b of ranked) {
    try {
      const verification = verifyEquivalent(ref, simFromNetlist(b.elements, b.nIn, b.nOut), { reference: norm.reference, seed, table: norm.table });
      const rep = reports.find((r) => r.name === b.name && r.round === b.round && r.ok);
      if (rep) rep.selected = true;
      const bytes = encodeNetlist(b.elements);
      const pins: Pins = b.pins.clock && b.metrics.nState === 0 ? { ...b.pins, clock: null } : b.pins;
      const file: TsynFile = {
        format: 'tapesynth/1',
        netlist: bytesToHex(bytes),
        nIn: b.nIn,
        nOut: b.nOut,
        nState: b.metrics.nState,
        pins,
        metrics: b.metrics,
        verification,
        synth: { version: SYNTH_VERSION, yosys: await yosysVersion(), objective: req.objective, candidate: b.round ? `${b.name}+r${b.round}` : b.name, sourceKind: req.kind, sourceSha256 },
      };
      return { ...file, candidates: reports, warnings: [...new Set(warnings)], log };
    } catch (e) {
      if (!(e instanceof SynthError) || e.code !== 'verification-failed') throw e;
      verifyErr = e;
      warnings.push(`candidate ${b.name} (round ${b.round}) failed verification: ${e.message}`);
    }
  }
  throw new SynthError('verification-failed', verifyErr?.message ?? 'verification failed', log);
}
