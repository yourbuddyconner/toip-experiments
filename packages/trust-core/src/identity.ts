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

export function seedFrom(label: string): Uint8Array {
  return sha256(utf8ToBytes(label));
}

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

/** Public keys of an Ed25519 did:key. No resolver, no network. */
export function resolveDidKey(did: string): { signingKey: Uint8Array; encryptionKey: Uint8Array } {
  const key = did.startsWith("did:key:") ? publicKeyFromDidKey(did) : null;
  if (!key || key.curve !== "ed25519") throw new Error("not an Ed25519 did:key");
  return { signingKey: key.bytes, encryptionKey: ed25519.utils.toMontgomery(key.bytes) };
}
