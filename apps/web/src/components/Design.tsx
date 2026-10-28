import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { formatEther } from 'viem';
import { ApiError, synthFree } from '../api';
import { connectWallet, type Wallet } from '../chain';
import { EXAMPLES } from '../examples';
import { runProJob } from '../pro';
import { prepare, type DesignState } from '../run';
import type { OptimizeRun, SynthResponse } from '../types';

const verilogLang = StreamLanguage.define(verilog);
export const PRO_PRICE_WEI = 5_000_000_000_000_000n;

type Props = {
  design: DesignState;
  setDesign: (d: DesignState) => void;
  wallet: Wallet | null;
  setWallet: (w: Wallet) => void;
  onResult: (r: SynthResponse, opt?: OptimizeRun) => void;
};

export function Design({ design, setDesign, wallet, setWallet, onResult }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<{ msg: string; log?: string } | null>(null);
  const set = (p: Partial<DesignState>) => setDesign({ ...design, ...p });

  const run = async (pro: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepare(design);
      let result: SynthResponse;
      if (pro) {
        const w = wallet ?? (await connectWallet());
        setWallet(w);
        result = await runProJob(prepared.body, w, setStatus);
      } else {
        setStatus('synthesizing…');
        result = await synthFree(prepared.body);
      }
      onResult(result, prepared.before && prepared.cpu && prepared.id !== undefined ? { cpu: prepared.cpu, id: prepared.id, before: prepared.before, result } : undefined);
      setStatus('');
    } catch (e) {
      setStatus('');
      setError({ msg: e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e), log: e instanceof ApiError ? e.log : undefined });
    } finally {
      setBusy(false);
    }
  };

  const pickExample = (name: string) => {
    const ex = EXAMPLES.find((x) => x.name === name);
    if (ex) set({ example: name, kind: ex.kind, text: ex.source, top: '' });
  };
  const freeObjective = design.objective !== 'pod';

  return (
    <section>
      <h2>Design</h2>
      <div className="row">
        <label>
          Input
          <select value={design.kind} onChange={(e) => set({ kind: e.target.value as DesignState['kind'] })}>
            <option value="verilog">Verilog</option>
            <option value="pla">PLA truth table</option>
            <option value="onchain">On-chain circuit</option>
          </select>
        </label>
        {design.kind !== 'onchain' && (
          <label>
            Example
            <select value={design.example} onChange={(e) => pickExample(e.target.value)}>
              <option value="">—</option>
              {EXAMPLES.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
        )}
        <label>
          Objective
          <select value={design.objective} onChange={(e) => set({ objective: e.target.value as DesignState['objective'] })}>
            <option value="area">area (fewest gates)</option>
            <option value="depth">depth (shortest path)</option>
            <option value="pod">pod (min C = A·d³) — Pro</option>
          </select>
        </label>
        {design.kind === 'verilog' && (
          <>
            <label>top <input value={design.top} placeholder="auto" onChange={(e) => set({ top: e.target.value })} /></label>
            <label>clock <input value={design.clock} placeholder="clk" onChange={(e) => set({ clock: e.target.value })} /></label>
          </>
        )}
      </div>

      {design.kind === 'onchain' ? (
        <div className="row">
          <label>processor (address or number) <input value={design.cpu} placeholder="0x… or 344" onChange={(e) => set({ cpu: e.target.value })} /></label>
          <label>circuit id <input value={design.circuitId} placeholder="1" onChange={(e) => set({ circuitId: e.target.value })} /></label>
          <p className="muted">The circuit is read from X Layer in your browser (REFs are flattened) and re-synthesized; the result is verified against the original netlist.</p>
        </div>
      ) : (
        <CodeMirror value={design.text} height="320px" extensions={design.kind === 'verilog' ? [verilogLang] : []} onChange={(v) => set({ text: v, example: '' })} />
      )}

      <div className="row actions">
        <button disabled={busy || !freeObjective} onClick={() => run(false)} title={freeObjective ? '' : 'pod objective is Pro only'}>Synthesize (Free)</button>
        <button className="pro" disabled={busy} onClick={() => run(true)}>Pro optimize ({formatEther(PRO_PRICE_WEI)} OKB)</button>
        {wallet && <span className="muted">wallet {wallet.account.slice(0, 6)}…{wallet.account.slice(-4)}</span>}
      </div>
      <p className="muted">Free: one ABC flow, ≤ 5,000 gates, 30 s. Pro: all flows plus up to 3 re-synthesis rounds, ≤ 50,000 gates, 120 s; paid in OKB on X Layer.</p>
      {status && <p className="status">{status}</p>}
      {error && <div className="error"><b>{error.msg}</b>{error.log && <pre>{error.log.slice(-4000)}</pre>}</div>}
    </section>
  );
}
