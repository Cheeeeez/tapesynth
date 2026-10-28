import { bytesToHex, hexToBytes, type Hex } from '../hex.js';
import { NetlistError, type Element } from './types.js';

const u24 = (d: Uint8Array, p: number) => (d[p]! << 16) | (d[p + 1]! << 8) | d[p + 2]!;

export function decodeNetlist(bytes: Uint8Array): Element[] {
  const els: Element[] = [];
  let p = 0;
  const need = (k: number) => {
    if (p + k > bytes.length) throw new NetlistError('truncated', `truncated record at byte ${p}`);
  };
  while (p < bytes.length) {
    const op = bytes[p]!;
    if (op === 0x00) {
      need(7);
      els.push({ op: 'NAND', a: u24(bytes, p + 1), b: u24(bytes, p + 4) });
      p += 7;
    } else if (op === 0x01) {
      need(4);
      els.push({ op: 'LATCH', d: u24(bytes, p + 1) });
      p += 4;
    } else if (op === 0x02) {
      need(31);
      const nIns = bytes[p + 29]!;
      const nOuts = bytes[p + 30]!;
      need(31 + 3 * nIns);
      let id = 0n;
      for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(bytes[p + 21 + i]!);
      const ins: number[] = [];
      for (let i = 0; i < nIns; i++) ins.push(u24(bytes, p + 31 + 3 * i));
      els.push({ op: 'REF', cpu: bytesToHex(bytes.subarray(p + 1, p + 21)), id, nIns, nOuts, ins });
      p += 31 + 3 * nIns;
    } else {
      throw new NetlistError('bad-opcode', `unknown opcode 0x${op.toString(16).padStart(2, '0')} at byte ${p}`);
    }
  }
  return els;
}

export function encodeNetlist(els: readonly Element[]): Uint8Array {
  let len = 0;
  for (const e of els) len += e.op === 'NAND' ? 7 : e.op === 'LATCH' ? 4 : 31 + 3 * e.ins.length;
  const out = new Uint8Array(len);
  let p = 0;
  const w24 = (v: number) => {
    out[p++] = (v >>> 16) & 0xff;
    out[p++] = (v >>> 8) & 0xff;
    out[p++] = v & 0xff;
  };
  for (const e of els) {
    if (e.op === 'NAND') {
      out[p++] = 0;
      w24(e.a);
      w24(e.b);
    } else if (e.op === 'LATCH') {
      out[p++] = 1;
      w24(e.d);
    } else {
      out[p++] = 2;
      out.set(hexToBytes(e.cpu), p);
      p += 20;
      let id = e.id;
      for (let i = 7; i >= 0; i--) {
        out[p + i] = Number(id & 0xffn);
        id >>= 8n;
      }
      p += 8;
      out[p++] = e.ins.length;
      out[p++] = e.nOuts;
      for (const s of e.ins) w24(s);
    }
  }
  return out;
}

export const netlistToHex = (els: readonly Element[]): Hex => bytesToHex(encodeNetlist(els));
export const netlistFromHex = (h: string): Element[] => decodeNetlist(hexToBytes(h));
