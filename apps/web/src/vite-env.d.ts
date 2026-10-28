/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}
interface EthereumProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}
interface Window {
  ethereum?: EthereumProvider;
}
