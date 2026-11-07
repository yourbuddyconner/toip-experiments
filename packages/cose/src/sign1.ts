/**
 * COSE_Sign1 (RFC 9052 §4.2), tag 18, with an attached payload.
 *
 * The protected header carries alg (1), the content type (3) when given, and the kid (4) unless omitted.
 * Verification takes the alg from the protected header only, and refuses critical headers (2), since
 * this library understands none.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { decodeCbor, encodeCbor, Tagged } from "./cbor";
import { curveOf, type AsyncSigner, type CoseAlg, type PublicKey } from "./signers";
import { checkWebAuthn, type WebAuthnInfo } from "./webauthn";

const ALGS: readonly CoseAlg[] = [-19, -9, -8, -7, -65600];
const COSE_SIGN1 = 18;
const EMPTY = new Uint8Array(0);

export interface SignOptions {
  /** Header 3: a media type, or a CoAP content-format number. */
  contentType?: string | number;
  /** Leave the kid out of the protected header (radio frames). */
  omitKid?: boolean;
  /** Unprotected header parameters. Default: none. */
  unprotected?: Map<number, unknown>;
  /** Bound into the signature but not sent (RFC 9052 §4.3). */
  externalAad?: Uint8Array;
}

/** The bytes a COSE_Sign1 signature covers: `["Signature1", protected, external_aad, payload]`. */
export function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array, externalAad: Uint8Array = EMPTY): Uint8Array {
  return encodeCbor(["Signature1", protectedBytes, externalAad, payload]);
}

export async function signCose1(payload: Uint8Array, signer: AsyncSigner, opts: SignOptions = {}): Promise<Uint8Array> {
  const headers = new Map<number, unknown>([[1, signer.alg]]);
  if (opts.contentType !== undefined) headers.set(3, opts.contentType);
  if (!opts.omitKid) headers.set(4, signer.kid);
  const prot = encodeCbor(headers);
  const signature = await signer.sign(sigStructure(prot, payload, opts.externalAad));
  return encodeCbor(new Tagged(COSE_SIGN1, [prot, opts.unprotected ?? new Map(), payload, signature]));
}

export interface CoseVerified {
  payload: Uint8Array;
  alg: CoseAlg;
  kid?: Uint8Array;
  protected: Map<number, unknown>;
  webauthn?: WebAuthnInfo;
}

export type CoseFailure = "malformed" | "algNotAllowed" | "keyMismatch" | "signatureInvalid" | "webauthnChallenge" | "webauthnOrigin" | "webauthnFlags";

export interface VerifyOptions {
  /** Default: all five algorithms. */
  allowedAlgs?: CoseAlg[];
  /** Origins a -65600 signature may come from. Required for -65600. */
  webauthnOrigins?: string[];
  externalAad?: Uint8Array;
}

/** Finds the keys that may have signed: for a device, its current key and, around a rotation, the previous one. */
export type KeyLookup = (kid: Uint8Array | undefined, alg: CoseAlg) => Promise<PublicKey[]>;

export type VerifyResult = { ok: true; value: CoseVerified } | { ok: false; failure: CoseFailure };

const fail = (failure: CoseFailure): VerifyResult => ({ ok: false, failure });

interface Parsed {
  prot: Uint8Array;
  headers: Map<number, unknown>;
  unprot: Map<number, unknown>;
  payload: Uint8Array;
  signature: Uint8Array;
}

function parse(bytes: Uint8Array): Parsed | null {
  try {
    let v = decodeCbor(bytes, { strict: false, useMaps: true });
    if (v instanceof Tagged) {
      if (v.tag !== COSE_SIGN1) return null;
      v = v.value;
    }
    if (!Array.isArray(v) || v.length !== 4) return null;
    const [prot, unprot, payload, signature] = v;
    if (!(prot instanceof Uint8Array) || !(unprot instanceof Map) || !(payload instanceof Uint8Array) || !(signature instanceof Uint8Array)) return null;
    const headers = prot.length === 0 ? new Map() : decodeCbor(prot, { strict: false, useMaps: true });
    if (!(headers instanceof Map)) return null;
    return { prot, headers, unprot, payload, signature };
  } catch {
    return null;
  }
}

export async function verifyCose1(bytes: Uint8Array, key: KeyLookup, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const m = parse(bytes);
  if (!m) return fail("malformed");
  const { headers, unprot } = m;
  const alg = headers.get(1);
  if (typeof alg !== "number" || unprot.has(1) || headers.has(2)) return fail("malformed");
  if (!ALGS.includes(alg as CoseAlg) || !(opts.allowedAlgs ?? ALGS).includes(alg as CoseAlg)) return fail("algNotAllowed");
  const a = alg as CoseAlg;
  const kid = headers.get(4) ?? unprot.get(4);
  if (kid !== undefined && !(kid instanceof Uint8Array)) return fail("malformed");

  const tbs = sigStructure(m.prot, m.payload, opts.externalAad);
  let check: (k: PublicKey) => boolean;
  let webauthn: WebAuthnInfo | undefined;
  if (a === -65600) {
    const w = checkWebAuthn(m.signature, tbs, opts.webauthnOrigins ?? []);
    if (!w.ok) return fail(w.failure);
    webauthn = w.info;
    check = (k) => verifyP256(w.signature, w.signed, k.bytes, "der");
  } else if (curveOf(a) === "ed25519") {
    if (m.signature.length !== 64) return fail("malformed");
    check = (k) => {
      try {
        return ed25519.verify(m.signature, tbs, k.bytes, { zip215: false });
      } catch {
        return false;
      }
    };
  } else {
    if (m.signature.length !== 64) return fail("malformed");
    check = (k) => verifyP256(m.signature, tbs, k.bytes, "compact");
  }

  const candidates = (await key(kid, a)).filter((k) => k.curve === curveOf(a));
  if (!candidates.length) return fail("keyMismatch");
  if (!candidates.some(check)) return fail("signatureInvalid");
  return { ok: true, value: { payload: m.payload, alg: a, kid, protected: headers, ...(webauthn ? { webauthn } : {}) } };
}

// SubjectPublicKeyInfo header for an uncompressed P-256 point, as PublicKeyCredential.getPublicKey() returns it.
const P256_SPKI = Uint8Array.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]);

function p256Point(bytes: Uint8Array): Uint8Array {
  if (bytes.length === P256_SPKI.length + 65 && P256_SPKI.every((b, i) => bytes[i] === b)) return bytes.subarray(P256_SPKI.length);
  return bytes;
}

function verifyP256(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array, format: "der" | "compact"): boolean {
  try {
    return p256.verify(sig, msg, p256Point(pub), { prehash: true, lowS: false, format });
  } catch {
    return false;
  }
}
