import { defineChain, type Address, type Chain } from 'viem';
import { xLayer } from 'viem/chains';

export { xLayer };
export const XLAYER_CHAIN_ID = 196;

const env: Record<string, string | undefined> = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
export const DEFAULT_RPC = env.XLAYER_RPC || 'https://rpc.xlayer.tech';

/** viem chain object pointing at the configured RPC. */
export const xLayerChain = (rpc: string = DEFAULT_RPC): Chain =>
  defineChain({ ...xLayer, rpcUrls: { default: { http: [rpc] } } });

export const FACTORY: Address = '0x1f09DAeFA827f02CBb40967cc91b259763760761';
export const OPENER: Address = '0x536adD8F30f03b69f6fbF29d425A816A0dC50106';
export const SITE_REGISTRY: Address = '0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6';
export const DOMAIN_BINDING: Address = '0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9';
export const FAB_GENESIS: Address = '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6';

/** TAP-02 transistor ids on a processor's transistor token. */
export const TRANSISTOR_NAND = 0n;
export const TRANSISTOR_LATCH = 1n;

export const OKLINK_TX = (hash: string) => `https://www.oklink.com/xlayer/tx/${hash}`;
