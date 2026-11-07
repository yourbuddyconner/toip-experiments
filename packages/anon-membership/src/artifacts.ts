import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CompiledCircuit } from "@noir-lang/noir_js";
import { fromB64u } from "@toip-tools/trust-core";
import circuit from "../artifacts/gate_d20.json" with { type: "json" };
import meta from "../artifacts/gate_d20.meta.json" with { type: "json" };

/** The circuit the library proves with. Documents name it, and verifiers pin its vkHash. */
export const CIRCUIT_ID = "anon-membership/v1/gate-d20";

export interface CircuitArtifacts {
  id: string;
  depth: number;
  /** nargo's compiled program: bytecode and ABI. */
  circuit: CompiledCircuit;
  /** The UltraHonk verification key, for the zero-knowledge noir-recursive target. */
  vk: Uint8Array;
  /** Hex SHA-256 of `vk`. */
  vkHash: string;
  gates: number;
  /** CRS points the prover needs. */
  crsPoints: number;
}

export function vkHashOf(vk: Uint8Array): string {
  return bytesToHex(sha256(vk));
}

let cached: CircuitArtifacts | undefined;

/** The committed artifacts for a depth. Only depth 20 is built. Nothing is fetched. */
export async function loadArtifacts(depth = 20): Promise<CircuitArtifacts> {
  if (depth !== 20) throw new Error(`no circuit is built for depth ${depth}`);
  if (!cached) {
    const vk = fromB64u(meta.vk);
    if (vkHashOf(vk) !== meta.vkHash) throw new Error("the bundled verification key does not match its hash");
    cached = { id: meta.id, depth: meta.depth, circuit: circuit as unknown as CompiledCircuit, vk, vkHash: meta.vkHash, gates: meta.gates, crsPoints: meta.crsPoints };
  }
  return cached;
}
