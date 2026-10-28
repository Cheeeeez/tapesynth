import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PublicClient } from 'viem';
import {
  createProcessor, executeTapeout, planTapeout, processorNumber, verifyOnChain, OKLINK_TX,
  type TapeoutPlan, type VerifyOnChainResult,
} from '@tapesynth/core/chain';
import {
  confirm, deploymentsPath, okb, processorArg, publicClient, readDeployments, readTsyn, walletClient, writeJson,
} from './common.js';

export async function cmdProcessorCreate(o: { name: string; symbol: string; story: string; supply: string; price: string; deployments?: string }) {
  const wc = walletClient();
  const pc = publicClient();
  console.log(`creating processor "${o.name}" (${o.symbol}); supply ${o.supply}, mint price ${okb(BigInt(o.price))} per transistor (fixed forever)`);
  const r = await createProcessor(wc, pc, { name: o.name, symbol: o.symbol, story: o.story, supply: BigInt(o.supply), price: BigInt(o.price) });
  const path = deploymentsPath(o.deployments);
  mkdirSync(dirname(path), { recursive: true });
  const d = readDeployments(path);
  writeJson(path, { ...d, processor: r.processor, transistors: r.transistors, processorNumber: Number(r.processorNumber) });
  console.log(`processor ${r.processor}  (#${r.processorNumber})  transistors ${r.transistors}`);
  console.log(`deploy fee ${okb(r.deployFee)}  tx ${OKLINK_TX(r.txHash)}`);
  console.log(`wrote ${path}`);
}

function printPlan(plan: TapeoutPlan) {
  console.log(`processor     ${plan.cpu}`);
  console.log(`needs         ${plan.nand} NAND + ${plan.latch} LATCH (you hold ${plan.balNand} / ${plan.balLatch})`);
  console.log(`tapeout fee   ${okb(plan.tapeoutFee)}`);
  console.log(`mint          ${plan.needNand} NAND + ${plan.needLatch} LATCH @ ${okb(plan.mintPrice)} + ${okb(plan.protocolFee)} protocol fee per mint call`);
  console.log(`total         ${okb(plan.totalWei)}`);
}

export async function cmdTapeout(
  file: string,
  o: { processor: string; mint?: boolean; yes?: boolean; name?: string; deployments?: string },
) {
  const f = readTsyn(file);
  const wc = walletClient();
  const pc = publicClient();
  const cpu = await processorArg(pc, o.processor);
  const plan = await planTapeout(pc, { cpu, account: wc.account!.address, nand: f.metrics.nand, latch: f.metrics.latch });
  printPlan(plan);
  if (plan.needNand + plan.needLatch > 0n) {
    if (plan.soldOut) throw new Error("sold-out: acquire transistors on the processor's market");
    if (!o.mint) throw new Error('missing transistors; re-run with --mint to mint them');
  }
  const bal = await pc.getBalance({ address: wc.account!.address });
  if (bal < plan.totalWei) throw new Error(`balance ${okb(bal)} is below the required ${okb(plan.totalWei)}`);
  if (!o.yes && !(await confirm('Tape out? This is permanent and costs real OKB.'))) throw new Error('aborted');
  const res = await executeTapeout(wc, pc, plan, f, (m) => console.log(`… ${m}`));
  const pnum = await processorNumber(pc, cpu);
  console.log(`taped out: circuit #${res.id}${pnum !== null ? ` @ processor ${pnum}  (#${res.id}@2.${pnum})` : ''}`);
  for (const h of res.txHashes) console.log(`tx ${OKLINK_TX(h)}`);

  const v = await verifyOnChain(pc, cpu, res.id, f);
  report(v);
  if (o.name) {
    const path = deploymentsPath(o.deployments);
    const d = readDeployments(path);
    d.circuits = [...d.circuits.filter((c) => c.id !== Number(res.id)), { id: Number(res.id), name: o.name, file, txHash: res.txHashes[res.txHashes.length - 1] }];
    writeJson(path, d);
    console.log(`recorded in ${path}`);
  }
  if (v.mismatches.length) process.exitCode = 1;
}

function report(v: VerifyOnChainResult) {
  if (v.mismatches.length) {
    console.error(`on-chain verification FAILED:\n  ${v.mismatches.join('\n  ')}`);
    return;
  }
  console.log(`on-chain verification: ${v.matched}/${v.calls} matched, netlist identical${v.skipped ? ` (eval skipped: ${v.skipped})` : ''}`);
}

export async function cmdVerify(cpuRef: string, idStr: string, o: { against: string }) {
  const pc = publicClient();
  const cpu = await processorArg(pc, cpuRef);
  const f = readTsyn(o.against);
  const v = await verifyOnChain(pc, cpu, BigInt(idStr), f);
  report(v);
  if (v.mismatches.length) process.exitCode = 1;
}
