import { sha256 } from "@noble/hashes/sha2.js";

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** H(x)[0..n]: the first n bytes of SHA-256. */
export const h = (x: Uint8Array, n: number): Uint8Array => sha256(x).slice(0, n);

export { sha256 };

/** A tiny seeded PRNG (mulberry32), so simulations repeat exactly. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Map that keeps at most `max` entries, dropping the least recently used. */
export class Lru<K, V> {
  private readonly m = new Map<K, V>();
  constructor(readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  peek(k: K): V | undefined {
    return this.m.get(k);
  }
  has(k: K): boolean {
    return this.m.has(k);
  }
  set(k: K, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
  }
  delete(k: K): void {
    this.m.delete(k);
  }
  get size(): number {
    return this.m.size;
  }
  entries(): IterableIterator<[K, V]> {
    return this.m.entries();
  }
}
