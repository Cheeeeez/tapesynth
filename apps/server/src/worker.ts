import { parentPort, workerData } from 'node:worker_threads';
import { synthesize, SynthError, type SynthRequest } from '@tapesynth/synth';
import type { WorkerReply } from './queue.js';

function describe(e: unknown): { code: string; message: string; log: string } {
  if (e instanceof SynthError) return { code: e.code, message: e.message, log: e.log };
  if (e instanceof Error && 'code' in e && typeof e.code === 'string') return { code: e.code, message: e.message, log: '' };
  return { code: 'synth-failed', message: e instanceof Error ? e.message : String(e), log: '' };
}

let reply: WorkerReply;
try {
  reply = { ok: true, result: await synthesize(workerData as SynthRequest) };
} catch (e) {
  reply = { ok: false, ...describe(e) };
}
parentPort!.postMessage(reply);
