import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicClient, http, isAddress, type PublicClient } from 'viem';
import { xLayerChain, DEFAULT_RPC } from '@tapesynth/core/chain';
import { yosysVersion } from '@tapesynth/synth';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { createWorkerRunner } from './queue.js';
import type { ChainReader } from './payments.js';

const env = process.env;
const treasury = env.TREASURY_ADDRESS;
if (!treasury || !isAddress(treasury)) {
  console.error('TREASURY_ADDRESS must be set to a valid address');
  process.exit(1);
}
const rpc = env.XLAYER_RPC || DEFAULT_RPC;
const dbPath = env.DB_PATH || './tapesynth.db';
mkdirSync(dirname(dbPath), { recursive: true });

const client = createPublicClient({ chain: xLayerChain(rpc), transport: http(rpc) }) as PublicClient;
const chain: ChainReader = client;

const { app, recover } = buildApp({
  db: openDb(dbPath),
  chain,
  runner: createWorkerRunner(),
  config: {
    treasury,
    priceWei: BigInt(env.PRO_JOB_PRICE_WEI || '5000000000000000'),
    concurrency: Number(env.SYNTH_CONCURRENCY || 2),
    yosysVersion,
  },
});
recover();
await app.listen({ host: '0.0.0.0', port: Number(env.PORT || 8080) });
console.log(`tapesynth api listening on :${env.PORT || 8080}`);
