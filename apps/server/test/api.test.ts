import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import type { SynthRequest, SynthResult } from '@tapesynth/synth';
import { buildApp, FREE_LIMITS } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createWorkerRunner, SynthFailure, type SynthRunner } from '../src/queue.js';
import type { ChainReader } from '../src/payments.js';

const ex = (n: string) => readFileSync(new URL(`../../../examples/${n}`, import.meta.url), 'utf8');
const TREASURY = '0x00000000000000000000000000000000000000aa' as Address;
const PRICE = 5_000_000_000_000_000n;

type Tx = { to: Address | null; from: Address; value: bigint; input: Hex; status: 'success' | 'reverted'; blockNumber: bigint };
function fakeChain(txs: Map<string, Tx>, head = 1000n): ChainReader {
  const get = (h: Hex) => {
    const t = txs.get(h);
    if (!t) throw new Error('not found');
    return t;
  };
  return {
    getTransaction: async ({ hash }) => get(hash),
    getTransactionReceipt: async ({ hash }) => get(hash),
    getBlockNumber: async () => head,
  };
}

const fakeResult = (gates: number): SynthResult => ({
  format: 'tapesynth/1', netlist: '0x', nIn: 1, nOut: 1, nState: 0,
  pins: { inputs: [], outputs: [], clock: null },
  metrics: { nand: gates, latch: 0, gateCount: gates, nState: 0, depth: 1, area: gates, cost: gates, bytes: 0 },
  verification: { reference: 'pre-abc', method: 'exhaustive', vectors: 2, sequences: 0, beats: 0, passed: true },
  synth: { version: 't', yosys: null, objective: 'area', candidate: 'default', sourceKind: 'verilog', sourceSha256: '00' },
  candidates: [], warnings: [], log: 'LOG',
});

function setup(runner: SynthRunner, txs = new Map<string, Tx>(), head = 1000n) {
  const db = openDb(':memory:');
  const { app } = buildApp({ db, chain: fakeChain(txs, head), runner, config: { treasury: TREASURY, priceWei: PRICE, concurrency: 2, yosysVersion: async () => 'yosys-test' } });
  return { app, db, txs };
}
const body = { kind: 'verilog', source: 'module m(input a, output y); assign y=a; endmodule', objective: 'area' };
const waitDone = async (app: ReturnType<typeof setup>['app'], id: string) => {
  for (let i = 0; i < 100; i++) {
    const r = (await app.inject({ method: 'GET', url: `/v1/jobs/${id}` })).json();
    if (r.status === 'done' || r.status === 'failed') return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
};

describe('free synth', () => {
  it('health + real worker-thread synthesis of a PLA (exhaustive verification)', async () => {
    const { app } = setup(createWorkerRunner());
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).json()).toEqual({ ok: true, yosys: 'yosys-test' });
    const r = await app.inject({ method: 'POST', url: '/v1/synth', payload: { kind: 'pla', source: ex('xor3.pla'), objective: 'area' } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.verification).toMatchObject({ method: 'exhaustive', reference: 'pla', passed: true });
    expect(j.log).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/v1/stats' })).json()).toMatchObject({ freeSynth: 1, proJobs: 0, uniquePayers: 0 });
  });

  it('pod objective is pro-only (402); bad input 400; oversized source and oversized result 413', async () => {
    const { app } = setup(async () => fakeResult(FREE_LIMITS.gates + 1));
    expect((await app.inject({ method: 'POST', url: '/v1/synth', payload: { ...body, objective: 'pod' } })).statusCode).toBe(402);
    expect((await app.inject({ method: 'POST', url: '/v1/synth', payload: { ...body, kind: 'vhdl' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/synth', payload: { ...body, top: 'm; write_file x' } })).statusCode).toBe(400);
    const big = await app.inject({ method: 'POST', url: '/v1/synth', payload: { ...body, source: 'x'.repeat(FREE_LIMITS.sourceBytes + 1) } });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: 'free-limit', limit: 'source-bytes' });
    const res = await app.inject({ method: 'POST', url: '/v1/synth', payload: body });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'free-limit', limit: 'gates' });
  });

  it('synth failures are 422 with the last 20 KB of the log', async () => {
    const { app } = setup(async () => { throw new SynthFailure('yosys-failed', 'syntax', 'a'.repeat(30_000) + 'END'); });
    const r = await app.inject({ method: 'POST', url: '/v1/synth', payload: body });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('yosys-failed');
    expect(r.json().log.length).toBe(20 * 1024);
    expect(r.json().log.endsWith('END')).toBe(true);
  });
});

describe('worker runner', () => {
  it('terminates a job at its deadline', async () => {
    const run = createWorkerRunner();
    const req: SynthRequest = { kind: 'verilog', source: ex('spend_policy.v'), objective: 'pod', tier: 'pro' };
    await expect(run(req, 30)).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('pro jobs and payment checks', () => {
  const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
  const payer = '0x00000000000000000000000000000000000000bb' as Address;
  const create = async (app: ReturnType<typeof setup>['app']) => (await app.inject({ method: 'POST', url: '/v1/jobs', payload: { ...body, objective: 'pod' } })).json() as { jobId: Hex; priceWei: string; treasury: Address; status: string };
  const pay = (app: ReturnType<typeof setup>['app'], id: string, tx: Hex) => app.inject({ method: 'POST', url: `/v1/jobs/${id}/payment`, payload: { txHash: tx } });
  const goodTx = (jobId: Hex, over: Partial<Tx> = {}): Tx => ({ to: TREASURY, from: payer, value: PRICE, input: jobId, status: 'success', blockNumber: 990n, ...over });

  it('happy path: create -> pay -> queued -> done; same tx cannot pay a second job (409)', async () => {
    const { app, txs } = setup(async (req) => { expect(req.tier).toBe('pro'); return fakeResult(10); });
    const job = await create(app);
    expect(job).toMatchObject({ status: 'awaiting_payment', priceWei: PRICE.toString(), treasury: TREASURY });
    expect(job.jobId).toMatch(/^0x[0-9a-f]{64}$/);
    txs.set(hash(1), goodTx(job.jobId));
    const ok = await pay(app, job.jobId, hash(1));
    expect(ok.statusCode).toBe(200);
    const done = await waitDone(app, job.jobId);
    expect(done.status).toBe('done');
    expect(done.result.metrics.gateCount).toBe(10);
    expect(done.result.log).toBeUndefined();

    expect((await pay(app, job.jobId, hash(1))).statusCode).toBe(409); // job already paid
    const job2 = await create(app);
    txs.set(hash(1), goodTx(job2.jobId)); // pretend same hash carries job2 too: must still be rejected as reused
    const reuse = await pay(app, job2.jobId, hash(1));
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error).toBe('tx-already-used');
    expect((await app.inject({ method: 'GET', url: '/v1/stats' })).json()).toMatchObject({ proJobs: 1, uniquePayers: 1 });
  });

  it('rejects wrong recipient, underpayment, wrong calldata, reverted tx, unknown tx, <2 confirmations', async () => {
    const { app, txs } = setup(async () => fakeResult(1));
    const job = await create(app);
    const cases: [number, Partial<Tx>, string][] = [
      [10, { to: payer }, 'wrong-recipient'],
      [11, { value: PRICE - 1n }, 'underpaid'],
      [12, { input: `0x${'11'.repeat(32)}` }, 'wrong-job-id'],
      [13, { status: 'reverted' }, 'tx-failed'],
      [14, { blockNumber: 1000n }, 'not-enough-confirmations'],
    ];
    for (const [n, over, err] of cases) {
      txs.set(hash(n), goodTx(job.jobId, over));
      const r = await pay(app, job.jobId, hash(n));
      expect(r.statusCode, err).toBe(400);
      expect(r.json().error).toBe(err);
    }
    expect((await pay(app, job.jobId, hash(99))).json().error).toBe('tx-not-found');
    // still unpaid, and a correct payment afterwards works
    txs.set(hash(20), goodTx(job.jobId));
    expect((await pay(app, job.jobId, hash(20))).statusCode).toBe(200);
  });

  it('expired jobs (> 24 h) cannot be paid; unknown job is 404', async () => {
    const { app, db, txs } = setup(async () => fakeResult(1));
    const job = await create(app);
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(Date.now() - 25 * 3600 * 1000, job.jobId);
    txs.set(hash(30), goodTx(job.jobId));
    const r = await pay(app, job.jobId, hash(30));
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('job-expired');
    expect((await pay(app, `0x${'00'.repeat(32)}`, hash(30))).statusCode).toBe(404);
  });

  it('a failing job ends as failed with the error code', async () => {
    const { app, txs } = setup(async () => { throw new SynthFailure('verification-failed', 'nope'); });
    const job = await create(app);
    txs.set(hash(40), goodTx(job.jobId));
    await pay(app, job.jobId, hash(40));
    const done = await waitDone(app, job.jobId);
    expect(done.status).toBe('failed');
    expect(done.error.error).toBe('verification-failed');
  });
});
