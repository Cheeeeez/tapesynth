import { useState } from 'react';
import { podQuality, type Metrics } from '@tapesynth/core';
import { formatEther } from 'viem';
import { ApiError, synthFree } from '../api';
import { connectWallet, type Wallet } from '../chain';
import { runProJob } from '../pro';
import { prepare } from '../run';
import { PRO_PRICE_WEI } from './Design';
import type { Objective, OptimizeRun, SynthResponse } from '../types';

type Props = {
  run: OptimizeRun | null;
  wallet: Wallet | null;
  setWallet: (w: Wallet) => void;
  onResult: (r: SynthResponse, opt: OptimizeRun) => void;
};

const pct = (a: number, b: number) => (a ? `${(((b - a) / a) * 100).toFixed(1)}%` : '—');

function Row({ label, a, b }: { label: string; a: number; b: number }) {
  return <tr><th>{label}</th><td>{a}</td><td>{b}</td><td className={b < a ? 'good' : ''}>{pct(a, b)}</td></tr>;
}

export function Optimize({ run, wallet, setWallet, onResult }: Props) {
  const [cpu, setCpu] = useState('');
  const [id, setId] = useState('');
  const [objective, setObjective] = useState<Objective>('pod');
  const [cref, setCref] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const go = async (pro: boolean) => {
    setBusy(true);
    setError('');
    try {
      setStatus('reading the circuit from X Layer…');
      const p = await prepare({ kind: 'onchain', text: '', top: '', clock: '', objective, example: '', cpu, circuitId: id });
      let result: SynthResponse;
      if (pro) {
        const w = wallet ?? (await connectWallet());
        setWallet(w);
        result = await runProJob(p.body, w, setStatus);
      } else {
        setStatus('re-synthesizing…');
        result = await synthFree(p.body);
      }
      onResult(result, { cpu: p.cpu!, id: p.id!, before: p.before!, result });
      setStatus('');
    } catch (e) {
      setStatus('');
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const before: Metrics | undefined = run?.before;
  const after = run?.result.metrics;
  const crefN = Number(cref) > 0 ? Number(cref) : before?.cost ?? 0;

  return (
    <section>
      <h2>Optimize an on-chain circuit</h2>
      <div className="row">
        <label>processor (address or number) <input value={cpu} placeholder="0x… or 344" onChange={(e) => setCpu(e.target.value)} /></label>
        <label>circuit id <input value={id} placeholder="1" onChange={(e) => setId(e.target.value)} /></label>
        <label>
          Objective
          <select value={objective} onChange={(e) => setObjective(e.target.value as Objective)}>
            <option value="area">area</option><option value="depth">depth</option><option value="pod">pod (Pro)</option>
          </select>
        </label>
      </div>
      <div className="row actions">
        <button disabled={busy || objective === 'pod'} onClick={() => go(false)}>Optimize (Free)</button>
        <button className="pro" disabled={busy} onClick={() => go(true)}>Optimize (Pro, {formatEther(PRO_PRICE_WEI)} OKB)</button>
      </div>
      {status && <p className="status">{status}</p>}
      {error && <div className="error"><b>{error}</b></div>}
      {run && before && after && (
        <>
          <p className="badge ok">✓ {run.cpu} #{run.id.toString()} → re-synthesized and verified against the original netlist ({run.result.verification.method}, {run.result.verification.sequences ? `${run.result.verification.sequences}×${run.result.verification.beats}` : run.result.verification.vectors})</p>
          <table>
            <thead><tr><th></th><th>before</th><th>after</th><th>change</th></tr></thead>
            <tbody>
              <Row label="gateCount" a={before.gateCount} b={after.gateCount} />
              <Row label="depth d" a={before.depth} b={after.depth} />
              <Row label="area A" a={before.area} b={after.area} />
              <Row label="cost C" a={before.cost} b={after.cost} />
            </tbody>
          </table>
          <div className="row">
            <label>Cref (task reference) <input value={cref} placeholder={String(before.cost)} onChange={(e) => setCref(e.target.value)} /></label>
            <span>q before <b>{podQuality(before.cost, crefN).toFixed(4)}</b> → after <b>{podQuality(after.cost, crefN).toFixed(4)}</b></span>
          </div>
          <p className="muted">Open the Results tab to simulate the new netlist or tape it out.</p>
        </>
      )}
    </section>
  );
}
