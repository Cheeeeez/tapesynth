import { createPublicClient, createWalletClient, custom, http, type Address, type PublicClient, type WalletClient } from 'viem';
import { DEFAULT_RPC, factoryAbi, FACTORY, resolveProcessor, xLayerChain } from '@tapesynth/core/chain';

export const XLAYER_HEX_ID = '0xc4'; // 196

export const publicClient: PublicClient = createPublicClient({ chain: xLayerChain(DEFAULT_RPC), transport: http(DEFAULT_RPC) }) as PublicClient;

export type Wallet = { client: WalletClient; account: Address };

/** Connect an injected wallet (OKX Wallet / MetaMask) and make sure it is on X Layer. */
export async function connectWallet(): Promise<Wallet> {
  const eth = window.ethereum;
  if (!eth) throw new Error('No injected wallet found. Open this page in OKX Wallet or install a browser wallet.');
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
  if (!accounts.length) throw new Error('Wallet returned no account');
  await ensureXLayer(eth);
  const client = createWalletClient({ account: accounts[0], chain: xLayerChain(DEFAULT_RPC), transport: custom(eth) });
  return { client, account: accounts[0]! };
}

async function ensureXLayer(eth: EthereumProvider) {
  const current = (await eth.request({ method: 'eth_chainId' })) as string;
  if (current.toLowerCase() === XLAYER_HEX_ID) return;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: XLAYER_HEX_ID }] });
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code: number }).code : 0;
    if (code !== 4902 && code !== -32603) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: XLAYER_HEX_ID, chainName: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
        rpcUrls: [DEFAULT_RPC], blockExplorerUrls: ['https://www.oklink.com/xlayer'],
      }],
    });
  }
}

/** Processor address or number (number goes through factory.cpuAt). */
export const parseProcessor = (ref: string): Promise<Address> => resolveProcessor(publicClient, ref.trim());

/** Processor number P such that factory.cpuAt(P) = cpu (scans backwards; newest first). */
export async function processorNumber(cpu: Address): Promise<number | null> {
  const count = await publicClient.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'cpuCount' });
  for (let n = count - 1n; n >= 0n; n--) {
    const a = await publicClient.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'cpuAt', args: [n] });
    if (a.toLowerCase() === cpu.toLowerCase()) return Number(n);
  }
  return null;
}
