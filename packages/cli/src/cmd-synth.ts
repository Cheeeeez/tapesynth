import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { compile, decodeNetlist, hexToBytes, bytesToHex, pack, podQuality, step, unpack, type FlatElement, type Metrics, type TsynFile } from '@tapesynth/core';
import { importCircuit, verifyOnChain, type ImportedCircuit, type VerifyOnChainResult } from '@tapesynth/core/chain';
import { synthesize, SynthError, type Objective, type SynthRequest, type SynthResult } from '@tapesynth/synth';
import { createHash } from 'node:crypto';
import type { Address, PublicClient } from 'viem';
import { decodePorts, processorArg, publicClient, readTsyn, writeJson } from './common.js';

type Kind = SynthRequest['kind'];

function detectKind(file: string, forced?: string): Kind {
  if (forced) {
    if (forced !== 'verilog' && forced !== 'pla' && forced !== 'netlist') throw new Error(`--kind must be verilog, pla or netlist`);
    return forced;
  }
  const ext = extname(file).toLowerCase();
  if (ext === '.v' || ext === '.sv') return 'verilog';
  if (ext === '.pla') return 'pla';
  if (ext === '.json') return 'netlist';
  throw new Error(`cannot infer --kind from ${file}`);
}

/** For `netlist` input accept either {netlist,nIn,nOut} or a .tsyn.json file. */
function netlistSource(text: string): string {
  const j = JSON.parse(text);
  if (typeof j.netlist !== 'string' || !Number.isInteger(j.nIn) || !Number.isInteger(j.nOut)) throw new Error('netlist JSON needs {netlist, nIn, nOut}');
  return JSON.stringify({ netlist: j.netlist, nIn: j.nIn, nOut: j.nOut });
}

export const toTsyn = (r: SynthResult): TsynFile => ({
  format: r.format, netlist: r.netlist, nIn: r.nIn, nOut: r.nOut, nState: r.nState, pins: r.pins, metrics: r.metrics, verification: r.verification, synth: r.synth,
});

export function printSummary(r: TsynFile, extra?: { candidates?: SynthResult['candidates']; warnings?: string[] }) {
  const m = r.metrics;
  const v = r.verification;
  console.log(`nIn=${r.nIn} nOut=${r.nOut} nState=${r.nState}  gates=${m.gateCount} (nand ${m.nand}, latch ${m.latch})  depth=${m.depth}  area=${m.area}  C=${m.cost}  ${m.bytes} bytes`);
  console.log(v.vectors === 0 && v.sequences === 0
    ? `verified: ${v.reference} (structure only; behaviour check was not run)`
    : `verified: ${v.reference} ${v.method} ${v.sequences ? `${v.sequences}×${v.beats}` : v.vectors} passed`);
  if (extra?.candidates?.length) {
    for (const c of extra.candidates)
      console.error(`  ${c.selected ? '*' : ' '} ${c.name}${c.round ? `+r${c.round}` : ''}: ${c.ok ? `gates=${c.metrics!.gateCount} depth=${c.metrics!.depth} C=${c.metrics!.cost}` : `failed (${c.error})`}`);
  }
  for (const w of extra?.warnings ?? []) console.error(`warning: ${w}`);
}

export async function cmdSynth(file: string, o: { kind?: string; top?: string; clock?: string; objective: string; out?: string; remote?: boolean }) {
  const objective = o.objective as Objective;
  if (!['area', 'depth', 'pod'].includes(objective)) throw new Error('--objective must be area, depth or pod');
  const kind = detectKind(file, o.kind);
  const text = readFileSync(file, 'utf8');
  const source = kind === 'netlist' ? netlistSource(text) : text;
  const out = o.out ?? `${basename(file, extname(file))}.tsyn.json`;
  let result: SynthResult;
  if (o.remote) {
    const api = process.env.TAPESYNTH_API;
    if (!api) throw new Error('TAPESYNTH_API is not set');
    const res = await fetch(`${api.replace(/\/$/, '')}/v1/synth`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, source, top: o.top, clock: o.clock, objective }),
    });
    const body = (await res.json()) as SynthResult & { error?: string; log?: string };
    if (!res.ok) throw new Error(`API ${res.status}: ${body.error ?? 'error'}${body.log ? `\n${body.log}` : ''}`);
    result = body;
  } else {
    try {
      result = await synthesize({ kind, source, top: o.top, clock: o.clock, objective, tier: 'pro' });
    } catch (e) {
      if (e instanceof SynthError && e.log) console.error(e.log.slice(-4000));
      throw e;
    }
  }
  writeJson(out, toTsyn(result));
  printSummary(result, result);
  console.log(`wrote ${out}`);
}

export function cmdInfo(file: string, o: { cref?: string }) {
  const r = readTsyn(file);
  printSummary(r);
  console.log(`netlist: ${bytesToHex(hexToBytes(r.netlist).subarray(0, 24))}${r.metrics.bytes > 24 ? '…' : ''}`);
  console.log(`inputs : ${r.pins.inputs.map((p) => `${p.port}[${p.bit}]`).join(' ') || '(none)'}`);
  console.log(`outputs: ${r.pins.outputs.map((p) => `${p.port}[${p.bit}]`).join(' ')}`);
  if (r.pins.clock) console.log(`clock  : ${r.pins.clock} (one beat per clock edge; not an input)`);
  console.log(`synth  : ${r.synth.sourceKind} → ${r.synth.objective} / ${r.synth.candidate} (tapesynth ${r.synth.version}${r.synth.yosys ? `, ${r.synth.yosys}` : ''})`);
  if (o.cref) console.log(`PoD q = ${podQuality(r.metrics.cost, Number(o.cref)).toFixed(4)} (Cref ${o.cref}, C ${r.metrics.cost})`);
}

export function cmdSim(file: string, o: { inputs?: string; state?: string; beats?: string }) {
  const r = readTsyn(file);
  const c = compile(decodeNetlist(hexToBytes(r.netlist)) as FlatElement[], r.nIn, r.nOut);
  const inputs = unpack(hexToBytes(o.inputs ?? '0x'), r.nIn);
  let state: Uint8Array = unpack(hexToBytes(o.state ?? '0x'), r.nState);
  const beats = o.beats ? parseInt(o.beats, 10) : 1;
  for (let t = 0; t < beats; t++) {
    const s = step(c, state, inputs);
    console.log(`beat ${t}: outputs=${bytesToHex(pack(s.outputs))} ${decodePorts(r.pins.outputs, s.outputs).join(' ')}${r.nState ? ` state=${bytesToHex(pack(state))}` : ''}`);
    state = s.newState;
  }
}

type Checked = ImportedCircuit & { check: VerifyOnChainResult };

/** Import, then compare the flattened netlist with the chain's own eval/step results. */
async function importChecked(pc: PublicClient, cpu: Address, id: bigint): Promise<Checked> {
  const imp = await importCircuit(pc, cpu, id);
  const check = await verifyOnChain(
    pc, cpu, id,
    { netlist: bytesToHex(imp.netlist), nIn: imp.nIn, nOut: imp.nOut, nState: imp.nState, metrics: { gateCount: imp.gateCount } },
    { behaviourOnly: true },
  );
  if (check.mismatches.length) throw new Error(`import differs from on-chain behaviour: ${check.mismatches[0]}`);
  if (check.skipped) console.error(`warning: behaviour check skipped (${check.skipped})`);
  return { ...imp, check };
}

export async function cmdImport(cpuRef: string, idStr: string, o: { out?: string }) {
  const pc = publicClient();
  const cpu = await processorArg(pc, cpuRef);
  const imp = await importChecked(pc, cpu, BigInt(idStr));
  const netlist = bytesToHex(imp.netlist);
  const seq = imp.nState > 0;
  const file: TsynFile = {
    format: 'tapesynth/1',
    netlist, nIn: imp.nIn, nOut: imp.nOut, nState: imp.nState,
    pins: { inputs: Array.from({ length: imp.nIn }, (_, i) => ({ port: 'x', bit: i })), outputs: Array.from({ length: imp.nOut }, (_, i) => ({ port: 'y', bit: i })), clock: imp.nState ? 'clk' : null },
    metrics: imp.metrics,
    verification: {
      reference: 'onchain', method: 'random', passed: true,
      vectors: imp.check.skipped || seq ? 0 : imp.check.matched - 1,
      sequences: imp.check.skipped || !seq ? 0 : 4,
      beats: imp.check.skipped || !seq ? 0 : 16,
    },
    synth: { version: '0.1.0', yosys: null, objective: 'pod', candidate: 'onchain-import', sourceKind: 'onchain', sourceSha256: createHash('sha256').update(`${cpu.toLowerCase()}:${idStr}`).digest('hex') },
  };
  const out = o.out ?? `${cpu.slice(0, 8)}-${idStr}.tsyn.json`;
  writeJson(out, file);
  console.log(`imported ${cpu}#${idStr}${imp.hadRefs ? ' (REFs flattened)' : ''}: nIn=${imp.nIn} nOut=${imp.nOut} nState=${imp.nState} gateCount=${imp.gateCount}`);
  console.log(`wrote ${out}`);
}

function row(label: string, a: number, b: number) {
  const pct = a ? `${(((b - a) / a) * 100).toFixed(1)}%` : '-';
  console.log(`${label.padEnd(10)} ${String(a).padStart(12)} ${String(b).padStart(12)} ${pct.padStart(9)}`);
}

export async function cmdOptimize(cpuRef: string, idStr: string, o: { objective: string; cref?: string; out?: string }) {
  const objective = o.objective as Objective;
  const pc = publicClient();
  const cpu = await processorArg(pc, cpuRef);
  const imp = await importChecked(pc, cpu, BigInt(idStr));
  const result = await synthesize({
    kind: 'netlist', source: JSON.stringify({ netlist: bytesToHex(imp.netlist), nIn: imp.nIn, nOut: imp.nOut }), objective, tier: 'pro',
  });
  const out = o.out ?? `${cpu.slice(0, 8)}-${idStr}.opt.tsyn.json`;
  writeJson(out, toTsyn(result));
  const before: Metrics = imp.metrics;
  const after = result.metrics;
  console.log(`${''.padEnd(10)} ${'before'.padStart(12)} ${'after'.padStart(12)} ${'change'.padStart(9)}`);
  row('gateCount', before.gateCount, after.gateCount);
  row('depth', before.depth, after.depth);
  row('area A', before.area, after.area);
  row('cost C', before.cost, after.cost);
  const cref = o.cref ? Number(o.cref) : before.cost;
  console.log(`q (Cref=${cref}): before ${podQuality(before.cost, cref).toFixed(4)}  after ${podQuality(after.cost, cref).toFixed(4)}`);
  console.log(`verified against the original netlist: ${result.verification.method} ${result.verification.vectors || `${result.verification.sequences}×${result.verification.beats}`} passed`);
  console.log(`wrote ${out}`);
}
