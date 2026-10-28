import type { Hex } from '../hex.js';

export type NandEl = { op: 'NAND'; a: number; b: number };
export type LatchEl = { op: 'LATCH'; d: number };
export type RefEl = { op: 'REF'; cpu: Hex; id: bigint; nIns: number; nOuts: number; ins: number[] };
export type Element = NandEl | LatchEl | RefEl;

/** Flat (REF-free) element. */
export type FlatElement = NandEl | LatchEl;

export type NetlistErrorCode =
  | 'bad-opcode'
  | 'truncated'
  | 'no-outputs'
  | 'too-many-pins'
  | 'too-few-signals'
  | 'nand-future'
  | 'ref-future'
  | 'latch-out-of-range'
  | 'ref-pin-mismatch'
  | 'ref-unresolved'
  | 'size-overflow'
  | 'ref-not-flattened'
  | 'import-mismatch';

export class NetlistError extends Error {
  code: NetlistErrorCode;
  constructor(code: NetlistErrorCode, message: string) {
    super(message);
    this.name = 'NetlistError';
    this.code = code;
  }
}

export const MAX_SIGNALS = 1 << 24;
export const MAX_PINS = 1 << 16;
export const MAX_GATES = 0xffffffff;
