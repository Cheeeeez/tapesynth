import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { config as loadEnv } from 'dotenv';
import { createPublicClient, createWalletClient, formatEther, http, type Address, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assertTsyn, type Pins, type TsynFile } from '@tapesynth/core';
import { DEFAULT_RPC, resolveProcessor, xLayerChain } from '@tapesynth/core/chain';

loadEnv();

export const rpcUrl = () => process.env.XLAYER_RPC || DEFAULT_RPC;

export function publicClient(): PublicClient {
  return createPublicClient({ chain: xLayerChain(rpcUrl()), transport: http(rpcUrl()) }) as PublicClient;
}

export function walletClient(): WalletClient {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY is not set (put it in .env)');
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  return createWalletClient({ account, chain: xLayerChain(rpcUrl()), transport: http(rpcUrl()) });
}

export const processorArg = (pc: PublicClient, ref: string): Promise<Address> => resolveProcessor(pc, ref);

export function readTsyn(path: string): TsynFile {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  assertTsyn(j);
  return j;
}

export function writeJson(path: string, v: unknown) {
  writeFileSync(path, JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n');
}

export const okb = (wei: bigint) => `${formatEther(wei)} OKB`;

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

/** Group pin bits by port name (declaration order); value is LSB-first. */
export function decodePorts(pins: Pins['outputs'], bits: ArrayLike<number>): string[] {
  const groups = new Map<string, number[]>();
  pins.forEach((p, i) => {
    const g = groups.get(p.port) ?? [];
    g[p.bit] = bits[i] ? 1 : 0;
    groups.set(p.port, g);
  });
  return [...groups].map(([port, g]) => {
    let v = 0n;
    g.forEach((b, i) => { if (b) v |= 1n << BigInt(i); });
    return `${port}=${g.length > 1 ? `0x${v.toString(16)}` : v.toString()}`;
  });
}

export const deploymentsPath = (override?: string) => override ?? 'deployments/xlayer.json';

export type Deployments = {
  processor: Address | null;
  transistors: Address | null;
  processorNumber: number | null;
  circuits: { id: number; name: string; file: string; txHash?: string }[];
  siteCircuitId: number | null;
};

export function readDeployments(path: string): Deployments {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Deployments)
    : { processor: null, transistors: null, processorNumber: null, circuits: [], siteCircuitId: null };
}
