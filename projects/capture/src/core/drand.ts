/**
 * drand beacons for "not before" (design §10.1). Quicknet signs each round number with BLS on G1
 * (bls-unchained-g1-rfc9380); the round's randomness is SHA-256 of the signature.
 * A "dev" chain uses the same scheme with a key the capture server makes, for tests and offline demos.
 */
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { equal, fromHex, hex } from "./bytes";

export const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

export interface DrandChain {
  kind: "drand-quicknet" | "drand-dev";
  hash: string;
  publicKey: Uint8Array;
  /** Unix seconds. */
  genesis: number;
  /** Seconds. */
  period: number;
}

export const QUICKNET: DrandChain = {
  kind: "drand-quicknet",
  hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey: fromHex(
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  ),
  genesis: 1692803367,
  period: 3,
};

export interface Round {
  round: number;
  signature: Uint8Array;
  randomness: Uint8Array;
}

function roundMessage(round: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(round));
  return sha256(b);
}

/** Unix milliseconds at which a round is published. */
export const roundTime = (c: DrandChain, round: number) => (c.genesis + (round - 1) * c.period) * 1000;
/** The latest round published at `ms`. */
export const roundAt = (c: DrandChain, ms: number) => Math.max(1, Math.floor((ms / 1000 - c.genesis) / c.period) + 1);

export const randomnessOf = (signature: Uint8Array) => sha256(signature);

const cache = new Map<string, boolean>();

/** Checks a round's BLS signature. About 100 ms; results are cached. */
export function verifyRound(c: DrandChain, round: number, signature: Uint8Array): boolean {
  const key = `${c.hash}:${round}:${hex(signature)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const bls = bls12_381.shortSignatures;
    ok = bls.verify(signature, bls.hash(roundMessage(round), DST), c.publicKey);
  } catch {
    ok = false;
  }
  cache.set(key, ok);
  return ok;
}

/** A signed beacon claim (round, prefix) checks out against the round's signature. */
export function verifyBeaconClaim(c: DrandChain, round: number, prefix: Uint8Array, signature: Uint8Array): boolean {
  return prefix.length >= 2 && equal(randomnessOf(signature).subarray(0, prefix.length), prefix) && verifyRound(c, round, signature);
}

/** A dev chain: same scheme, a local key. */
export function devChain(secretKey: Uint8Array, genesis: number, period = 3): { chain: DrandChain; sign(round: number): Round } {
  const bls = bls12_381.shortSignatures;
  const publicKey = bls.getPublicKey(secretKey).toBytes();
  const chain: DrandChain = { kind: "drand-dev", hash: hex(sha256(publicKey)), publicKey, genesis, period };
  return {
    chain,
    sign: (round) => {
      const signature = bls.sign(bls.hash(roundMessage(round), DST), secretKey).toBytes();
      return { round, signature, randomness: randomnessOf(signature) };
    },
  };
}

export const chainJson = (c: DrandChain) => ({ kind: c.kind, hash: c.hash, publicKey: hex(c.publicKey), genesis: c.genesis, period: c.period });
export const chainFromJson = (j: { kind: DrandChain["kind"]; hash: string; publicKey: string; genesis: number; period: number }): DrandChain => ({ ...j, publicKey: fromHex(j.publicKey) });
