/** LSB-first bit packing, ceil(n/8) bytes (TAP-02 §5). */
export function pack(bits: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array((bits.length + 7) >> 3);
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3]! |= 1 << (i & 7);
  return out;
}

/** Lenient read as the deployed evaluator does: missing bytes read as 0, extra bytes/bits are ignored. */
export function unpack(bytes: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const by = i >> 3;
    out[i] = by < bytes.length ? (bytes[by]! >> (i & 7)) & 1 : 0;
  }
  return out;
}
