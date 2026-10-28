import { formatEther } from 'viem';
import { ApiError, createJob, getJob, submitPayment } from './api';
import { publicClient, type Wallet } from './chain';
import type { SynthBody, SynthResponse } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pro job: create a job, pay the treasury with the job id as calldata, hand the tx hash to the
 * API (retrying until it has 2 confirmations) and poll until the job is done.
 */
export async function runProJob(body: SynthBody, wallet: Wallet, onStatus: (s: string) => void): Promise<SynthResponse> {
  onStatus('creating job…');
  const ticket = await createJob(body);
  onStatus(`confirm ${formatEther(BigInt(ticket.priceWei))} OKB in your wallet…`);
  const hash = await wallet.client.sendTransaction({
    account: wallet.account, chain: wallet.client.chain, to: ticket.treasury, value: BigInt(ticket.priceWei), data: ticket.jobId,
  });
  onStatus('waiting for the payment to confirm…');
  await publicClient.waitForTransactionReceipt({ hash });
  for (let attempt = 0; ; attempt++) {
    try {
      await submitPayment(ticket.jobId, hash);
      break;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not-enough-confirmations' && attempt < 20) {
        await sleep(2000);
        continue;
      }
      throw e;
    }
  }
  for (;;) {
    const job = await getJob(ticket.jobId);
    onStatus(`job ${job.status}…`);
    if (job.status === 'done' && job.result) return job.result;
    if (job.status === 'failed') throw new ApiError(422, job.error?.error ?? 'failed', job.error?.message ?? 'job failed', job.error?.log);
    await sleep(2000);
  }
}
