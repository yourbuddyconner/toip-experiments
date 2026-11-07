import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { didKeyFromPublicKey, publicKeyFromDidKey, signerFromPrivateKey, type Signer } from "@openvtc/trust-tasks-proof";

/** One agent's keys. The X25519 encryption key is derived from the Ed25519 key, as the P2P Trust Stack does. */
export interface Identity {
  did: string;
  signingSecret: Uint8Array;
  signingPublic: Uint8Array;
  encryptionSecret: Uint8Array;
  encryptionPublic: Uint8Array;
  signer: Signer;
}

/**
 * Derives a reproducible seed by hashing a label with SHA-256.
 * A guessable label produces a guessable identity; use a securely generated seed for real accounts.
 * @param label Text encoded as UTF-8 before hashing.
 * @returns The 32-byte digest, suitable for deterministic fixtures and demos.
 */
export function seedFrom(label: string): Uint8Array {
  return sha256(utf8ToBytes(label));
}

/**
 * Builds an Ed25519 did:key identity and derives its X25519 encryption keys.
 * The returned identity holds secret key bytes in memory; the caller owns their storage and lifetime.
 * @param seed Seed whose first 32 bytes become the Ed25519 signing secret. Supply at least 32 bytes.
 * @returns The DID, signing and encryption key pairs, and a Data Integrity signer.
 * @throws If the selected seed bytes are not a valid Ed25519 secret key length.
 */
export function identityFromSeed(seed: Uint8Array): Identity {
  const signingSecret = seed.slice(0, 32);
  const signingPublic = ed25519.getPublicKey(signingSecret);
  return {
    did: didKeyFromPublicKey({ curve: "ed25519", bytes: signingPublic }).split("#")[0],
    signingSecret,
    signingPublic,
    encryptionSecret: ed25519.utils.toMontgomerySecret(signingSecret),
    encryptionPublic: ed25519.utils.toMontgomery(signingPublic),
    signer: signerFromPrivateKey("ed25519", signingSecret),
  };
}

/**
 * Resolves an Ed25519 did:key locally and derives its X25519 public key without network access.
 * @param did The Ed25519 did:key identifier to decode.
 * @returns Public keys for verifying signatures and encrypting to this identity.
 * @throws If the identifier cannot be decoded or does not name an Ed25519 did:key.
 */
export function resolveDidKey(did: string): { signingKey: Uint8Array; encryptionKey: Uint8Array } {
  const key = did.startsWith("did:key:") ? publicKeyFromDidKey(did) : null;
  if (!key || key.curve !== "ed25519") throw new Error("not an Ed25519 did:key");
  return { signingKey: key.bytes, encryptionKey: ed25519.utils.toMontgomery(key.bytes) };
}
