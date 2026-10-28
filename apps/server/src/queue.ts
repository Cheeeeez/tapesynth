import { Worker } from 'node:worker_threads';
import type { SynthRequest, SynthResult } from '@tapesynth/synth';

export class SynthFailure extends Error {
  code: string;
  log: string;
  constructor(code: string, message: string, log = '') {
    super(message);
    this.name = 'SynthFailure';
    this.code = code;
    this.log = log;
  }
}

export type SynthRunner = (req: SynthRequest, timeoutMs: number) => Promise<SynthResult>;

export type WorkerReply = { ok: true; result: SynthResult } | { ok: false; code: string; message: string; log: string };

/** Runs each synthesis in its own worker thread so a runaway job can be terminated at its deadline. */
export function createWorkerRunner(): SynthRunner {
  const isTs = import.meta.url.endsWith('.ts');
  const file = new URL(isTs ? './worker.ts' : './worker.js', import.meta.url);
  return (req, timeoutMs) => {
    const { promise, resolve, reject } = Promise.withResolvers<SynthResult>();
    const worker = new Worker(file, { workerData: req, execArgv: isTs ? ['--import', 'tsx'] : [] });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new SynthFailure('timeout', `synthesis exceeded ${Math.round(timeoutMs / 1000)}s`))), timeoutMs);
    worker.once('message', (m: WorkerReply) =>
      finish(() => (m.ok ? resolve(m.result) : reject(new SynthFailure(m.code, m.message, m.log)))),
    );
    worker.once('error', (e) => finish(() => reject(new SynthFailure('worker-error', e.message))));
    worker.once('exit', (code) => finish(() => reject(new SynthFailure('worker-exit', `worker exited with code ${code}`))));
    return promise;
  };
}

/** FIFO limiter: at most `concurrency` tasks run at once. */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly concurrency: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiting.push(resolve);
      await promise;
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
