import { parseEventLogs, type Address, type Hex as VHex, type PublicClient, type WalletClient } from 'viem';
import { processorAbi, transistorsAbi } from './abi.js';
import { TRANSISTOR_LATCH, TRANSISTOR_NAND } from './constants.js';
import { waitOk } from './util.js';
import type { TsynFile } from '../index.js';

export type TapeoutPlan = {
  cpu: Address;
  transistors: Address;
  account: Address;
  nand: number;
  latch: number;
  tapeoutFee: bigint;
  mintPrice: bigint;
  protocolFee: bigint;
  balNand: bigint;
  balLatch: bigint;
  needNand: bigint;
  needLatch: bigint;
  remainingSupply: bigint;
  /** the processor cannot mint enough transistors; they must be bought on its market */
  soldOut: boolean;
  /** total native value required (tapeout fee + mints) */
  totalWei: bigint;
};

/** Read all fees live; nothing is hard-coded. */
export async function planTapeout(
  pc: PublicClient,
  p: { cpu: Address; account: Address; nand: number; latch: number },
): Promise<TapeoutPlan> {
  const transistors = await pc.readContract({ address: p.cpu, abi: processorAbi, functionName: 'transistors' });
  const [tapeoutFee, mintPrice, protocolFee, cap, minted, balNand, balLatch] = await Promise.all([
    pc.readContract({ address: p.cpu, abi: processorAbi, functionName: 'TAPEOUT_FEE' }),
    pc.readContract({ address: transistors, abi: transistorsAbi, functionName: 'mintPrice' }),
    pc.readContract({ address: transistors, abi: transistorsAbi, functionName: 'protocolFee' }),
    pc.readContract({ address: transistors, abi: transistorsAbi, functionName: 'supplyCap' }),
    pc.readContract({ address: transistors, abi: transistorsAbi, functionName: 'minted' }),
    pc.readContract({ address: transistors, abi: transistorsAbi, functionName: 'balanceOf', args: [p.account, TRANSISTOR_NAND] }),
    pc.readContract({ address: transistors, abi: transistorsAbi, functionName: 'balanceOf', args: [p.account, TRANSISTOR_LATCH] }),
  ]);
  const need = (want: number, bal: bigint) => (BigInt(want) > bal ? BigInt(want) - bal : 0n);
  const needNand = need(p.nand, balNand);
  const needLatch = need(p.latch, balLatch);
  const remainingSupply = cap > minted ? cap - minted : 0n;
  const mintCost = (n: bigint) => (n > 0n ? n * mintPrice + protocolFee : 0n);
  return {
    cpu: p.cpu, transistors, account: p.account, nand: p.nand, latch: p.latch,
    tapeoutFee, mintPrice, protocolFee, balNand, balLatch, needNand, needLatch, remainingSupply,
    soldOut: remainingSupply < needNand + needLatch,
    totalWei: tapeoutFee + mintCost(needNand) + mintCost(needLatch),
  };
}

export type TapeoutResult = { id: bigint; txHashes: VHex[] };

/**
 * 1) mint missing transistors (NAND then LATCH), 2) simulate `tapeout` so a revert reason surfaces
 * before the transaction is sent, 3) send it and read the circuit id from the TapedOut event.
 */
export async function executeTapeout(
  wc: WalletClient,
  pc: PublicClient,
  plan: TapeoutPlan,
  file: Pick<TsynFile, 'netlist' | 'nIn' | 'nOut'>,
  onProgress?: (msg: string) => void,
): Promise<TapeoutResult> {
  const account = wc.account;
  if (!account) throw new Error('wallet client has no account');
  const txHashes: VHex[] = [];
  const mint = async (id: bigint, need: bigint) => {
    if (need === 0n) return;
    onProgress?.(`minting ${need} ${id === TRANSISTOR_NAND ? 'NAND' : 'LATCH'} transistors`);
    const { request } = await pc.simulateContract({
      address: plan.transistors, abi: transistorsAbi, functionName: 'mint', args: [id, need],
      value: need * plan.mintPrice + plan.protocolFee, account,
    });
    const h = await wc.writeContract(request);
    txHashes.push(h);
    await waitOk(pc, h);
  };
  if (plan.needNand + plan.needLatch > 0n && plan.soldOut) throw new Error("sold-out: acquire transistors on the processor's market");
  await mint(TRANSISTOR_NAND, plan.needNand);
  await mint(TRANSISTOR_LATCH, plan.needLatch);

  onProgress?.('tape-out transaction');
  const { request } = await pc.simulateContract({
    address: plan.cpu, abi: processorAbi, functionName: 'tapeout',
    args: [file.netlist, file.nIn, file.nOut], value: plan.tapeoutFee, account,
  });
  const hash = await wc.writeContract(request);
  txHashes.push(hash);
  const receipt = await waitOk(pc, hash);
  const logs = parseEventLogs({ abi: processorAbi, eventName: 'TapedOut', logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === plan.cpu.toLowerCase(),
  );
  if (!logs.length) throw new Error(`no TapedOut event in ${hash}`);
  return { id: logs[0]!.args.circuitId, txHashes };
}
