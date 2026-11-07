/**
 * Signers. All of them are async, so keys that never give up their secret can sign:
 * non-extractable WebCrypto keys, passkeys, secure elements. A seed works too.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeCbor } from "./cbor.js";

/** Ed25519 (-19), ESP256 (-9), EdDSA (-8), ES256 (-7), and the private-use WebAuthn-wrapped ES256 (-65600). */
export type CoseAlg = -19 | -9 | -8 | -7 | -65600;
export const ALG = { Ed25519: -19, ESP256: -9, EdDSA: -8, ES256: -7, WebAuthnES256: -65600 } as const;

export type Curve = "ed25519" | "p256";
export interface PublicKey {
  curve: Curve;
  /** Ed25519: 32 bytes. P-256: a SEC1 point (33 or 65 bytes) or a SubjectPublicKeyInfo. */
  bytes: Uint8Array;
}

/** A key that may not give up its secret: WebCrypto, WebAuthn, a secure element, or a seed. */
export interface AsyncSigner {
  alg: CoseAlg;
  kid: Uint8Array;
  publicKey: PublicKey;
  /** Signs the Sig_structure bytes. For -65600 it returns CBOR `[authenticatorData, clientDataJSON, signature]`. */
  sign(toBeSigned: Uint8Array): Promise<Uint8Array>;
}

export const curveOf = (alg: CoseAlg): Curve => (alg === -19 || alg === -8 ? "ed25519" : "p256");

/** An Ed25519 signer from a 32-byte seed. */
export function seedSigner(seed: Uint8Array, kid: Uint8Array, alg: -19 | -8 = -19): AsyncSigner {
  if (seed.length !== 32) throw new Error("seedSigner: the seed must be 32 bytes");
  const secret = seed.slice();
  return {
    alg,
    kid,
    publicKey: { curve: "ed25519", bytes: ed25519.getPublicKey(secret) },
    sign: async (tbs) => ed25519.sign(tbs, secret),
  };
}

/**
 * A signer from a WebCrypto key pair: Ed25519, or ECDSA P-256. The private key may be non-extractable;
 * only the public key is exported. WebCrypto's ECDSA output is already the raw r || s that COSE wants.
 */
export async function webCryptoSigner(key: CryptoKeyPair, kid: Uint8Array, alg?: CoseAlg): Promise<AsyncSigner> {
  const a = key.privateKey.algorithm as EcKeyAlgorithm;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  if (a.name === "Ed25519") {
    const chosen = alg ?? -19;
    if (chosen !== -19 && chosen !== -8) throw new Error(`webCryptoSigner: alg ${chosen} doesn't fit an Ed25519 key`);
    return { alg: chosen, kid, publicKey: { curve: "ed25519", bytes: raw }, sign: async (tbs) => new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, buf(tbs))) };
  }
  if (a.name === "ECDSA" && a.namedCurve === "P-256") {
    const chosen = alg ?? -9;
    if (chosen !== -9 && chosen !== -7) throw new Error(`webCryptoSigner: alg ${chosen} doesn't fit a P-256 key`);
    return {
      alg: chosen,
      kid,
      publicKey: { curve: "p256", bytes: raw },
      sign: async (tbs) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, buf(tbs))),
    };
  }
  throw new Error(`webCryptoSigner: unsupported key (${a.name} ${a.namedCurve ?? ""})`);
}

/** `navigator.credentials.get`, or a stand-in for tests. */
export type WebAuthnGet = (options: CredentialRequestOptions) => Promise<
  { response: { authenticatorData: ArrayBuffer; clientDataJSON: ArrayBuffer; signature: ArrayBuffer } } | Credential | null
>;

/**
 * A passkey as a signer (alg -65600). Each signature is a WebAuthn assertion whose challenge is
 * SHA-256 of the Sig_structure, with user verification required, so each one asks for the biometric or PIN.
 */
export function webAuthnSigner(opts: { credentialId: Uint8Array; rpId: string; publicKey: Uint8Array; kid: Uint8Array; get?: WebAuthnGet; timeout?: number }): AsyncSigner {
  const get: WebAuthnGet = opts.get ?? ((o) => navigator.credentials.get(o));
  return {
    alg: -65600,
    kid: opts.kid,
    publicKey: { curve: "p256", bytes: opts.publicKey },
    async sign(tbs) {
      const c = (await get({
        publicKey: {
          challenge: buf(sha256(tbs)),
          rpId: opts.rpId,
          allowCredentials: [{ type: "public-key", id: buf(opts.credentialId) }],
          userVerification: "required",
          timeout: opts.timeout,
        },
      })) as { response?: Partial<AuthenticatorAssertionResponse> } | null;
      const r = c?.response;
      if (!r?.authenticatorData || !r.clientDataJSON || !r.signature) throw new Error("webAuthnSigner: the passkey gave no assertion");
      return encodeCbor([new Uint8Array(r.authenticatorData), new Uint8Array(r.clientDataJSON), new Uint8Array(r.signature)]);
    },
  };
}

export const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
