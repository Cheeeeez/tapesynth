import { useMemo, useState } from 'react';
import { compile, decodeNetlist, hexToBytes, podQuality, step, type FlatElement } from '@tapesynth/core';
import type { SynthResponse } from '../types';

function groupBits(pins: { port: string; bit: number }[], bits: ArrayLike<number>) {
  const groups = new Map<string, number[]>();
  pins.forEach((p, i) => {
    const g = groups.get(p.port) ?? [];
    g[p.bit] = bits[i] ? 1 : 0;
    groups.set(p.port, g);
  });
  return [...groups].map(([port, g]) => ({ port, bits: g, value: g.reduce((v, b, i) => (b ? v | (1n << BigInt(i)) : v), 0n) }));
}

function Simulator({ res }: { res: SynthResponse }) {
  const compiled = useMemo(() => compile(decodeNetlist(hexToBytes(res.netlist)) as FlatElement[], res.nIn, res.nOut), [res.netlist, res.nIn, res.nOut]);
  const [inputs, setInputs] = useState<number[]>(() => Array(res.nIn).fill(0));
  const [state, setState] = useState<Uint8Array>(() => new Uint8Array(res.nState));
  const [beat, setBeat] = useState(0);
  const out = step(compiled, state, inputs);
  const sequential = res.nState > 0;
  const inGroups = groupBits(res.pins.inputs, inputs);
  const outGroups = groupBits(res.pins.outputs, out.outputs);
  const toggle = (i: number) => setInputs(inputs.map((v, k) => (k === i ? 1 - v : v)));
  return (
    <div className="sim">
      <h3>Simulate</h3>
      <div className="pins">
        {res.pins.inputs.length === 0 && <span className="muted">no inputs</span>}
        {res.pins.inputs.map((p, i) => (
          <label key={i} className="pin"><input type="checkbox" checked={!!inputs[i]} onChange={() => toggle(i)} /> {p.port}[{p.bit}]</label>
        ))}
      </div>
      <p>inputs: {inGroups.map((g) => `${g.port}=0x${g.value.toString(16)}`).join('  ') || '—'}</p>
      <p><b>outputs{sequential ? ` (beat ${beat})` : ''}:</b> {outGroups.map((g) => <code key={g.port}>{g.port}={g.bits.length > 1 ? `0x${g.value.toString(16)} (${[...g.bits].reverse().join('')}b)` : String(g.value)} </code>)}</p>
      {sequential && (
        <div className="row">
          <button onClick={() => { setState(out.newState); setBeat(beat + 1); }}>Step</button>
          <button onClick={() => { setState(new Uint8Array(res.nState)); setBeat(0); }}>Reset</button>
          <span className="muted">state {Array.from(state).join('') || '0'}{res.pins.clock ? ` · one Step = one ${res.pins.clock} edge` : ''}</span>
        </div>
      )}
    </div>
  );
}

export function download(res: SynthResponse) {
  const { candidates: _c, warnings: _w, ...file } = res;
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'design.tsyn.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Results({ res }: { res: SynthResponse | null }) {
  const [cref, setCref] = useState('');
  if (!res) return <section><h2>Results</h2><p className="muted">Synthesize a design first.</p></section>;
  const m = res.metrics;
  const v = res.verification;
  const crefN = Number(cref);
  return (
    <section>
      <h2>Results</h2>
      <p className="badge ok">✓ verified: {v.reference} · {v.method} · {v.sequences ? `${v.sequences} sequences × ${v.beats} beats` : `${v.vectors} vectors`}</p>
      <table>
        <thead><tr><th>nIn</th><th>nOut</th><th>nState</th><th>NAND</th><th>LATCH</th><th>gates</th><th>depth d</th><th>area A</th><th>cost C = A·d³</th><th>bytes</th></tr></thead>
        <tbody><tr><td>{res.nIn}</td><td>{res.nOut}</td><td>{res.nState}</td><td>{m.nand}</td><td>{m.latch}</td><td>{m.gateCount}</td><td>{m.depth}</td><td>{m.area}</td><td>{m.cost}</td><td>{m.bytes}</td></tr></tbody>
      </table>
      <div className="row">
        <label>PoD task Cref <input value={cref} placeholder="e.g. 297" onChange={(e) => setCref(e.target.value)} /></label>
        {crefN > 0 && <span>q = <b>{podQuality(m.cost, crefN).toFixed(4)}</b> (clamped to 0.25…4)</span>}
      </div>

      <h3>Candidates</h3>
      <table>
        <thead><tr><th></th><th>flow</th><th>round</th><th>gates</th><th>depth</th><th>C</th></tr></thead>
        <tbody>
          {res.candidates.map((c, i) => (
            <tr key={i} className={c.selected ? 'sel' : ''}>
              <td>{c.selected ? '★' : ''}</td><td>{c.name}</td><td>{c.round}</td>
              {c.ok && c.metrics ? <><td>{c.metrics.gateCount}</td><td>{c.metrics.depth}</td><td>{c.metrics.cost}</td></> : <td colSpan={3} className="muted">failed: {c.error}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {res.warnings.map((w, i) => <p key={i} className="warn">⚠ {w}</p>)}

      <h3>Pins</h3>
      <p><b>inputs</b> (bit 0 first): {res.pins.inputs.map((p) => `${p.port}[${p.bit}]`).join(', ') || '—'}</p>
      <p><b>outputs</b>: {res.pins.outputs.map((p) => `${p.port}[${p.bit}]`).join(', ')}</p>
      {res.pins.clock && <p><b>clock</b>: {res.pins.clock} (one beat per edge; not an input)</p>}

      <Simulator key={res.netlist} res={res} />

      <h3>Netlist (TAP-02)</h3>
      <textarea readOnly value={res.netlist} rows={4} />
      <div className="row actions"><button onClick={() => download(res)}>Download .tsyn.json</button></div>
    </section>
  );
}
