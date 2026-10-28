#!/usr/bin/env node
import { Command } from 'commander';
import { cmdImport, cmdInfo, cmdOptimize, cmdSim, cmdSynth } from './cmd-synth.js';
import { cmdProcessorCreate, cmdTapeout, cmdVerify } from './cmd-chain.js';

const program = new Command();
program.name('tapesynth').description('Verilog / PLA / on-chain circuit → verified TAP-02 netlist → TapeOut on X Layer').version('0.1.0');

const run = <A extends unknown[]>(fn: (...a: A) => unknown | Promise<unknown>) => async (...a: A) => {
  try {
    await fn(...a);
  } catch (e) {
    const err = e as Error & { code?: string; shortMessage?: string };
    console.error(`error: ${err.code ? `[${err.code}] ` : ''}${err.shortMessage ?? err.message}`);
    process.exit(1);
  }
};

program
  .command('synth <file>')
  .description('synthesize a design to a verified TAP-02 netlist (.tsyn.json)')
  .option('--kind <kind>', 'verilog | pla | netlist (default: from the file extension)')
  .option('--top <module>', 'top module (default: first module)')
  .option('--clock <port>', 'clock port name', 'clk')
  .option('--objective <o>', 'area | depth | pod', 'area')
  .option('--out <file>', 'output file')
  .option('--remote', 'use $TAPESYNTH_API (free tier) instead of local Yosys')
  .action(run(cmdSynth));

program.command('info <file>').description('show metrics, pin map and verification of a .tsyn.json')
  .option('--cref <n>', 'reference cost; prints the PoD quality q').action(run(cmdInfo));

program.command('sim <file>').description('simulate a .tsyn.json')
  .option('--inputs <hex>', 'packed inputs, LSB first (0x..)', '0x')
  .option('--state <hex>', 'initial state (0x..)', '0x')
  .option('--beats <n>', 'number of beats', '1').action(run(cmdSim));

program.command('import <cpu> <id>').description('read a circuit from a processor (address or number), flatten REFs, write a .tsyn.json')
  .option('--out <file>').action(run(cmdImport));

program.command('optimize <cpu> <id>').description('import an on-chain circuit, re-synthesize it, print before/after')
  .option('--objective <o>', 'area | depth | pod', 'pod')
  .option('--cref <n>', 'reference cost for q (default: the circuit’s own C)')
  .option('--out <file>').action(run(cmdOptimize));

const processor = program.command('processor').description('processor management');
processor.command('create').description('create a processor (permanent; supply and price are fixed forever)')
  .requiredOption('--name <s>').requiredOption('--symbol <s>').requiredOption('--story <s>')
  .requiredOption('--supply <n>', 'transistor supply cap').requiredOption('--price <wei>', 'mint price per transistor in wei')
  .option('--deployments <file>', 'deployments file to update', 'deployments/xlayer.json').action(run(cmdProcessorCreate));

program.command('tapeout <file>').description('tape out a .tsyn.json on X Layer, then verify it on-chain')
  .requiredOption('--processor <addr|n>', 'processor address or number')
  .option('--mint', 'mint missing transistors')
  .option('--yes', 'skip the confirmation prompt')
  .option('--name <s>', 'record the circuit under this name in the deployments file')
  .option('--deployments <file>', 'deployments file', 'deployments/xlayer.json').action(run(cmdTapeout));

program.command('verify <cpu> <id>').description('compare an on-chain circuit with a .tsyn.json (netlist bytes + eval/step)')
  .requiredOption('--against <file>').action(run(cmdVerify));

await program.parseAsync(process.argv);
