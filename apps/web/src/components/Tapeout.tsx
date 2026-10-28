import { useCallback, useEffect, useState } from 'react';
import { formatEther, type Address } from 'viem';
import {
  executeTapeout, FAB_GENESIS, OKLINK_TX, planTapeout, transistorsAbi, verifyOnChain, waitOk,
  type TapeoutPlan, type VerifyOnChainResult,
} from '@tapesynth/core/chain';
import { connectWallet, parseProcessor, processorNumber, publicClient, type Wallet } from '../chain';
import type { Deployments, SynthResponse } from '../types';

type Choice = 'tapesynth' | 'fab' | 'custom';

type Props = { res: SynthResponse | null; deployments: Deployments; wallet: Wallet | null; setWallet: (w: Wallet) => void };

const errMsg = (e: unknown) => (e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e));

export function Tapeout({ res, deployments, wallet, setWallet }: Props) {
  const [choice, setChoice] = useState<Choice>(deployments.processor ? 'tapesynth' : 'fab');
  const [custom, setCustom] = useState('');
  const [plan, setPlan] = useState<TapeoutPlan | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ id: bigint; cpu: Address; pnum: number | null; txs: string[]; verify: VerifyOnChainResult } | null>(null);

  const cpuAddress = useCallback(async (): Promise<Address> => {
    if (choice === 'tapesynth') {
      if (!deployments.processor) throw new Error('TapeSynth processor is not deployed yet');
      return deployments.processor;
    }
    return choice === 'fab' ? FAB_GENESIS : parseProcessor(custom);
  }, [choice, custom, deployments.processor]);

  const refresh = useCallback(async () => {
    if (!res || !wallet) { setPlan(null); return; }
    try {
      setError('');
      setPlan(await planTapeout(publicClient, { cpu: await cpuAddress(), account: wallet.account, nand: res.metrics.nand, latch: res.metrics.latch }));
    } catch (e) {
      setPlan(null);
      setError(errMsg(e));
    }
  }, [res, wallet, cpuAddress]);
  useEffect(() => { void refresh(); }, [refresh]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const mint = (id: bigint, need: bigint) => guard(async () => {
    if (!plan || !wallet) return;
    const { request } = await publicClient.simulateContract({
      address: plan.transistors, abi: transistorsAbi, functionName: 'mint', args: [id, need],
      value: need * plan.mintPrice + plan.protocolFee, account: wallet.account,
    });
    await waitOk(publicClient, await wallet.client.writeContract(request));
    await refresh();
  });

  const tapeout = () => guard(async () => {
    if (!plan || !wallet || !res) return;
    const lines: string[] = [];
    const push = (m: string) => { lines.push(m); setLog([...lines]); };
    push('starting…');
    const result = await executeTapeout(wallet.client, publicClient, plan, res, push);
    push(`taped out as circuit #${result.id}; verifying on-chain…`);
    const verify = await verifyOnChain(publicClient, plan.cpu, result.id, res);
    const pnum = await processorNumber(plan.cpu);
    setDone({ id: result.id, cpu: plan.cpu, pnum, txs: result.txHashes, verify });
    await refresh();
  });

  if (!res) return <section><h2>Tape out</h2><p className="muted">Synthesize a design first.</p></section>;
  const connect = () => guard(async () => setWallet(await connectWallet()));
  const mintLabel = (n: bigint) => (n > 0n ? ` ${n}` : '');

  return (
    <section>
      <h2>Tape out on X Layer</h2>
      <div className="row">
        <button onClick={connect} disabled={busy}>{wallet ? `Wallet ${wallet.account.slice(0, 6)}…${wallet.account.slice(-4)}` : 'Connect wallet'}</button>
        <label>
          Processor
          <select value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
            <option value="tapesynth" disabled={!deployments.processor}>TapeSynth {deployments.processor ? `(${deployments.processor.slice(0, 6)}…${deployments.processor.slice(-4)})` : '(not deployed)'}</option>
            <option value="fab">FAB-Genesis ({FAB_GENESIS.slice(0, 6)}…{FAB_GENESIS.slice(-4)})</option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        {choice === 'custom' && <input value={custom} placeholder="address or number" onChange={(e) => setCustom(e.target.value)} onBlur={refresh} />}
      </div>

      {plan && (
        <table>
          <tbody>
            <tr><th>needs</th><td>{plan.nand} NAND + {plan.latch} LATCH (you hold {plan.balNand.toString()} / {plan.balLatch.toString()})</td></tr>
            <tr><th>tape-out fee</th><td>{formatEther(plan.tapeoutFee)} OKB</td></tr>
            <tr><th>mint</th><td>{plan.needNand.toString()} NAND + {plan.needLatch.toString()} LATCH @ {formatEther(plan.mintPrice)} OKB (+ {formatEther(plan.protocolFee)} OKB protocol fee per mint call)</td></tr>
            <tr><th>remaining supply</th><td>{plan.remainingSupply.toString()}</td></tr>
            <tr><th>total</th><td><b>{formatEther(plan.totalWei)} OKB</b></td></tr>
          </tbody>
        </table>
      )}
      {plan?.soldOut && <p className="warn">⚠ This processor cannot mint enough transistors (sold out). Buy transistors on the FabX market, or pick another processor.</p>}
      {plan && (
        <div className="row actions">
          <button disabled={busy || plan.soldOut || plan.needNand === 0n} onClick={() => mint(0n, plan.needNand)}>Mint NAND{mintLabel(plan.needNand)}</button>
          <button disabled={busy || plan.soldOut || plan.needLatch === 0n} onClick={() => mint(1n, plan.needLatch)}>Mint LATCH{mintLabel(plan.needLatch)}</button>
          <button className="pro" disabled={busy || plan.soldOut} onClick={tapeout}>Tape out (permanent)</button>
        </div>
      )}
      {error && <div className="error"><b>{error}</b></div>}
      {log.length > 0 && <pre>{log.join('\n')}</pre>}
      {done && (
        <div className="badge ok">
          <p>✓ circuit <b>#{done.id.toString()}{done.pnum !== null ? `@2.${done.pnum}` : ''}</b> on {done.cpu}</p>
          <p>on-chain verification: {done.verify.mismatches.length ? `FAILED — ${done.verify.mismatches.join('; ')}` : `${done.verify.matched}/${done.verify.calls} matched, netlist identical${done.verify.skipped ? ` (eval skipped: ${done.verify.skipped})` : ''}`}</p>
          {done.txs.map((h) => <p key={h}><a href={OKLINK_TX(h)} target="_blank" rel="noreferrer">tx {h.slice(0, 10)}…</a></p>)}
        </div>
      )}
    </section>
  );
}
