import { NetlistError, type FlatElement } from './tap02/types.js';
import { placeOutputsIfNeeded } from './place.js';

export type PinRef = { port: string; bit: number };
export type Pins = { inputs: PinRef[]; outputs: PinRef[]; clock: string | null };

export class ConvertError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ConvertError';
    this.code = code;
  }
}

type Bit = number | string;
type YCell = { type: string; connections: Record<string, Bit[]> };
type YModule = {
  ports: Record<string, { direction: string; bits: Bit[] }>;
  cells?: Record<string, YCell>;
};
export type YosysJson = { modules: Record<string, YModule> };

export type FromYosysResult = {
  elements: FlatElement[];
  nIn: number;
  nOut: number;
  pins: Pins;
  warnings: string[];
};

/**
 * Convert a gate-level Yosys JSON (cells: $_NAND_, $_NOT_, $_BUF_, $_DFF_P_) to a TAP-02 netlist.
 * Inputs follow the module port declaration order, LSB first; the clock port is dropped when the
 * design has flip-flops. Layout: all LATCHes first, then NANDs in topological order, then the
 * output block (see placeOutputs).
 */
export function fromYosysJson(json: YosysJson, opts: { top: string; clock?: string }): FromYosysResult {
  const mod = json.modules[opts.top];
  if (!mod) throw new ConvertError('no-such-module', `module ${opts.top} not found`);
  const clockName = opts.clock ?? 'clk';
  const warnings: string[] = [];
  const cells = Object.values(mod.cells ?? {});
  const hasDff = cells.some((c) => c.type === '$_DFF_P_');

  // --- pins
  const pins: Pins = { inputs: [], outputs: [], clock: null };
  const inputBits: Bit[] = [];
  const outputBits: Bit[] = [];
  let clockBit: Bit | null = null;
  for (const [name, p] of Object.entries(mod.ports)) {
    if (p.direction === 'inout') throw new ConvertError('unsupported-port', `inout port ${name}`);
    if (p.direction === 'input') {
      if (hasDff && name === clockName) {
        if (p.bits.length !== 1) throw new ConvertError('unsupported-clocking', `clock port ${name} must be 1 bit`);
        pins.clock = name;
        clockBit = p.bits[0]!;
        continue;
      }
      p.bits.forEach((b, i) => {
        pins.inputs.push({ port: name, bit: i });
        inputBits.push(b);
      });
    } else {
      p.bits.forEach((b, i) => {
        pins.outputs.push({ port: name, bit: i });
        outputBits.push(b);
      });
    }
  }
  const nIn = inputBits.length;
  const nOut = outputBits.length;
  if (nOut === 0) throw new NetlistError('no-outputs', 'module has no output bits');
  const base = 2 + nIn;

  // --- classify cells
  const alias = new Map<Bit, Bit>(); // $_BUF_ : Y -> A
  const gate = new Map<Bit, { a: Bit; b: Bit }>(); // Y -> inputs
  const dffOut = new Map<Bit, Bit>(); // Q -> D
  const dffOrder: Bit[] = [];
  for (const c of cells) {
    const k = c.connections;
    switch (c.type) {
      case '$_NAND_':
        gate.set(k.Y![0]!, { a: k.A![0]!, b: k.B![0]! });
        break;
      case '$_NOT_':
        gate.set(k.Y![0]!, { a: k.A![0]!, b: k.A![0]! });
        break;
      case '$_BUF_':
        alias.set(k.Y![0]!, k.A![0]!);
        break;
      case '$_DFF_P_':
        if (clockBit === null || k.C![0] !== clockBit)
          throw new ConvertError('unsupported-clocking', `flip-flop clocked by something other than port "${clockName}"`);
        dffOut.set(k.Q![0]!, k.D![0]!);
        dffOrder.push(k.Q![0]!);
        break;
      default:
        throw new ConvertError(`unsupported-cell:${c.type}`, `unsupported cell type ${c.type}`);
    }
  }

  // --- resolve a bit to a canonical bit (follows $_BUF_ chains) or a constant
  const canon = (b: Bit): Bit => {
    let steps = 0;
    while (alias.has(b)) {
      b = alias.get(b)!;
      if (++steps > alias.size) throw new ConvertError('combinational-loop', 'loop through buffers');
    }
    return b;
  };
  let warnedUndef = false;
  const constOf = (b: Bit): 0 | 1 | null => {
    if (b === '0') return 0;
    if (b === '1') return 1;
    if (b === 'x') {
      if (!warnedUndef) {
        warnings.push('undefined-bit: undefined (x) signals were tied to 0');
        warnedUndef = true;
      }
      return 0;
    }
    if (b === 'z') throw new ConvertError('high-impedance', 'high-impedance (z) signal is not supported');
    return null;
  };

  // --- signal numbering: inputs, then latches, then gates in topological (DFS post-order) order
  const sig = new Map<Bit, number>();
  inputBits.forEach((b, i) => sig.set(b, 2 + i));
  dffOrder.forEach((q, i) => sig.set(q, base + i));
  const body: FlatElement[] = dffOrder.map(() => ({ op: 'LATCH', d: 0 }));

  const state = new Map<Bit, 1 | 2>(); // 1 = visiting, 2 = done
  const resolve = (b0: Bit): number => {
    const b = canon(b0);
    const c = constOf(b);
    if (c !== null) return c;
    const s = sig.get(b);
    if (s !== undefined) return s;
    visit(b);
    return sig.get(b)!;
  };
  // iterative DFS so deep netlists do not overflow the JS stack
  const visit = (root: Bit) => {
    const stack: { bit: Bit; g: { a: Bit; b: Bit }; phase: number }[] = [];
    const push = (bit: Bit) => {
      const g = gate.get(bit);
      if (!g) throw new ConvertError('undriven-bit', `signal ${String(bit)} has no driver`);
      if (state.get(bit) === 1) throw new ConvertError('combinational-loop', 'combinational loop detected');
      state.set(bit, 1);
      stack.push({ bit, g, phase: 0 });
    };
    push(root);
    while (stack.length) {
      const f = stack[stack.length - 1]!;
      if (f.phase < 2) {
        const child = canon(f.phase === 0 ? f.g.a : f.g.b);
        f.phase++;
        if (constOf(child) === null && !sig.has(child)) {
          if (state.get(child) === 1) throw new ConvertError('combinational-loop', 'combinational loop detected');
          push(child);
        }
        continue;
      }
      stack.pop();
      const a = resolve(f.g.a);
      const b = resolve(f.g.b);
      sig.set(f.bit, base + body.length);
      body.push({ op: 'NAND', a, b });
      state.set(f.bit, 2);
    }
  };

  const outs = outputBits.map(resolve);
  dffOrder.forEach((q, i) => {
    (body[i] as { d: number }).d = resolve(dffOut.get(q)!);
  });

  const elements = placeOutputsIfNeeded(body, outs, nIn);
  return { elements, nIn, nOut, pins, warnings };
}
