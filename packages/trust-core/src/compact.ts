/**
 * Trust Task body codecs for the TSP binding (mesh design §8.1, §19.3).
 *
 * The sealed TSP payload carries a body whose first byte says its format:
 * - 0x7B (`{`): the standard JSON envelope `{type: ENVELOPE_TYPE, document}`.
 * - 0x01: CTT1, a CBOR encoding of the same document that decodes back to identical JSON values,
 *   so JCS and every Data Integrity proof are unchanged. The encoder proves this each time and
 *   returns null (use JSON) when it can't.
 *
 * Every Endpoint reads both. It writes CTT1 only to peers its `bodyCodecFor` option names.
 */
import type { TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import { ENVELOPE_TYPE } from "@openvtc/trust-tasks-tsp";
import { didKeyFromPublicKey, fromMultibase, publicKeyFromDidKey, toMultibase } from "@openvtc/trust-tasks-proof";
import { CborReader, CborWriter, MT } from "./cbor";

export interface BodyContext {
  /** The TSP envelope's sender and receiver VIDs. CTT1 writes each as one byte. */
  sender: string;
  receiver: string;
}

export interface BodyCodec {
  /** The body's first byte: 0x7B for JSON, 0x01 for CTT1. */
  readonly format: number;
  /** The body bytes, or null when this codec can't carry `doc` exactly (use JSON). */
  encode(doc: TrustTaskDocument<unknown>, ctx: BodyContext): Uint8Array | null;
  decode(body: Uint8Array, ctx: BodyContext): TrustTaskDocument<unknown>;
}

/** Why a body could not be read, in the TSP binding's failure terms. */
export class BodyError extends Error {
  constructor(
    readonly failure: "invalidBody" | "wrongEnvelopeType",
    message: string,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

export const JSON_FORMAT = 0x7b;
export const CTT1_FORMAT = 0x01;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function checkDocument(document: unknown): TrustTaskDocument<unknown> {
  const d = document as { id?: unknown; type?: unknown } | null;
  if (typeof d !== "object" || d === null || typeof d.id !== "string" || typeof d.type !== "string") {
    throw new BodyError("invalidBody", "envelope carries no Trust Task document");
  }
  return d as TrustTaskDocument<unknown>;
}

/** The binding's standard JSON body, byte for byte what `packTrustTask` seals. */
export const jsonBody: BodyCodec = {
  format: JSON_FORMAT,
  encode(doc) {
    return utf8.encode(JSON.stringify({ type: ENVELOPE_TYPE, document: doc }));
  },
  decode(body) {
    let envelope: { type?: unknown; document?: unknown };
    try {
      envelope = JSON.parse(fromUtf8.decode(body));
    } catch {
      throw new BodyError("invalidBody", "payload is not a JSON envelope object");
    }
    if (envelope?.type !== ENVELOPE_TYPE) throw new BodyError("wrongEnvelopeType", `envelope type ${envelope?.type}`);
    return checkDocument(envelope.document);
  },
};

// ---------------------------------------------------------------- CTT1 dictionaries (frozen for format 0x01)

/** Object keys written as their index. Never edit: a new list needs a new format byte. */
export const CTT1_KEYS: readonly string[] = Object.freeze([
  "id", "type", "issuer", "recipient", "issuedAt", "expiresAt", "threadId", "payload", "proof", "@context",
  "validFrom", "validUntil", "credentialSubject", "credentialStatus", "statusListIndex", "statusListCredential",
  "statusPurpose", "code", "message", "retryable", "challenge", "credential", "claim", "termsHash",
  "at", "note", "sensor", "t", "kind", "value", "unit",
  "cryptosuite", "verificationMethod", "proofPurpose", "proofValue", "created", "name", "open", "reason",
  "holder", "nonce", "door", "role", "attestation", "readings", "amount", "currency", "status",
]);

/** Whole strings written as their index. */
export const CTT1_STRINGS: readonly string[] = Object.freeze([
  "https://www.w3.org/ns/credentials/v2", "VerifiableCredential", "BitstringStatusListEntry", "DataIntegrityProof",
  "eddsa-jcs-2022", "assertionMethod", "https://trusttasks.org/spec/trust-task-error/0.6", "settle/attestation",
  "complete", "not-complete", "authentication", "revocation", "settle/acceptance", "settle/dispute",
]);

/** String prefixes written as `[index, rest]`. */
export const CTT1_PREFIXES: readonly string[] = Object.freeze([
  "https://zk-toip.example/spec/", "https://trusttasks.org/spec/", "https://trusttasks.org/",
]);

const TAG_EPOCH_S = 1;
const TAG_DID_KEY = 6;
const TAG_DID_KEY_VM = 7;
const TAG_EPOCH_MS = 8;
const TAG_STRING = 9;
const TAG_PREFIX = 10;
const TAG_PROOF = 11;
const TAG_UUID = 37;
const SIMPLE_SENDER = 16;
const SIMPLE_RECEIVER = 17;
const MAX_DEPTH = 64;

const KEY_INDEX = new Map(CTT1_KEYS.map((k, i) => [k, i]));
const STRING_INDEX = new Map(CTT1_STRINGS.map((s, i) => [s, i]));
const PREFIXES_LONGEST_FIRST = CTT1_PREFIXES.map((p, i) => ({ p, i })).sort((a, b) => b.p.length - a.p.length);

const UUID = /^urn:uuid:([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/;
const TS_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const TS_S = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

const didKeyCache = new Map<string, Uint8Array | null>();
/** The 32-byte key of a canonical Ed25519 did:key, or null. */
function didKeyBytes(s: string): Uint8Array | null {
  if (!s.startsWith("did:key:z") || s.includes("#")) return null;
  const hit = didKeyCache.get(s);
  if (hit !== undefined) return hit;
  let out: Uint8Array | null = null;
  try {
    const k = publicKeyFromDidKey(s);
    if (k && k.curve === "ed25519" && k.bytes.length === 32 && didKeyOf(k.bytes) === s) out = k.bytes;
  } catch {
    out = null;
  }
  if (didKeyCache.size > 1000) didKeyCache.clear();
  didKeyCache.set(s, out);
  return out;
}

const didKeyOf = (key: Uint8Array) => didKeyFromPublicKey({ curve: "ed25519", bytes: key }).split("#")[0];

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function writeString(w: CborWriter, s: string, ctx: BodyContext): void {
  if (s === ctx.sender) return w.simple(SIMPLE_SENDER);
  if (s === ctx.receiver) return w.simple(SIMPLE_RECEIVER);
  const key = didKeyBytes(s);
  if (key) {
    w.head(MT.tag, TAG_DID_KEY);
    return w.bytes(key);
  }
  const hash = s.indexOf("#");
  if (hash > 0 && s.startsWith("did:key:z")) {
    const did = s.slice(0, hash);
    const k = didKeyBytes(did);
    if (k && s.slice(hash + 1) === did.slice("did:key:".length)) {
      w.head(MT.tag, TAG_DID_KEY_VM);
      return w.bytes(k);
    }
  }
  const u = UUID.exec(s);
  if (u) {
    w.head(MT.tag, TAG_UUID);
    return w.bytes(hexBytes(u.slice(1).join("")));
  }
  if (TS_MS.test(s)) {
    const ms = Date.parse(s);
    if (ms >= 0 && new Date(ms).toISOString() === s) {
      w.head(MT.tag, TAG_EPOCH_MS);
      return w.head(MT.uint, ms);
    }
  }
  if (TS_S.test(s)) {
    const ms = Date.parse(s);
    if (ms >= 0 && ms % 1000 === 0 && new Date(ms).toISOString() === s.replace(/Z$/, ".000Z")) {
      w.head(MT.tag, TAG_EPOCH_S);
      return w.head(MT.uint, ms / 1000);
    }
  }
  const idx = STRING_INDEX.get(s);
  if (idx !== undefined) {
    w.head(MT.tag, TAG_STRING);
    return w.head(MT.uint, idx);
  }
  for (const { p, i } of PREFIXES_LONGEST_FIRST) {
    if (s.startsWith(p)) {
      w.head(MT.tag, TAG_PREFIX);
      w.head(MT.array, 2);
      w.head(MT.uint, i);
      return w.text(s.slice(p.length));
    }
  }
  w.text(s);
}

const PROOF_KEYS = ["type", "cryptosuite", "created", "verificationMethod", "proofPurpose", "proofValue"];

/** The raw signature of a proof `signTrustTask` would write for `issuer`, or null. */
function standardProof(issuer: unknown, proof: unknown): { created: string; signature: Uint8Array } | null {
  if (typeof issuer !== "string" || !didKeyBytes(issuer)) return null;
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) return null;
  const p = proof as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== PROOF_KEYS.length || keys.some((k, i) => k !== PROOF_KEYS[i])) return null;
  if (p.type !== "DataIntegrityProof" || p.cryptosuite !== "eddsa-jcs-2022" || p.proofPurpose !== "assertionMethod") return null;
  if (typeof p.created !== "string" || typeof p.proofValue !== "string") return null;
  if (p.verificationMethod !== `${issuer}#${issuer.slice("did:key:".length)}`) return null;
  try {
    const sig = fromMultibase(p.proofValue);
    if (sig.length !== 64 || toMultibase(sig) !== p.proofValue) return null;
    return { created: p.created, signature: sig };
  } catch {
    return null;
  }
}

function writeValue(w: CborWriter, v: unknown, ctx: BodyContext, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error("ctt1: too deep");
  if (v === null) return w.simple(22);
  if (v === true) return w.simple(21);
  if (v === false) return w.simple(20);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("ctt1: not a JSON number");
    return Number.isSafeInteger(v) ? w.int(v) : w.float(v);
  }
  if (typeof v === "string") return writeString(w, v, ctx);
  if (Array.isArray(v)) {
    w.head(MT.array, v.length);
    for (const x of v) writeValue(w, x, ctx, depth + 1);
    return;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    w.head(MT.map, keys.length);
    for (const k of keys) {
      const idx = KEY_INDEX.get(k);
      if (idx !== undefined) w.head(MT.uint, idx);
      else w.text(k);
      const proof = k === "proof" ? standardProof(o.issuer, o.proof) : null;
      if (proof) {
        w.head(MT.tag, TAG_PROOF);
        w.head(MT.array, 2);
        writeString(w, proof.created, ctx);
        w.bytes(proof.signature);
      } else writeValue(w, o[k], ctx, depth + 1);
    }
    return;
  }
  throw new Error(`ctt1: not a JSON value: ${typeof v}`);
}

class ProofRef {
  constructor(
    readonly created: string,
    readonly signature: Uint8Array,
  ) {}
}

class Ctt1Reader {
  private readonly r: CborReader;
  constructor(
    body: Uint8Array,
    private readonly ctx: BodyContext,
  ) {
    this.r = new CborReader(body, 1);
  }

  document(): unknown {
    const v = this.value(0);
    if (!this.r.done) throw new Error("ctt1: trailing bytes");
    if (v instanceof ProofRef) throw new Error("ctt1: misplaced proof");
    return v;
  }

  private bytes(n?: number): Uint8Array {
    const h = this.r.head();
    if (h.major !== MT.bytes || (n !== undefined && h.value !== n)) throw new Error("ctt1: expected bytes");
    return this.r.body(h.value).slice();
  }

  private uint(): number {
    const h = this.r.head();
    if (h.major !== MT.uint) throw new Error("ctt1: expected an unsigned integer");
    return h.value;
  }

  private string(depth: number): string {
    const v = this.value(depth);
    if (typeof v !== "string") throw new Error("ctt1: expected a string");
    return v;
  }

  private count(n: number): number {
    // Every element takes at least one byte, so a count can't exceed what's left.
    if (n > this.r.data.length - this.r.pos) throw new Error("ctt1: truncated");
    return n;
  }

  private value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error("ctt1: too deep");
    const h = this.r.head();
    switch (h.major) {
      case MT.uint:
        return h.value;
      case MT.neg:
        return -1 - h.value;
      case MT.text:
        return this.r.textBody(h.value);
      case MT.array: {
        const n = this.count(h.value);
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) {
          const x = this.value(depth + 1);
          if (x instanceof ProofRef) throw new Error("ctt1: misplaced proof");
          out.push(x);
        }
        return out;
      }
      case MT.map:
        return this.map(this.count(h.value), depth);
      case MT.tag:
        return this.tagged(h.value, depth);
      case MT.simple:
        if (h.float) return h.value;
        if (h.value === 20) return false;
        if (h.value === 21) return true;
        if (h.value === 22) return null;
        if (h.value === SIMPLE_SENDER) return this.ctx.sender;
        if (h.value === SIMPLE_RECEIVER) return this.ctx.receiver;
        throw new Error(`ctt1: unknown simple value ${h.value}`);
      default:
        throw new Error(`ctt1: unexpected major type ${h.major}`);
    }
  }

  private map(n: number, depth: number): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    let proofKey: string | undefined;
    for (let i = 0; i < n; i++) {
      const kh = this.r.head();
      let key: string;
      if (kh.major === MT.uint) {
        const k = CTT1_KEYS[kh.value];
        if (k === undefined) throw new Error("ctt1: unknown key index");
        key = k;
      } else if (kh.major === MT.text) key = this.r.textBody(kh.value);
      else throw new Error("ctt1: bad key");
      if (Object.prototype.hasOwnProperty.call(o, key)) throw new Error("ctt1: duplicate key");
      const v = this.value(depth + 1);
      if (v instanceof ProofRef) {
        if (key !== "proof") throw new Error("ctt1: misplaced proof");
        proofKey = key;
      }
      Object.defineProperty(o, key, { value: v, enumerable: true, writable: true, configurable: true });
    }
    if (proofKey) {
      const ref = o[proofKey] as ProofRef;
      const issuer = o.issuer;
      if (typeof issuer !== "string" || !didKeyBytes(issuer)) throw new Error("ctt1: compact proof without a did:key issuer");
      o[proofKey] = {
        type: "DataIntegrityProof",
        cryptosuite: "eddsa-jcs-2022",
        created: ref.created,
        verificationMethod: `${issuer}#${issuer.slice("did:key:".length)}`,
        proofPurpose: "assertionMethod",
        proofValue: toMultibase(ref.signature),
      };
    }
    return o;
  }

  private tagged(tag: number, depth: number): unknown {
    switch (tag) {
      case TAG_DID_KEY:
        return didKeyOf(this.bytes(32));
      case TAG_DID_KEY_VM:
        return didKeyFromPublicKey({ curve: "ed25519", bytes: this.bytes(32) });
      case TAG_UUID: {
        const h = toHex(this.bytes(16));
        return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
      case TAG_EPOCH_MS:
        return isoAt(this.uint());
      case TAG_EPOCH_S:
        return isoAt(this.uint() * 1000).replace(/\.000Z$/, "Z");
      case TAG_STRING: {
        const s = CTT1_STRINGS[this.uint()];
        if (s === undefined) throw new Error("ctt1: unknown string index");
        return s;
      }
      case TAG_PREFIX: {
        const h = this.r.head();
        if (h.major !== MT.array || h.value !== 2) throw new Error("ctt1: bad prefix form");
        const p = CTT1_PREFIXES[this.uint()];
        if (p === undefined) throw new Error("ctt1: unknown prefix index");
        const rest = this.r.head();
        if (rest.major !== MT.text) throw new Error("ctt1: bad prefix rest");
        return p + this.r.textBody(rest.value);
      }
      case TAG_PROOF: {
        const h = this.r.head();
        if (h.major !== MT.array || h.value !== 2) throw new Error("ctt1: bad proof form");
        return new ProofRef(this.string(depth + 1), this.bytes(64));
      }
      default:
        throw new Error(`ctt1: unknown tag ${tag}`);
    }
  }
}

function isoAt(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error("ctt1: time out of range");
  return d.toISOString();
}

/** CTT1, format 0x01 (mesh design §8.1). */
export const ctt1: BodyCodec = {
  format: CTT1_FORMAT,
  encode(doc, ctx) {
    try {
      // Encode what a JSON reader would see, then prove the decoder gives exactly that back.
      const json = JSON.stringify(doc);
      const w = new CborWriter();
      w.byte(CTT1_FORMAT);
      writeValue(w, JSON.parse(json), ctx, 0);
      const body = w.done();
      return JSON.stringify(ctt1.decode(body, ctx)) === json ? body : null;
    } catch {
      return null;
    }
  },
  decode(body, ctx) {
    if (body[0] !== CTT1_FORMAT) throw new BodyError("invalidBody", "not a CTT1 body");
    let doc: unknown;
    try {
      doc = new Ctt1Reader(body, ctx).document();
    } catch (e) {
      throw new BodyError("invalidBody", e instanceof Error ? e.message : String(e));
    }
    return checkDocument(doc);
  },
};

/** The body for `doc`: `codec`'s form when it has one that carries `doc` exactly, otherwise JSON. */
export function encodeBody(doc: TrustTaskDocument<unknown>, ctx: BodyContext, codec?: BodyCodec): Uint8Array {
  if (codec && codec.format !== JSON_FORMAT) {
    const body = codec.encode(doc, ctx);
    if (body) return body;
  }
  return jsonBody.encode(doc, ctx)!;
}

/** Reads a body of any known format, choosing by its first byte. Throws `BodyError`. */
export function decodeBody(body: Uint8Array, ctx: BodyContext): TrustTaskDocument<unknown> {
  return body[0] === CTT1_FORMAT ? ctt1.decode(body, ctx) : jsonBody.decode(body, ctx);
}
