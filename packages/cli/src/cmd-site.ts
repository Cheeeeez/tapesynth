import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { createKernel } from '@tapekit/kernel';
import type { Hex } from 'viem';
import {
  DOMAIN_BINDING, OPENER, SITE_REGISTRY, domainBindingAbi, openerAbi, processorAbi, processorNumber, siteRegistryAbi, waitOk,
} from '@tapesynth/core/chain';
import { okb, processorArg, publicClient, walletClient } from './common.js';

export const CHUNK = 24_000;
export const MAX_FILE = 350 * CHUNK; // 8,400,000 bytes (SPEC §5.2)

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
};

export type SiteFileEntry = { path: string; bytes: Uint8Array; contentType: string; sha256: Hex };

/** Walk `dir`, validate every path (ASCII, no `.`/`..` segments, size limit) and assign a content type by extension. `*.map` is skipped. */
export function collectSite(dir: string): SiteFileEntry[] {
  const out: SiteFileEntry[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.map')) continue;
      const path = relative(dir, full).split(sep).join('/');
      if (!/^[\x20-\x7e]+$/.test(path)) throw new Error(`non-ASCII path: ${path}`);
      if (path.split('/').some((s) => s === '.' || s === '..' || s === '')) throw new Error(`illegal path segment in ${path}`);
      const ext = extname(name).slice(1).toLowerCase();
      const contentType = CONTENT_TYPES[ext];
      if (!contentType) throw new Error(`no content type for .${ext} (${path})`);
      const bytes = readFileSync(full);
      if (bytes.length > MAX_FILE) throw new Error(`${path} is ${bytes.length} bytes; the limit is ${MAX_FILE}`);
      out.push({ path, bytes, contentType, sha256: `0x${createHash('sha256').update(bytes).digest('hex')}` });
    }
  };
  walk(dir);
  if (!out.some((f) => f.path === 'index.html')) throw new Error('the site needs an index.html at its root');
  return out;
}

export const chunkCount = (size: number) => Math.max(1, Math.ceil(size / CHUNK));

export async function cmdPublish(dir: string, o: { processor: string; id: string; months: string; dryRun?: boolean }) {
  const pc = publicClient();
  const cpu = await processorArg(pc, o.processor);
  const id = BigInt(o.id);
  const months = BigInt(o.months);
  const pnum = await processorNumber(pc, cpu);
  if (pnum === null) throw new Error(`${cpu} is not a processor of the factory`);
  const files = collectSite(dir);
  const [container, opened, owner, openFee, monthlyFee] = await Promise.all([
    pc.readContract({ address: OPENER, abi: openerAbi, functionName: 'accountOf', args: [cpu, id] }),
    pc.readContract({ address: OPENER, abi: openerAbi, functionName: 'isOpened', args: [cpu, id] }),
    pc.readContract({ address: cpu, abi: processorAbi, functionName: 'ownerOf', args: [id] }),
    pc.readContract({ address: OPENER, abi: openerAbi, functionName: 'FEE' }),
    pc.readContract({ address: DOMAIN_BINDING, abi: domainBindingAbi, functionName: 'monthlyFee' }),
  ]);
  const live = await pc.readContract({ address: DOMAIN_BINDING, abi: domainBindingAbi, functionName: 'isContainerLive', args: [container] }).catch(() => false);

  // which files need writing
  const todo: SiteFileEntry[] = [];
  for (const f of files) {
    const info = opened
      ? await pc.readContract({ address: SITE_REGISTRY, abi: siteRegistryAbi, functionName: 'fileInfo', args: [container, f.path] })
      : null;
    const same = info && info[4] > 0n && info[2].toLowerCase() === f.sha256 && info[0] === f.bytes.length;
    if (!same) todo.push(f);
  }
  // paths on chain but no longer local
  const local = new Set(files.map((f) => f.path));
  const stale: string[] = [];
  if (opened) {
    const n = await pc.readContract({ address: SITE_REGISTRY, abi: siteRegistryAbi, functionName: 'pathCount', args: [container] });
    for (let from = 0n; from < n; from += 200n) {
      const page = await pc.readContract({ address: SITE_REGISTRY, abi: siteRegistryAbi, functionName: 'pathsRange', args: [container, from, n - from < 200n ? n - from : 200n] });
      for (const p of page) if (!local.has(p)) stale.push(p);
    }
  }

  const name = `${id}.2.${pnum}.tape`;
  const totalBytes = todo.reduce((s, f) => s + f.bytes.length, 0);
  const totalChunks = todo.reduce((s, f) => s + chunkCount(f.bytes.length), 0);
  console.log(`site ${name}  processor ${cpu}  container ${container}${opened ? '' : ' (not opened yet)'}`);
  console.log(`files: ${files.length} total, ${todo.length} to write (${totalBytes} bytes, ${totalChunks} chunk txs), ${files.length - todo.length} unchanged, ${stale.length} to remove`);
  if (!opened) console.log(`open container: ${okb(openFee)}`);
  if (!live) console.log(`activate name for ${months} month(s): ${okb(months * monthlyFee)}`);
  console.log(`holder of #${id}: ${owner}`);

  if (o.dryRun) {
    if (todo.length) {
      // gas for the largest first chunk, extrapolated per chunk (each chunk is deployed as a small contract)
      const f = todo.reduce((a, b) => (b.bytes.length > a.bytes.length ? b : a));
      const first = f.bytes.subarray(0, CHUNK);
      const gas = await pc.estimateContractGas({
        address: SITE_REGISTRY, abi: siteRegistryAbi, functionName: 'putFile', args: [container, f.path, f.contentType, f.sha256, bytesHex(first)], account: owner,
      }).catch(() => null);
      const gasPrice = await pc.getGasPrice();
      if (gas !== null) {
        const perByte = Number(gas) / Math.max(first.length, 1);
        const est = BigInt(Math.ceil(perByte * totalBytes)) + 60_000n * BigInt(todo.length);
        console.log(`estimated gas ≈ ${est} (≈ ${okb(est * gasPrice)} at ${gasPrice} wei)`);
      } else console.log('gas estimate unavailable until the container is opened (the estimate simulates putFile as the holder)');
    }
    for (const f of todo) console.log(`  write  ${String(f.bytes.length).padStart(8)} B  ${chunkCount(f.bytes.length)} chunk(s)  ${f.path}`);
    for (const p of stale) console.log(`  remove ${p}`);
    return;
  }

  const wc = walletClient();
  const account = wc.account!;
  if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`wallet ${account.address} is not the holder (${owner}) of circuit #${id}`);

  if (!opened) {
    console.log('opening container…');
    const { request } = await pc.simulateContract({ address: OPENER, abi: openerAbi, functionName: 'open', args: [cpu, id], value: openFee, account });
    await waitOk(pc, await wc.writeContract(request));
  }
  for (const [i, f] of todo.entries()) {
    const chunks = chunkCount(f.bytes.length);
    console.log(`[${i + 1}/${todo.length}] ${f.path} (${f.bytes.length} B, ${chunks} chunk${chunks > 1 ? 's' : ''})`);
    const first = bytesHex(f.bytes.subarray(0, CHUNK));
    const put = await pc.simulateContract({ address: SITE_REGISTRY, abi: siteRegistryAbi, functionName: 'putFile', args: [container, f.path, f.contentType, f.sha256, first], account });
    await waitOk(pc, await wc.writeContract(put.request));
    for (let c = 1; c < chunks; c++) {
      const data = bytesHex(f.bytes.subarray(c * CHUNK, (c + 1) * CHUNK));
      const app = await pc.simulateContract({ address: SITE_REGISTRY, abi: siteRegistryAbi, functionName: 'appendChunk', args: [container, f.path, BigInt(c), data], account });
      await waitOk(pc, await wc.writeContract(app.request));
    }
  }
  for (const p of stale) {
    console.log(`removing ${p}`);
    const rm = await pc.simulateContract({ address: SITE_REGISTRY, abi: siteRegistryAbi, functionName: 'removeFile', args: [container, p], account });
    await waitOk(pc, await wc.writeContract(rm.request));
  }
  if (!live) {
    console.log(`activating ${name} for ${months} month(s)…`);
    const b = await pc.simulateContract({ address: DOMAIN_BINDING, abi: domainBindingAbi, functionName: 'bind', args: [name, container, months], value: months * monthlyFee, account });
    await waitOk(pc, await wc.writeContract(b.request));
  }
  console.log(`published.\n  https://${id}-2-${pnum}.tapekit.org/\n  tape://${name}/`);
}

const bytesHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString('hex')}`;

export async function cmdSiteVerify(name: string) {
  // XLAYER_RPC (e.g. a local fork) replaces the public node list for X Layer names, with a single-node quorum
  const rpc = process.env.XLAYER_RPC;
  const k = createKernel(rpc ? { rpcUrls: { xlayer: [rpc] }, quorum: 1 } : undefined);
  const res = await k.resolve(name, { fresh: true });
  console.log(`${name}: ${res.status}${res.container ? `  container ${res.container}` : ''}${res.paid !== undefined ? `  activated=${res.paid}` : ''}`);
  if (res.status !== 'ok') {
    process.exitCode = 1;
    return;
  }
  const site = await k.openSite(res);
  let bad = 0;
  for (const p of site.manifest.paths) {
    const f = await site.get(p);
    const status = f ? f.status : 'missing';
    const sha = f && 'sha256' in f ? f.sha256 : '-';
    if (status !== 'ok') bad++;
    console.log(`${status.padEnd(10)} ${sha}  ${p}`);
  }
  console.log(`${site.manifest.paths.length - bad}/${site.manifest.paths.length} files verified against the chain`);
  if (bad) process.exitCode = 1;
}

