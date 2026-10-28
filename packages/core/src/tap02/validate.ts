import { MAX_GATES, MAX_PINS, MAX_SIGNALS, NetlistError, type Element } from './types.js';
import type { Hex } from '../hex.js';

export type RefInfo = { nIn: number; nOut: number; nState: number; gateCount: number };
export type RefResolver = (cpu: Hex, id: bigint) => RefInfo | undefined;

export type Validated = { S: number; nState: number; gateCount: number };

/** Well-formedness check, TAP-02 §3. `S` is the total signal count (including const0, const1 and inputs). */
export function validate(els: readonly Element[], nIn: number, nOut: number, refInfo?: RefResolver): Validated {
  let S = 2 + nIn;
  for (const e of els) S += e.op === 'REF' ? e.nOuts : 1;
  if (S > MAX_SIGNALS) throw new NetlistError('size-overflow', 'more than 2^24 signals');
  if (nIn < 0 || nIn > MAX_PINS || nOut > MAX_PINS) throw new NetlistError('too-many-pins', 'nIn/nOut out of range');
  if (nOut < 1) throw new NetlistError('no-outputs', 'nOut must be at least 1');
  if (S - 2 - nIn < nOut) throw new NetlistError('too-few-signals', 'too few signals for outputs');

  let next = 2 + nIn;
  let nState = 0;
  let gateCount = 0;
  for (const e of els) {
    const first = next;
    if (e.op === 'NAND') {
      if (e.a >= first || e.b >= first)
        throw new NetlistError('nand-future', `signal ${Math.max(e.a, e.b)} referenced by element at ${first} is not available`);
      gateCount++;
      next++;
    } else if (e.op === 'LATCH') {
      if (e.d >= S) throw new NetlistError('latch-out-of-range', `LATCH d=${e.d} out of range`);
      nState++;
      gateCount++;
      next++;
    } else {
      for (const s of e.ins)
        if (s >= first) throw new NetlistError('ref-future', `signal ${s} referenced by REF at ${first} is not available`);
      if (!refInfo) throw new NetlistError('ref-unresolved', 'REF without a resolver');
      const sub = refInfo(e.cpu, e.id);
      if (!sub) throw new NetlistError('ref-unresolved', 'REF target is not a circuit of a registered processor');
      if (sub.nIn !== e.ins.length || sub.nOut !== e.nOuts)
        throw new NetlistError('ref-pin-mismatch', 'REF arity does not match the target circuit');
      if (sub.nState > MAX_SIGNALS) throw new NetlistError('size-overflow', 'REF size');
      nState += sub.nState;
      gateCount += sub.gateCount;
      next += e.nOuts;
    }
  }
  if (nState > MAX_SIGNALS || gateCount > MAX_GATES) throw new NetlistError('size-overflow', 'size overflow');
  return { S, nState, gateCount };
}
