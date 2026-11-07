/**
 * Signers (async and pluggable), cold key sources, and signature verification.
 * A signer's secret may never leave it: WebCrypto non-extractable keys and WebAuthn authenticators fit.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromUtf8, toB64u, utf8, type Identity } from "@toip-tools/trust-core";
import { decode, encode, nextKeyDigest, sigCurve } from "./cesr";
import type { IndexedSig, Qb64, WebAuthnWrap } from "./types";

export type Curve = "ed25519" | "p256";

/** What a signer returns: a 64-byte signature, or one wrapped in a WebAuthn assertion. */
export interface WrappedSignature {
  sig: Uint8Array;
  wrap: WebAuthnWrap;
}

export interface Signer {
  /** Defaults to Ed25519 when absent. */
  readonly curve?: Curve;
  /** 32 bytes for Ed25519; 33 bytes (compressed point) for P-256. */
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array | WrappedSignature>;
}

export function curveOf(s: Signer): Curve {
  return s.curve ?? "ed25519";
}

/** The signer's public key as a transferable KERI key: D (Ed25519) or 1AAJ (P-256). */
export function keyQb64(s: Signer): Qb64 {
  return encode(curveOf(s) === "p256" ? "1AAJ" : "D", s.publicKey);
}

export function ed25519Signer(secret: Uint8Array): Signer {
  const sk = secret.slice(0, 32);
  return {
    curve: "ed25519",
    publicKey: ed25519.getPublicKey(sk),
    sign: async (m) => ed25519.sign(m, sk),
  };
}

export function p256Signer(secret: Uint8Array): Signer {
  const sk = secret.slice(0, 32);
  return {
    curve: "p256",
    publicKey: p256.getPublicKey(sk, true),
    sign: async (m) => p256.sign(m, sk),
  };
}

/** Reuses a did:key identity's Ed25519 key. */
export function signerFromIdentity(id: Identity): Signer {
  return ed25519Signer(id.signingSecret);
}

/** A WebCrypto key pair (Ed25519 or ECDSA P-256). The private key may be non-extractable. */
export async function webCryptoSigner(pair: CryptoKeyPair): Promise<Signer> {
  const name = pair.privateKey.algorithm.name;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  if (name === "Ed25519") {
    return {
      curve: "ed25519",
      publicKey: pub,
      sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, m as BufferSource)),
    };
  }
  if (name === "ECDSA" && (pair.privateKey.algorithm as EcKeyAlgorithm).namedCurve === "P-256") {
    return {
      curve: "p256",
      publicKey: p256.Point.fromBytes(pub).toBytes(true),
      sign: async (m) =>
        new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, m as BufferSource)),
    };
  }
  throw new Error(`unsupported WebCrypto key: ${name}`);
}

export interface WebAuthnAssertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** DER, as WebAuthn returns it. Compact r||s is accepted too. */
  signature: Uint8Array;
}

/**
 * A hook for passkeys. `getAssertion` runs navigator.credentials.get with the given challenge,
 * which is SHA-256 of the message. The event then carries the assertion (our `-Y` group; not KERI).
 */
export function webAuthnSigner(opts: { publicKey: Uint8Array; getAssertion: (challenge: Uint8Array) => Promise<WebAuthnAssertion> }): Signer {
  const publicKey = opts.publicKey.length === 33 ? opts.publicKey : p256.Point.fromBytes(opts.publicKey).toBytes(true);
  return {
    curve: "p256",
    publicKey,
    sign: async (m) => {
      const a = await opts.getAssertion(sha256(m));
      const sig = a.signature.length === 64 ? a.signature : p256.Signature.fromBytes(a.signature, "der").toBytes("compact");
      return { sig, wrap: { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON } };
    },
  };
}

/** Signs and returns the indexed signature value, unwrapping WebAuthn results. */
export async function signWith(s: Signer, message: Uint8Array): Promise<{ sig: Uint8Array; wrap?: WebAuthnWrap }> {
  const out = await s.sign(message);
  if (out instanceof Uint8Array) {
    if (out.length !== 64) throw new Error("signer returned a signature that is not 64 bytes");
    return { sig: out };
  }
  return { sig: out.sig, wrap: out.wrap };
}

// ---- cold keys

export interface ColdKeys {
  /** Next-key digests for key set `set`. */
  commit(set: number, count: number): Qb64[];
  /** The signers of key set `set`; only for rotation. */
  release(set: number, count: number): Signer[];
}

/** Key set j is HKDF-SHA256(seed, salt "zk-toip/eventlog", info "<label>/<j>/<n>"). */
export function coldKeysFromSeed(rotationSeed: Uint8Array, label: string, opts: { curve?: Curve } = {}): ColdKeys {
  const curve = opts.curve ?? "ed25519";
  const derive = (set: number, n: number): Signer => {
    const okm = hkdf(sha256, rotationSeed, utf8("zk-toip/eventlog"), utf8(`${label}/${set}/${n}`), curve === "p256" ? 48 : 32);
    return curve === "p256" ? p256Signer(p256.utils.randomSecretKey(okm)) : ed25519Signer(okm);
  };
  const release = (set: number, count: number) => Array.from({ length: count }, (_, n) => derive(set, n));
  return {
    commit: (set, count) => release(set, count).map((s) => nextKeyDigest(keyQb64(s))),
    release,
  };
}

// ---- verification

export interface WebAuthnPolicy {
  /** Accepted `clientDataJSON.origin` values. Any origin when absent. */
  origins?: string[];
  /** Accepted RP ids; the authenticator data's rpIdHash must be SHA-256 of one. Not checked when absent. */
  rpIds?: string[];
  requireUserVerified?: boolean;
}

export interface SigOptions {
  /** A pluggable verifier, tried first. Return undefined to fall back to the built-in checks. */
  verifySig?: (input: { key: Qb64; message: Uint8Array; sig: IndexedSig }) => Promise<boolean | undefined> | boolean | undefined;
  /** How to check WebAuthn-wrapped signatures. `false` rejects them. */
  webauthn?: WebAuthnPolicy | false;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function checkWebAuthn(key: Uint8Array, message: Uint8Array, sig: Uint8Array, wrap: WebAuthnWrap, policy: WebAuthnPolicy): boolean {
  let client: { type?: string; challenge?: string; origin?: string };
  try {
    client = JSON.parse(fromUtf8(wrap.clientDataJSON));
  } catch {
    return false;
  }
  if (client.type !== "webauthn.get") return false;
  if (client.challenge !== toB64u(sha256(message))) return false;
  if (policy.origins && !policy.origins.includes(String(client.origin))) return false;
  const ad = wrap.authenticatorData;
  if (ad.length < 37) return false;
  const flags = ad[32];
  if (!(flags & 0x01)) return false;
  if (policy.requireUserVerified && !(flags & 0x04)) return false;
  if (policy.rpIds && !policy.rpIds.some((id) => eq(sha256(utf8(id)), ad.slice(0, 32)))) return false;
  const signed = new Uint8Array(ad.length + 32);
  signed.set(ad);
  signed.set(sha256(wrap.clientDataJSON), ad.length);
  return p256.verify(sig, signed, key, { lowS: false });
}

/** Verifies one indexed signature by a transferable key over `message`. Never throws. */
export async function verifyKeySig(key: Qb64, message: Uint8Array, sig: IndexedSig, opts: SigOptions = {}): Promise<boolean> {
  try {
    if (opts.verifySig) {
      const r = await opts.verifySig({ key, message, sig });
      if (r !== undefined) return r;
    }
    const { code, raw } = decode(key);
    const curve = sigCurve(sig.code);
    if (sig.wrap) {
      if (opts.webauthn === false || curve !== "p256" || code !== "1AAJ") return false;
      return checkWebAuthn(raw, message, sig.sig, sig.wrap, opts.webauthn ?? {});
    }
    if (code === "D" || code === "B") return curve === "ed25519" && ed25519.verify(sig.sig, message, raw);
    if (code === "1AAJ" || code === "1AAI") return curve === "p256" && p256.verify(sig.sig, message, raw, { lowS: false });
    return false;
  } catch {
    return false;
  }
}

/** Verifies a non-indexed Ed25519 signature by a B or D key. Never throws. */
export function verifyCouple(signer: Qb64, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    const { code, raw } = decode(signer);
    if (code === "B" || code === "D") return ed25519.verify(sig, message, raw);
    if (code === "1AAI" || code === "1AAJ") return p256.verify(sig, message, raw, { lowS: false });
    return false;
  } catch {
    return false;
  }
}
