import type { SynthBody, SynthResponse } from './types';

export const API_URL = (import.meta.env.VITE_API_URL ?? 'https://tapesynth-api.fly.dev').replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  code: string;
  log?: string;
  constructor(status: number, code: string, message: string, log?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.log = log;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : `http-${res.status}`;
    throw new ApiError(res.status, code, typeof body.message === 'string' ? body.message : code, typeof body.log === 'string' ? body.log : undefined);
  }
  return body as T;
}

const jsonPost = (payload: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

export const synthFree = (b: SynthBody) => call<SynthResponse>('/v1/synth', jsonPost(b));

export type JobTicket = { jobId: `0x${string}`; priceWei: string; treasury: `0x${string}`; status: string };
export const createJob = (b: SynthBody) => call<JobTicket>('/v1/jobs', jsonPost(b));
export const submitPayment = (jobId: string, txHash: string) => call<{ status: string }>(`/v1/jobs/${jobId}/payment`, jsonPost({ txHash }));

export type JobState = {
  id: string;
  status: 'awaiting_payment' | 'queued' | 'running' | 'done' | 'failed';
  result?: SynthResponse;
  error?: { error?: string; message?: string; log?: string };
};
export const getJob = (jobId: string) => call<JobState>(`/v1/jobs/${jobId}`);
