import { sha256 } from "@noble/hashes/sha2.js";

/** An element of BN254's scalar field Fr, the native field of Noir on Barretenberg. */
export type Field = bigint;

export const FIELD_MODULUS: Field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const HEX = /^0x[0-9a-f]{64}$/;

export function assertField(f: Field): Field {
  if (typeof f !== "bigint" || f < 0n || f >= FIELD_MODULUS) throw new Error("not a field element: at or above the modulus, or negative");
  return f;
}

/** "0x" and 64 lowercase hex digits, big-endian. */
export function fieldToHex(f: Field): string {
  return "0x" + assertField(f).toString(16).padStart(64, "0");
}

/** Reads `fieldToHex`'s form. Throws on anything else, and at or above the modulus. */
export function fieldFromHex(hex: string): Field {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new Error(`not a field hex string: ${String(hex).slice(0, 80)}`);
  const f = BigInt(hex);
  if (f >= FIELD_MODULUS) throw new Error("field value at or above the modulus");
  return f;
}

/** The first 31 bytes of a 32-byte digest, big-endian. 248 bits, so always below the modulus. */
export function toField(digest: Uint8Array): Field {
  if (digest.length !== 32) throw new Error("toField takes a 32-byte digest");
  let f = 0n;
  for (let i = 0; i < 31; i++) f = (f << 8n) | BigInt(digest[i]);
  return f;
}

/** `toField(SHA-256(bytes))`: agora's f(bytes). */
export function fieldFromBytes(bytes: Uint8Array): Field {
  return toField(sha256(bytes));
}

/** 32 bytes, big-endian. */
export function fieldToBytes(f: Field): Uint8Array {
  let x = assertField(f);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Reads 32 bytes, big-endian. Throws at or above the modulus. */
export function fieldFromBytes32(bytes: Uint8Array): Field {
  if (bytes.length !== 32) throw new Error("a field is 32 bytes");
  let f = 0n;
  for (const b of bytes) f = (f << 8n) | BigInt(b);
  if (f >= FIELD_MODULUS) throw new Error("field value at or above the modulus");
  return f;
}
