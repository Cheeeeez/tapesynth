import { useEffect, useState } from 'react';
import deploymentsJson from '../../../deployments/xlayer.json';
import { Design } from './components/Design';
import { Optimize } from './components/Optimize';
import { Results } from './components/Results';
import { Tapeout } from './components/Tapeout';
import { EXAMPLES } from './examples';
import type { DesignState } from './run';
import type { Wallet } from './chain';
import type { Deployments, OptimizeRun, SynthResponse } from './types';

const TABS = ['design', 'results', 'tapeout', 'optimize'] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { design: 'Design', results: 'Results', tapeout: 'Tape out', optimize: 'Optimize on-chain' };

const deployments = deploymentsJson as Deployments;

const readTab = (): Tab => {
  const h = location.hash.replace('#', '') as Tab;
  return TABS.includes(h) ? h : 'design';
};

const first = EXAMPLES.find((e) => e.name === 'spend_policy.v') ?? EXAMPLES[0];

export function App() {
  const [tab, setTab] = useState<Tab>(readTab);
  const [design, setDesign] = useState<DesignState>({
    kind: 'verilog', text: first?.source ?? '', top: '', clock: '', objective: 'area', example: first?.name ?? '', cpu: '', circuitId: '',
  });
  const [result, setResult] = useState<SynthResponse | null>(null);
  const [optimize, setOptimize] = useState<OptimizeRun | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);

  useEffect(() => {
    const on = () => setTab(readTab());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (t: Tab) => { location.hash = t; };

  const onResult = (r: SynthResponse, opt?: OptimizeRun) => {
    setResult(r);
    if (opt) setOptimize(opt);
    go('results');
  };
  const onOptimized = (r: SynthResponse, opt: OptimizeRun) => {
    setResult(r);
    setOptimize(opt);
  };

  return (
    <div className="app">
      <header>
        <h1>TapeSynth</h1>
        <p className="muted">Verilog / PLA / on-chain circuit → verified TAP-02 netlist → TapeOut on X Layer</p>
        <nav>
          {TABS.map((t) => <a key={t} href={`#${t}`} className={t === tab ? 'active' : ''}>{LABEL[t]}</a>)}
        </nav>
      </header>
      <main>
        {tab === 'design' && <Design design={design} setDesign={setDesign} wallet={wallet} setWallet={setWallet} onResult={onResult} />}
        {tab === 'results' && <Results res={result} />}
        {tab === 'tapeout' && <Tapeout res={result} deployments={deployments} wallet={wallet} setWallet={setWallet} />}
        {tab === 'optimize' && <Optimize run={optimize} wallet={wallet} setWallet={setWallet} onResult={onOptimized} />}
      </main>
      <footer className="muted">
        Open source (MIT). Netlists follow TAP-02. Taped-out circuits are immutable and cost real OKB — check the plan before you confirm.
      </footer>
    </div>
  );
}
