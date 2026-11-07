/**
 * Tip codes (design §8.4). A tip code is all a source needs to come back: it gives the tip DID and
 * the tip id. It is 16 random bytes and a one-byte checksum, in Crockford base32, groups of 4.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { identityFromSeed, type Identity } from "@zk-toip/trust-core";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_BYTES = 16;

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

export function unbase32(text: string, length: number): Uint8Array | null {
  const out = new Uint8Array(length);
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of text) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      if (n >= length) return null;
      out[n++] = (acc >>> (bits - 8)) & 255;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return n === length && acc === 0 ? out : null;
}

/** Upper case, no spaces or dashes, and the letters people confuse with digits read as digits. */
export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function checkByte(bytes: Uint8Array): number {
  const tag = utf8ToBytes("tipline/v1/tip-code");
  const buf = new Uint8Array(tag.length + bytes.length);
  buf.set(tag);
  buf.set(bytes, tag.length);
  return sha256(buf)[0];
}

/** Writes 16 bytes as a tip code: 28 characters in 7 groups of 4. */
export function encodeTipCode(bytes: Uint8Array): string {
  if (bytes.length !== CODE_BYTES) throw new Error("a tip code holds 16 bytes");
  const all = new Uint8Array(CODE_BYTES + 1);
  all.set(bytes);
  all[CODE_BYTES] = checkByte(bytes);
  return base32(all).match(/.{1,4}/g)!.join("-");
}

/** The 16 bytes, or null for a typo. */
export function decodeTipCode(code: string): Uint8Array | null {
  const all = unbase32(normalizeCode(code), CODE_BYTES + 1);
  if (!all) return null;
  const bytes = all.slice(0, CODE_BYTES);
  return checkByte(bytes) === all[CODE_BYTES] ? bytes : null;
}

export function newTipCode(): string {
  return encodeTipCode(crypto.getRandomValues(new Uint8Array(CODE_BYTES)));
}

export interface TipKeys {
  code: string;
  identity: Identity;
  tipId: string;
}

/** The tip DID and tip id a code stands for. Throws on a typo. */
export function tipKeys(code: string): TipKeys {
  const bytes = decodeTipCode(code);
  if (!bytes) throw new Error("that tip code has a typo");
  const seed = hmac(sha256, bytes, utf8ToBytes("tipline/v1/tip-did"));
  const id = hmac(sha256, bytes, utf8ToBytes("tipline/v1/tip-id")).slice(0, 16);
  return { code: encodeTipCode(bytes), identity: identityFromSeed(seed), tipId: `urn:tipline:${bytesToHex(id)}` };
}
