import type { Address, Hex } from 'viem';

/** The subset of a viem PublicClient used for payment checks. */
export type ChainReader = {
  getTransaction(a: { hash: Hex }): Promise<{ to: Address | null; from: Address; value: bigint; input: Hex }>;
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }>;
  getBlockNumber(): Promise<bigint>;
};

export type PaymentCheck =
  | { ok: true; payer: Address }
  | { ok: false; status: 400 | 409; error: 'tx-not-found' | 'tx-failed' | 'wrong-recipient' | 'underpaid' | 'wrong-job-id' | 'not-enough-confirmations' };

export const MIN_CONFIRMATIONS = 2n;
export const JOB_PAYMENT_WINDOW_MS = 24 * 3600 * 1000;

/**
 * A Pro job is paid by a plain transfer to the treasury whose calldata is exactly the job id:
 * receipt successful, `to` = treasury, `value` >= price, `input` = jobId, >= 2 confirmations.
 * (Job state and tx-hash uniqueness are enforced by the caller against the database.)
 */
export async function checkPayment(
  chain: ChainReader,
  p: { jobId: string; txHash: Hex; treasury: Address; minValue: bigint },
): Promise<PaymentCheck> {
  let tx: Awaited<ReturnType<ChainReader['getTransaction']>>;
  let receipt: Awaited<ReturnType<ChainReader['getTransactionReceipt']>>;
  try {
    [tx, receipt] = await Promise.all([chain.getTransaction({ hash: p.txHash }), chain.getTransactionReceipt({ hash: p.txHash })]);
  } catch {
    return { ok: false, status: 400, error: 'tx-not-found' };
  }
  if (receipt.status !== 'success') return { ok: false, status: 400, error: 'tx-failed' };
  if (!tx.to || tx.to.toLowerCase() !== p.treasury.toLowerCase()) return { ok: false, status: 400, error: 'wrong-recipient' };
  if (tx.value < p.minValue) return { ok: false, status: 400, error: 'underpaid' };
  if (tx.input.toLowerCase() !== p.jobId.toLowerCase()) return { ok: false, status: 400, error: 'wrong-job-id' };
  const head = await chain.getBlockNumber();
  if (head - receipt.blockNumber + 1n < MIN_CONFIRMATIONS) return { ok: false, status: 400, error: 'not-enough-confirmations' };
  return { ok: true, payer: tx.from };
}
