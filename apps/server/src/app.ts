import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { Address, Hex } from 'viem';
import type { SynthRequest, SynthResult } from '@tapesynth/synth';
import { bumpUsage, readStats, type Db, type JobRow } from './db.js';
import { checkPayment, JOB_PAYMENT_WINDOW_MS, type ChainReader } from './payments.js';
import { Limiter, SynthFailure, type SynthRunner } from './queue.js';

export const FREE_LIMITS = { sourceBytes: 256 * 1024, gates: 5_000, timeoutMs: 30_000 } as const;
export const PRO_LIMITS = { sourceBytes: 1024 * 1024, gates: 50_000, timeoutMs: 120_000 } as const;
const LOG_TAIL = 20 * 1024;

export type AppConfig = {
  treasury: Address;
  priceWei: bigint;
  concurrency: number;
  yosysVersion: () => Promise<string>;
};

export type AppDeps = { db: Db; config: AppConfig; chain: ChainReader; runner: SynthRunner };

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/;
const KINDS = ['verilog', 'pla', 'netlist'] as const;
const OBJECTIVES = ['area', 'depth', 'pod'] as const;

type Parsed = { ok: true; req: Omit<SynthRequest, 'tier'> } | { ok: false; status: number; body: Record<string, unknown> };

function parseBody(body: unknown, maxSourceBytes: number): Parsed {
  const bad = (error: string): Parsed => ({ ok: false, status: 400, body: { error } });
  if (typeof body !== 'object' || body === null) return bad('bad-request');
  const { kind, source, top, clock, objective } = body as Record<string, unknown>;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return bad('bad-kind');
  if (typeof source !== 'string' || source.length === 0) return bad('bad-source');
  if (typeof objective !== 'string' || !(OBJECTIVES as readonly string[]).includes(objective)) return bad('bad-objective');
  if (top !== undefined && top !== null && (typeof top !== 'string' || !IDENT.test(top))) return bad('bad-top');
  if (clock !== undefined && clock !== null && (typeof clock !== 'string' || !IDENT.test(clock))) return bad('bad-clock');
  if (Buffer.byteLength(source) > maxSourceBytes) {
    return { ok: false, status: 413, body: { error: 'free-limit', limit: 'source-bytes', max: maxSourceBytes } };
  }
  return {
    ok: true,
    req: {
      kind: kind as SynthRequest['kind'], source, objective: objective as SynthRequest['objective'],
      ...(typeof top === 'string' ? { top } : {}), ...(typeof clock === 'string' ? { clock } : {}),
    },
  };
}

const tail = (log: string) => (log.length > LOG_TAIL ? log.slice(-LOG_TAIL) : log);

function failureBody(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof SynthFailure) {
    return { status: e.code === 'timeout' ? 408 : 422, body: { error: e.code, message: e.message, log: tail(e.log) } };
  }
  return { status: 500, body: { error: 'internal', message: e instanceof Error ? e.message : String(e) } };
}

/** Result without the (large) Yosys log. */
const publicResult = ({ log: _log, ...rest }: SynthResult) => rest;

export type TapeSynthApp = { app: FastifyInstance; recover(): void };

export function buildApp(deps: AppDeps): TapeSynthApp {
  const { db, config, chain, runner } = deps;
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: PRO_LIMITS.sourceBytes + 4096 });
  const limiter = new Limiter(config.concurrency);

  void app.register(cors, { origin: '*' });
  void app.register(rateLimit, { global: false });
  const synthLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/v1/health', async () => ({ ok: true, yosys: await config.yosysVersion() }));

  app.post('/v1/synth', synthLimit, async (req, reply) => {
    const parsed = parseBody(req.body, FREE_LIMITS.sourceBytes);
    if (!parsed.ok) return reply.code(parsed.status).send(parsed.body);
    if (parsed.req.objective === 'pod') return reply.code(402).send({ error: 'pro-only' });
    try {
      const result = await limiter.run(() => runner({ ...parsed.req, tier: 'free' }, FREE_LIMITS.timeoutMs));
      if (result.metrics.gateCount > FREE_LIMITS.gates) {
        return reply.code(413).send({ error: 'free-limit', limit: 'gates', max: FREE_LIMITS.gates });
      }
      bumpUsage(db, 'free_synth');
      return publicResult(result);
    } catch (e) {
      const f = failureBody(e);
      return reply.code(f.status).send(f.body);
    }
  });

  app.post('/v1/jobs', synthLimit, async (req, reply) => {
    const parsed = parseBody(req.body, PRO_LIMITS.sourceBytes);
    if (!parsed.ok) return reply.code(parsed.status).send(parsed.body);
    const jobId = `0x${randomBytes(32).toString('hex')}`;
    db.prepare('INSERT INTO jobs(id, created_at, status, request_json, price_wei) VALUES(?, ?, ?, ?, ?)').run(
      jobId, Date.now(), 'awaiting_payment', JSON.stringify(parsed.req), config.priceWei.toString(),
    );
    return { jobId, priceWei: config.priceWei.toString(), treasury: config.treasury, status: 'awaiting_payment' };
  });

  const getJob = (id: string) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id.toLowerCase()) as JobRow | undefined;

  app.post<{ Params: { id: string }; Body: { txHash?: unknown } }>('/v1/jobs/:id/payment', async (req, reply) => {
    const job = getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'no-such-job' });
    const txHash = req.body?.txHash;
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return reply.code(400).send({ error: 'bad-tx-hash' });
    if (job.status !== 'awaiting_payment') return reply.code(409).send({ error: 'job-not-awaiting-payment', status: job.status });
    if (Date.now() - job.created_at > JOB_PAYMENT_WINDOW_MS) return reply.code(400).send({ error: 'job-expired' });
    const used = db.prepare('SELECT 1 FROM jobs WHERE tx_hash = ?').get(txHash.toLowerCase());
    if (used) return reply.code(409).send({ error: 'tx-already-used' });

    const check = await checkPayment(chain, { jobId: job.id, txHash: txHash as Hex, treasury: config.treasury, minValue: BigInt(job.price_wei) });
    if (!check.ok) return reply.code(check.status).send({ error: check.error });

    // Atomic claim: only one request can move the job out of awaiting_payment, and tx_hash is UNIQUE.
    try {
      const r = db
        .prepare("UPDATE jobs SET status = 'queued', payer = ?, tx_hash = ? WHERE id = ? AND status = 'awaiting_payment'")
        .run(check.payer.toLowerCase(), txHash.toLowerCase(), job.id);
      if (r.changes !== 1) return reply.code(409).send({ error: 'job-not-awaiting-payment' });
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.code(409).send({ error: 'tx-already-used' });
      throw e;
    }
    bumpUsage(db, 'pro_job');
    void runJob(job.id);
    return { jobId: job.id, status: 'queued' };
  });

  async function runJob(id: string) {
    await limiter.run(async () => {
      const row = getJob(id);
      if (!row || row.status !== 'queued') return;
      db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(id);
      try {
        const result = await runner({ ...(JSON.parse(row.request_json) as Omit<SynthRequest, 'tier'>), tier: 'pro' }, PRO_LIMITS.timeoutMs);
        if (result.metrics.gateCount > PRO_LIMITS.gates) throw new SynthFailure('pro-limit', `result has more than ${PRO_LIMITS.gates} gates`);
        db.prepare("UPDATE jobs SET status = 'done', result_json = ? WHERE id = ?").run(JSON.stringify(publicResult(result)), id);
      } catch (e) {
        const f = failureBody(e).body;
        db.prepare("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?").run(JSON.stringify(f), id);
      }
    });
  }

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const job = getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'no-such-job' });
    return {
      id: job.id,
      status: job.status,
      priceWei: job.price_wei,
      createdAt: job.created_at,
      ...(job.tx_hash ? { txHash: job.tx_hash } : {}),
      ...(job.result_json ? { result: JSON.parse(job.result_json) } : {}),
      ...(job.error ? { error: JSON.parse(job.error) } : {}),
    };
  });

  app.get('/v1/stats', async () => readStats(db));

  /** Re-queue paid jobs that were interrupted by a restart. */
  const recover = () => {
    db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run();
    for (const r of db.prepare("SELECT id FROM jobs WHERE status = 'queued'").all() as { id: string }[]) void runJob(r.id);
  };
  return { app, recover };
}
