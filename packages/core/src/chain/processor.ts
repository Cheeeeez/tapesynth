import { parseEventLogs, type Address, type PublicClient, type WalletClient } from 'viem';
import { factoryAbi } from './abi.js';
import { FACTORY } from './constants.js';
import { waitOk } from './util.js';

export type NewProcessor = { processor: Address; transistors: Address; processorNumber: bigint; txHash: `0x${string}`; deployFee: bigint };

/** factory.createCPU; the deploy fee is read live. */
export async function createProcessor(
  wc: WalletClient,
  pc: PublicClient,
  p: { name: string; symbol: string; story: string; supply: bigint; price: bigint },
): Promise<NewProcessor> {
  const account = wc.account;
  if (!account) throw new Error('wallet client has no account');
  const deployFee = await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'deployFee' });
  const { request } = await pc.simulateContract({
    address: FACTORY, abi: factoryAbi, functionName: 'createCPU', args: [p.name, p.symbol, p.story, p.supply, p.price], value: deployFee, account,
  });
  const txHash = await wc.writeContract(request);
  const receipt = await waitOk(pc, txHash);
  const ev = parseEventLogs({ abi: factoryAbi, eventName: 'CPUCreated', logs: receipt.logs }).find((l) => l.address.toLowerCase() === FACTORY.toLowerCase());
  if (!ev) throw new Error(`no CPUCreated event in ${txHash}`);
  const processor = ev.args.circuits;
  const count = await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'cpuCount' });
  for (let n = count - 1n; n >= 0n; n--) {
    const a = await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'cpuAt', args: [n] });
    if (a.toLowerCase() === processor.toLowerCase()) return { processor, transistors: ev.args.transistors, processorNumber: n, txHash, deployFee };
  }
  throw new Error(`processor ${processor} not found in factory.cpuAt`);
}
