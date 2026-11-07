/**
 * CESR 1.0 text primitives: qb64 encoding, indexed signatures, count codes and `-F` groups.
 * Written from the CESR specification's code tables and checked against KERIpy 1.3.6 output.
 */
import { blake3 } from "@noble/hashes/blake3.js";
import { fromB64u, toB64u, utf8 } from "@zk-toip/trust-core";
import type { IndexedSig, IndexedSigCode, KeyRefSig, Qb64 } from "./types";

export type { Qb64 } from "./types";

export const Code = {
  Ed25519: "D",
  Ed25519N: "B",
  Blake3: "E",
  SHA256: "I",
  Short: "M",
  Salt128: "0A",
  Ed25519Sig: "0B",
  P256Sig: "0I",
  P256: "1AAJ",
  P256N: "1AAI",
  DateTime: "1AAG",
} as const;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function intToB64(n: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s = B64[n % 64] + s;
    n = Math.floor(n / 64);
  }
  if (n !== 0) throw new Error("number too big for its field");
  return s;
}

export function b64ToInt(s: string): number {
  let n = 0;
  for (const c of s) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new Error(`not base64url: ${c}`);
    n = n * 64 + v;
  }
  return n;
}

/** Fixed-size primitives: hard code size, full qb64 size, raw byte size. */
const FIXED: Record<string, { hs: number; fs: number; raw: number }> = {
  B: { hs: 1, fs: 44, raw: 32 },
  D: { hs: 1, fs: 44, raw: 32 },
  E: { hs: 1, fs: 44, raw: 32 },
  I: { hs: 1, fs: 44, raw: 32 },
  M: { hs: 1, fs: 4, raw: 2 },
  "0A": { hs: 2, fs: 24, raw: 16 },
  "0B": { hs: 2, fs: 88, raw: 64 },
  "0I": { hs: 2, fs: 88, raw: 64 },
  "1AAG": { hs: 4, fs: 36, raw: 24 },
  "1AAI": { hs: 4, fs: 48, raw: 33 },
  "1AAJ": { hs: 4, fs: 48, raw: 33 },
};
const VARIABLE = ["4B", "5B", "6B", "4A", "5A", "6A"];

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function encode(code: string, raw: Uint8Array): Qb64 {
  const f = FIXED[code];
  if (f) {
    if (raw.length !== f.raw) throw new Error(`${code} needs ${f.raw} bytes, got ${raw.length}`);
    const ps = (3 - (raw.length % 3)) % 3;
    return code + toB64u(concat(zeros(ps), raw)).slice(ps);
  }
  if (code === "4B" || code === "4A") {
    const ls = (3 - (raw.length % 3)) % 3;
    const hard = (code === "4B" ? ["4B", "5B", "6B"] : ["4A", "5A", "6A"])[ls];
    const body = toB64u(concat(zeros(ls), raw));
    return hard + intToB64(body.length / 4, 2) + body;
  }
  throw new Error(`unsupported code ${code}`);
}

/** The full size of the primitive starting at `text[0]`, or throws. */
export function primitiveSize(text: string): number {
  const c = text[0];
  let code: string;
  if (/[A-Za-z]/.test(c)) code = c;
  else if (c === "0") code = text.slice(0, 2);
  else if (c === "1" || c === "2" || c === "3") code = text.slice(0, 4);
  else if (c === "4" || c === "5" || c === "6") {
    code = text.slice(0, 2);
    if (!VARIABLE.includes(code)) throw new Error(`unsupported code ${code}`);
    if (text.length < 4) throw new Error("short primitive");
    return 4 + b64ToInt(text.slice(2, 4)) * 4;
  } else throw new Error(`unsupported code at ${JSON.stringify(text.slice(0, 4))}`);
  const f = FIXED[code];
  if (!f) throw new Error(`unsupported code ${code}`);
  return f.fs;
}

export function decode(qb64: Qb64): { code: string; raw: Uint8Array } {
  if (typeof qb64 !== "string" || qb64.length === 0) throw new Error("empty primitive");
  const size = primitiveSize(qb64);
  if (qb64.length !== size) throw new Error(`primitive length ${qb64.length}, expected ${size}`);
  const c = qb64[0];
  if (c === "4" || c === "5" || c === "6") {
    const code = qb64.slice(0, 2);
    const ls = { "4": 0, "5": 1, "6": 2 }[c]!;
    const all = fromB64u(qb64.slice(4));
    for (let i = 0; i < ls; i++) if (all[i] !== 0) throw new Error("nonzero lead byte");
    return { code: code[1] === "B" ? "4B" : "4A", raw: all.slice(ls) };
  }
  const code = /[A-Za-z]/.test(c) ? c : c === "0" ? qb64.slice(0, 2) : qb64.slice(0, 4);
  const f = FIXED[code];
  const ps = (3 - (f.raw % 3)) % 3;
  const all = fromB64u("A".repeat(ps) + qb64.slice(f.hs));
  if (all.length !== ps + f.raw) throw new Error("bad primitive");
  for (let i = 0; i < ps; i++) if (all[i] !== 0) throw new Error("nonzero pad bits");
  if (toB64u(all).slice(ps) !== qb64.slice(f.hs)) throw new Error("non-canonical primitive");
  return { code, raw: all.slice(ps) };
}

export function isQb64(text: unknown, codes?: readonly string[]): boolean {
  if (typeof text !== "string") return false;
  try {
    const { code } = decode(text);
    return !codes || codes.includes(code);
  } catch {
    return false;
  }
}

/** Blake3-256 digest, code E. */
export function digest(bytes: Uint8Array | string): Qb64 {
  return encode("E", blake3(typeof bytes === "string" ? utf8(bytes) : bytes));
}

/** Digest of a public key's qb64 text, as KERIpy and signify-ts compute next-key digests. */
export function nextKeyDigest(publicKey: Qb64): Qb64 {
  return digest(publicKey);
}

export function nonTransferableAid(publicKey: Uint8Array): Qb64 {
  return encode("B", publicKey);
}

/** A digest seal {d} for 32 raw digest bytes: SHA-256 (code I, the default, as capture's Merkle roots) or Blake3 (code E). */
export function digestSeal(raw: Uint8Array, alg: "sha256" | "blake3" = "sha256"): { d: Qb64 } {
  return { d: encode(alg === "sha256" ? "I" : "E", raw) };
}

// ---- did:key <-> B AIDs (Ed25519 only)

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

function unbase58(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("not base58");
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function didKeyOf(aidB: Qb64): string {
  const { code, raw } = decode(aidB);
  if (code !== "B" && code !== "D") throw new Error("not an Ed25519 AID");
  return "did:key:z" + base58(concat(Uint8Array.of(0xed, 0x01), raw));
}

export function aidOfDidKey(did: string): Qb64 {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did.split("#")[0]);
  if (!m) throw new Error("not a did:key");
  const bytes = unbase58(m[1]);
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error("not an Ed25519 did:key");
  return encode("B", bytes.slice(2));
}

/** The DID we use for an AID. Resolved from its KEL alone. */
export function aidDid(aid: Qb64): string {
  return `did:keri:${aid}`;
}

export function aidOfDid(did: string): Qb64 {
  const m = /^did:keri:(E[A-Za-z0-9_-]{43})$/.exec(did.split("#")[0]);
  if (!m) throw new Error("not a did:keri");
  return m[1];
}

// ---- indexed signatures

const SMALL_SIG = new Set(["A", "B", "E", "F"]);
const BIG_SIG = new Set(["2A", "2B", "2E", "2F"]);
export const DUAL_CODES = new Set(["A", "2A", "E", "2E"]);

export function sigCurve(code: IndexedSigCode): "ed25519" | "p256" {
  return code === "A" || code === "B" || code === "2A" || code === "2B" ? "ed25519" : "p256";
}

export function encodeIndexedSig(s: IndexedSig): string {
  if (s.sig.length !== 64) throw new Error("signature must be 64 bytes");
  const tail = toB64u(concat(zeros(2), s.sig)).slice(2);
  if (SMALL_SIG.has(s.code)) {
    if (s.index > 63) throw new Error("index too big for a small code");
    return s.code + intToB64(s.index, 1) + tail;
  }
  if (BIG_SIG.has(s.code)) {
    const dual = DUAL_CODES.has(s.code);
    return s.code + intToB64(s.index, 2) + intToB64(dual ? (s.ondex ?? s.index) : 0, 2) + tail;
  }
  throw new Error(`unsupported signature code ${s.code}`);
}

export function indexedSigSize(text: string): number {
  if (SMALL_SIG.has(text[0])) return 88;
  if (BIG_SIG.has(text.slice(0, 2))) return 92;
  throw new Error(`unsupported indexed signature code ${JSON.stringify(text.slice(0, 2))}`);
}

export function decodeIndexedSig(text: string): IndexedSig {
  const size = indexedSigSize(text);
  if (text.length !== size) throw new Error("bad indexed signature length");
  const small = size === 88;
  const code = (small ? text[0] : text.slice(0, 2)) as IndexedSigCode;
  const index = b64ToInt(small ? text.slice(1, 2) : text.slice(2, 4));
  const ondexRaw = small ? index : b64ToInt(text.slice(4, 6));
  const all = fromB64u("AA" + text.slice(small ? 2 : 6));
  if (all.length !== 66 || all[0] !== 0 || all[1] !== 0) throw new Error("bad signature padding");
  if (toB64u(all).slice(2) !== text.slice(small ? 2 : 6)) throw new Error("non-canonical signature");
  const out: IndexedSig = { code, index, sig: all.slice(2) };
  if (DUAL_CODES.has(code)) out.ondex = ondexRaw;
  else if (!small && ondexRaw !== 0) throw new Error("current-only signature with an ondex");
  return out;
}

// ---- count codes

export function counter(code: string, count: number): string {
  if (count < 4096) return code + intToB64(count, 2);
  return "-0" + code.slice(1) + intToB64(count, 5);
}

export function parseCounter(text: string): { code: string; count: number; size: number } {
  if (text[0] !== "-") throw new Error("not a counter");
  if (text[1] === "0") {
    if (text.length < 8) throw new Error("short counter");
    return { code: "-" + text[2], count: b64ToInt(text.slice(3, 8)), size: 8 };
  }
  if (text[1] === "-") throw new Error("unsupported: CESR genus/version counter");
  if (text.length < 4) throw new Error("short counter");
  return { code: text.slice(0, 2), count: b64ToInt(text.slice(2, 4)), size: 4 };
}

export function seqner(sn: number): Qb64 {
  const raw = new Uint8Array(16);
  let n = BigInt(sn);
  for (let i = 15; i >= 0; i--) {
    raw[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return encode("0A", raw);
}

export function unseqner(q: Qb64): number {
  const { code, raw } = decode(q);
  if (code !== "0A") throw new Error("not a sequence number");
  let n = 0n;
  for (const b of raw) n = (n << 8n) | BigInt(b);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("sequence number too big");
  return Number(n);
}

/** Encodes signatures and, for WebAuthn-wrapped ones, our `-Y` group after them. */
export function encodeSigGroup(code: "-A" | "-B", sigs: IndexedSig[]): string {
  let out = counter(code, sigs.length) + sigs.map(encodeIndexedSig).join("");
  const wrapped = sigs.map((s, i) => [s, i] as const).filter(([s]) => s.wrap);
  if (wrapped.length) {
    out += counter("-Y", wrapped.length);
    for (const [s, i] of wrapped) {
      out += encode("M", Uint8Array.of(i >> 8, i & 0xff)) + encode("4B", s.wrap!.authenticatorData) + encode("4B", s.wrap!.clientDataJSON);
    }
  }
  return out;
}

export function encodeKeyRefSig(s: KeyRefSig): string {
  return counter("-F", 1) + s.aid + seqner(s.estSn) + s.estSaid + encodeSigGroup("-A", s.sigs);
}

export function decodeKeyRefSig(text: string): KeyRefSig {
  const r = new AttachmentReader(text);
  const c = r.counter();
  if (c.code !== "-F" || c.count !== 1) throw new Error("expected one -F group");
  const g = r.keyRefSig();
  if (!r.done()) throw new Error("trailing text after -F group");
  return g;
}

/** Reads CESR attachments from text. Throws on anything malformed. */
export class AttachmentReader {
  pos = 0;
  constructor(readonly text: string) {}

  done(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string {
    return this.text[this.pos];
  }

  counter(): { code: string; count: number } {
    const c = parseCounter(this.text.slice(this.pos, this.pos + 8));
    this.pos += c.size;
    return c;
  }

  primitive(): Qb64 {
    const size = primitiveSize(this.text.slice(this.pos, this.pos + 4));
    const q = this.text.slice(this.pos, this.pos + size);
    if (q.length !== size) throw new Error("truncated primitive");
    decode(q);
    this.pos += size;
    return q;
  }

  indexedSig(): IndexedSig {
    const size = indexedSigSize(this.text.slice(this.pos, this.pos + 2));
    const q = this.text.slice(this.pos, this.pos + size);
    this.pos += size;
    return decodeIndexedSig(q);
  }

  sigs(count: number): IndexedSig[] {
    const out: IndexedSig[] = [];
    for (let i = 0; i < count; i++) out.push(this.indexedSig());
    this.wraps(out);
    return out;
  }

  /** Our extension: `-Y` after a signature group attaches WebAuthn wrappers to signatures by position. */
  wraps(sigs: IndexedSig[]): void {
    if (this.text.slice(this.pos, this.pos + 2) !== "-Y") return;
    const { count } = this.counter();
    for (let i = 0; i < count; i++) {
      const pos = decode(this.primitive()).raw;
      const at = (pos[0] << 8) | pos[1];
      const authenticatorData = decode(this.primitive()).raw;
      const clientDataJSON = decode(this.primitive()).raw;
      if (!sigs[at]) throw new Error("WebAuthn wrapper for a missing signature");
      sigs[at].wrap = { authenticatorData, clientDataJSON };
    }
  }

  keyRefSig(): KeyRefSig {
    const aid = this.primitive();
    const estSn = unseqner(this.primitive());
    const estSaid = this.primitive();
    const c = this.counter();
    if (c.code !== "-A") throw new Error("expected -A in -F group");
    return { aid, estSn, estSaid, sigs: this.sigs(c.count) };
  }
}
