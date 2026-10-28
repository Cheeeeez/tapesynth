#!/usr/bin/env node
// Generates docs/SUBMISSION.md from deployments/xlayer.json and the live API stats.
// Usage: node scripts/submission.mjs --api https://tapesynth-api.fly.dev --repo https://github.com/Cheeeeez/tapesynth --video <url>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { api: { type: 'string' }, repo: { type: 'string' }, video: { type: 'string' }, out: { type: 'string', default: 'docs/SUBMISSION.md' } } });
for (const k of ['api', 'repo', 'video']) if (!a[k]) throw new Error(`--${k} is required`);
const d = JSON.parse(readFileSync('deployments/xlayer.json', 'utf8'));
if (!d.processor || d.processorNumber === null || d.siteCircuitId === null || !d.circuits.length) throw new Error('deployments/xlayer.json is not filled in yet (run the mainnet bootstrap first)');
const api = a.api.replace(/\/$/, '');
const stats = await (await fetch(`${api}/v1/stats`)).json();
const P = d.processorNumber;
const site = d.siteCircuitId;
const rows = d.circuits.map((c) => `| ${c.name} | #${c.id}@2.${P} | https://www.oklink.com/xlayer/tx/${c.txHash} |`).join('\n');

const md = `# TapeSynth — X Layer TapeOut Accelerate submission

## Product

**TapeSynth** is the missing compiler/toolchain for TapeOut. Write a circuit in Verilog or a PLA truth table (or pick one that is already on X Layer), and TapeSynth returns a synthesized, optimized and **verified** TAP-02 netlist (NAND/LATCH), taps it out on X Layer in one step, and then checks the on-chain circuit against the chain's own \`eval\`/\`step\`. TAP-02 lists "Compilers (Verilog to TapeOut…)" as its motivation; until now every circuit on TapeOut was wired by hand.

- Open-source CLI, HTTP API (free and paid Pro jobs) and a web app hosted fully on-chain on DeWEB.
- Every netlist is simulated against the pre-ABC design (exhaustive up to 16 inputs, random above, random beat sequences for sequential circuits) before it is returned.
- "Optimize on-chain circuit": reads any circuit from any processor (REFs are flattened), re-synthesizes it for area, depth or PoD cost \`C = A·d³\`, and shows before/after with the PoD quality \`q\`.

Links: web app https://${site}-2-${P}.tapekit.org/ · tape://${site}.2.${P}.tape/ · API ${api} · code ${a.repo} · video ${a.video}

## Target users and how we reach them

1. **Circuit designers and PoD/FabX miners.** FabX had 6,573 active miners as of 26 Oct 2026 (https://tapeout.link/news/2114673060775416272). For them the PoD cost C (cubic in logic depth) decides hashrate, and an optimizer that lowers C is directly worth money.
2. **dApp teams that need on-chain rules** (spending policies, vaults, game logic). Writing a policy as Verilog and getting a verified circuit is far faster than drawing NAND gates.
3. **Hardware engineers new to Web3**, who already know Verilog.

Reach: TapeOut and FabX Telegram/X communities (short how-to plus an "optimize your circuit" challenge), a PR to \`trytotapeout/awesome-tapeout\`, a listing on the tapeout.link hub, and direct invitations to FabX miners to run \`tapesynth optimize\` on their circuits.

## Revenue model

- **Pro jobs**: 0.005 OKB per job (all synthesis flows + re-synthesis rounds, up to 50,000 gates, PoD objective). Paid on X Layer to the treasury; the API verifies the payment on-chain.
- **Transistor mints**: the TapeSynth processor (\`${d.processor}\`, "TSYN") sells transistors at 0.00001 OKB each; users taping out through TapeSynth mint them there.
- Team/API plans later (private queues, higher limits).

## Why users pay and come back

- A lower C means a higher PoD quality q and more hashrate; the optimizer pays for itself on the first improved circuit.
- Tape-out is immutable and costs real money: a verified netlist avoids a broken tape-out.
- It replaces dragging NAND gates by hand: a policy that took hours is one command.
- Every change of a design needs a new tape-out, so teams iterate (and pay) repeatedly.

## TapeOut features used

- Factory \`createCPU\` (TapeSynth processor), transistor \`mint\`, processor \`tapeout\`, \`eval\`, \`step\`, \`circuitInfo\`, \`netlist\`, \`REF\` flattening.
- Container opener, SiteRegistry (DeWEB), DomainBinding, and the TapeKit kernel (\`tapesynth site verify\`).
- The FAB-Genesis processor as a tape-out preset, and the PoD cost/quality formulas for the optimizer.

## Addresses

- TapeSynth processor: \`${d.processor}\` (processor #${P}); transistors \`${d.transistors}\`
- Site circuit: #${site} (container hosts the DeWEB site \`${site}.2.${P}.tape\`)

| circuit | id | tx |
|---|---|---|
${rows}

## Usage at submission time

From \`${api}/v1/stats\`: ${stats.freeSynth} free syntheses, ${stats.proJobs} Pro jobs, ${stats.uniquePayers} unique paying addresses.

## Note

All code was written during the event (repository created 27 Oct 2026).
`;
mkdirSync('docs', { recursive: true });
writeFileSync(a.out, md);
console.log(`wrote ${a.out}`);
