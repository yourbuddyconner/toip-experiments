import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson } from "@zk-toip/trust-core";
import { fieldFromBytes, fieldToHex, toField, type Field } from "./field";

const enc = new TextEncoder();
const DAY_MS = 86_400_000;

/** One part of a scope: a string, an integer, or a field (written as hex). */
export type ScopePart = string | number | Field;

/** toField(SHA-256(JCS(["anon-membership/v1/scope", app, ...parts]))). Tipline: (dropboxDid, storyId); agora: the forum. */
export function scopeOf(app: string, ...parts: ScopePart[]): Field {
  const ps = parts.map((p) => (typeof p === "bigint" ? fieldToHex(p) : p));
  return toField(sha256(enc.encode(canonicalJson(["anon-membership/v1/scope", app, ...ps]))));
}

/** toField(SHA-256(JCS(["anon-membership/v1/message", app, value]))). Binds a proof to one use. `value` is plain JSON. */
export function messageOf(app: string, value: unknown): Field {
  return toField(sha256(enc.encode(canonicalJson(["anon-membership/v1/message", app, value]))));
}

/** "<issuer DID>#<name>". */
export function groupIdOf(issuerDid: string, name: string): string {
  if (!issuerDid.startsWith("did:")) throw new Error("the issuer must be a DID");
  if (!name || name.includes("#")) throw new Error("a group name is non-empty and has no '#'");
  return `${issuerDid}#${name}`;
}

/** The group id as the circuit sees it: f(utf8(groupId)), as agora's design writes it. */
export function groupFieldOf(groupId: string): Field {
  return fieldFromBytes(enc.encode(groupId));
}

/** toField(HMAC-SHA256(seed, utf8(info))). */
export function deriveSecret(seed: Uint8Array, info: string): Field {
  if (seed.length < 16) throw new Error("a seed has at least 16 bytes");
  return toField(hmac(sha256, seed, enc.encode(info)));
}

/** One secret per group, so the same person's commitments in two groups differ. */
export function memberSecret(seed: Uint8Array, groupId: string): Field {
  return deriveSecret(seed, canonicalJson(["anon-membership/v1/secret", groupId]));
}

// ── Membership codes ────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32(bytes: Uint8Array): string {
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

function unbase32(text: string, length: number): Uint8Array | null {
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

function secretBytes(secret: Field): Uint8Array {
  if (secret < 0n || secret >= 1n << 248n) throw new Error("a member secret fits in 31 bytes");
  const out = new Uint8Array(31);
  let x = secret;
  for (let i = 30; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function checksum(groupId: string, s: Uint8Array): Uint8Array {
  const g = enc.encode(groupId);
  const buf = new Uint8Array(g.length + s.length);
  buf.set(g);
  buf.set(s, g.length);
  return sha256(buf).slice(0, 2);
}

/** Crockford base32 of the 31-byte secret and a 2-byte checksum over (groupId, secret), in groups of 4. */
export function encodeMembershipCode(secret: Field, groupId: string): string {
  const s = secretBytes(secret);
  const all = new Uint8Array(33);
  all.set(s);
  all.set(checksum(groupId, s), 31);
  return base32(all).match(/.{1,4}/g)!.join("-");
}

/** The secret, or null for a typo or a code made for another group. */
export function decodeMembershipCode(code: string, groupId: string): Field | null {
  const clean = code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const bytes = unbase32(clean, 33);
  if (!bytes) return null;
  const s = bytes.slice(0, 31);
  const sum = checksum(groupId, s);
  if (sum[0] !== bytes[31] || sum[1] !== bytes[32]) return null;
  let f = 0n;
  for (const b of s) f = (f << 8n) | BigInt(b);
  return f;
}

// ── Days ────────────────────────────────────────────────────────────

/** Days since 1970-01-01 UTC. */
export function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export function dayFromIso(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not an ISO date: ${date}`);
  const ms = Date.parse(date + "T00:00:00Z");
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error(`not a date: ${date}`);
  return dayOf(ms);
}

export function isoFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
