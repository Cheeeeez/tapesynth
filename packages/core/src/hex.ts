export type Hex = `0x${string}`;

export function bytesToHex(b: Uint8Array): Hex {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return `0x${s}`;
}

export function hexToBytes(h: string): Uint8Array {
  let s = h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h;
  if (s.length % 2 !== 0) throw new Error(`odd-length hex string`);
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error(`invalid hex string`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
