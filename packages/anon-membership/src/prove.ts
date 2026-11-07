import { BackendType, Barretenberg, UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { fromB64u, toB64u } from "@toip-tools/trust-core";
import { loadArtifacts, type CircuitArtifacts } from "./artifacts.js";
import { resolveCrs, type CrsSource } from "./crs.js";
import { fieldFromHex, fieldToHex, type Field } from "./field.js";
import { nullifierOf } from "./hash.js";
import {
  checkStatement,
  circuitInputs,
  decodeStatement,
  encodeStatement,
  publicInputs,
  sameStatement,
  whyUnsatisfied,
  type Statement,
  type StatementJson,
  type Witness,
} from "./statement.js";

/** UltraHonk in its zero-knowledge mode, with a Poseidon2 transcript. The only mode this library uses. */
export const PROOF_SYSTEM = "ultrahonk-zk/noir-recursive";
const TARGET = { verifierTarget: "noir-recursive" } as const;

/** A proof in a JSON-safe form, as it travels. */
export interface MembershipProof {
  v: 1;
  system: typeof PROOF_SYSTEM;
  circuit: string;
  vkHash: string;
  statement: StatementJson;
  nullifier: string;
  /** base64url of the UltraHonk proof, about 14.7 KB. */
  proof: string;
}

export interface ProveProgress {
  stage: "witness" | "proving" | "done";
  fraction: number;
}

/** Thrown when the witness can't satisfy the statement: not a member, expired, an unmet predicate, and so on. */
export class MembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipError";
  }
}

export interface BackendOptions {
  /** Worker threads for bb.js. Default: all cores up to 16 where threads are possible, else 1. */
  threads?: number;
  /** Default: the CRS bundled with this package. */
  crs?: CrsSource;
}

function defaultThreads(): number {
  const g = globalThis as { crossOriginIsolated?: boolean; navigator?: { hardwareConcurrency?: number } };
  if (g.crossOriginIsolated === false) return 1; // a page without COOP/COEP has no SharedArrayBuffer
  return Math.max(1, Math.min(16, g.navigator?.hardwareConcurrency ?? 1));
}

/**
 * Starts Barretenberg's WebAssembly prover and loads the CRS ourselves, so bb.js never downloads
 * points or caches them. In a browser page it runs in bb.js's own worker; in Node or inside a Web
 * Worker it runs in place.
 */
async function openApi(opts: BackendOptions, needPoints: number): Promise<Barretenberg> {
  const crs = resolveCrs(opts.crs, needPoints);
  const browserPage = typeof (globalThis as { document?: unknown }).document !== "undefined";
  const api = await Barretenberg.new({
    backend: browserPage ? BackendType.WasmWorker : BackendType.Wasm,
    threads: opts.threads ?? defaultThreads(),
    skipSrsInit: true,
  });
  try {
    await api.srsInitSrs({ pointsBuf: crs.g1, numPoints: crs.points, g2Point: crs.g2 });
  } catch (e) {
    await api.destroy();
    throw e;
  }
  return api;
}

/** Deletes the IndexedDB store bb.js would cache CRS points in. We never fill it; this is belt and braces. */
async function dropBrowserCache(): Promise<void> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return;
  await new Promise<void>((resolve) => {
    const r = idb.deleteDatabase("keyval-store");
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

function hexInputs(fields: Field[]): string[] {
  return fields.map(fieldToHex);
}

export class MembershipProver {
  private constructor(
    private readonly artifacts: CircuitArtifacts,
    private readonly api: Barretenberg,
    private readonly backend: UltraHonkBackend,
    private readonly noir: Noir,
  ) {}

  /** Loads the prover once; later proofs reuse it. This is the warm-up. */
  static async create(opts: BackendOptions & { artifacts?: CircuitArtifacts } = {}): Promise<MembershipProver> {
    const artifacts = opts.artifacts ?? (await loadArtifacts());
    const api = await openApi(opts, artifacts.crsPoints);
    return new MembershipProver(artifacts, api, new UltraHonkBackend(artifacts.circuit.bytecode, api), new Noir(artifacts.circuit));
  }

  get circuit(): string {
    return this.artifacts.id;
  }

  /** Always the zero-knowledge target. Throws MembershipError if the witness doesn't satisfy the statement. */
  async prove(statement: Statement, witness: Witness, onProgress?: (p: ProveProgress) => void): Promise<MembershipProof> {
    checkStatement(statement);
    const why = whyUnsatisfied(statement, witness);
    if (why) throw new MembershipError(why);
    onProgress?.({ stage: "witness", fraction: 0 });
    let solved;
    try {
      solved = await this.noir.execute(circuitInputs(statement, witness) as never);
    } catch (e) {
      throw new MembershipError(`the circuit refused the witness: ${e instanceof Error ? e.message : String(e)}`);
    }
    const nullifier = nullifierOf(witness.secret, statement.scope, witness.messageIndex ?? 0);
    if (BigInt(String(solved.returnValue)) !== nullifier) throw new Error("the circuit's nullifier differs from the library's");
    onProgress?.({ stage: "proving", fraction: 0.1 });
    const out = await this.backend.generateProof(solved.witness, TARGET);
    const expected = hexInputs(publicInputs(statement, nullifier));
    if (out.publicInputs.length !== expected.length || out.publicInputs.some((p, i) => BigInt(p) !== BigInt(expected[i]))) {
      throw new Error("the proof's public inputs differ from the statement");
    }
    onProgress?.({ stage: "done", fraction: 1 });
    return {
      v: 1,
      system: PROOF_SYSTEM,
      circuit: this.artifacts.id,
      vkHash: this.artifacts.vkHash,
      statement: encodeStatement(statement),
      nullifier: fieldToHex(nullifier),
      proof: toB64u(out.proof),
    };
  }

  /** Frees the prover and deletes bb.js's browser cache, if there is one. */
  async destroy(): Promise<void> {
    await this.api.destroy();
    await dropBrowserCache();
  }
}

export type VerifyResult =
  | { ok: true; nullifier: Field; statement: Statement }
  | { ok: false; reason: "malformed" | "unknownCircuit" | "statementMismatch" | "proofInvalid" };

/** Checks the shape of a proof that arrived from elsewhere. */
export function parseMembershipProof(j: unknown): { proof: MembershipProof; statement: Statement; nullifier: Field; bytes: Uint8Array } | null {
  try {
    const p = j as MembershipProof;
    if (!p || typeof p !== "object" || p.v !== 1 || p.system !== PROOF_SYSTEM) return null;
    if (typeof p.circuit !== "string" || typeof p.vkHash !== "string" || typeof p.proof !== "string") return null;
    const statement = decodeStatement(p.statement);
    const nullifier = fieldFromHex(p.nullifier);
    const bytes = fromB64u(p.proof);
    if (bytes.length === 0 || bytes.length % 32 !== 0) return null;
    return { proof: p, statement, nullifier, bytes };
  } catch {
    return null;
  }
}

export class MembershipVerifier {
  private constructor(
    private readonly api: Barretenberg,
    private readonly circuits: Map<string, CircuitArtifacts>,
  ) {}

  /** `artifacts` are the circuits this verifier accepts, pinned by vkHash. Default: the bundled one. */
  static async create(opts: BackendOptions & { artifacts?: CircuitArtifacts[] } = {}): Promise<MembershipVerifier> {
    const list = opts.artifacts ?? [await loadArtifacts()];
    const api = await openApi(opts, 0);
    return new MembershipVerifier(api, new Map(list.map((a) => [`${a.id} ${a.vkHash}`, a])));
  }

  vkHashes(): string[] {
    return [...this.circuits.values()].map((a) => a.vkHash);
  }

  /** Verifies in the zero-knowledge mode. With `expected`, also requires the statement to equal it exactly. */
  async verify(proof: unknown, expected?: Statement): Promise<VerifyResult> {
    const parsed = parseMembershipProof(proof);
    if (!parsed) return { ok: false, reason: "malformed" };
    const a = this.circuits.get(`${parsed.proof.circuit} ${parsed.proof.vkHash}`);
    if (!a) return { ok: false, reason: "unknownCircuit" };
    if (expected && !sameStatement(parsed.statement, expected)) return { ok: false, reason: "statementMismatch" };
    const ok = await this.verifyRaw(a.vk, parsed.bytes, publicInputs(parsed.statement, parsed.nullifier));
    return ok ? { ok: true, nullifier: parsed.nullifier, statement: parsed.statement } : { ok: false, reason: "proofInvalid" };
  }

  private async verifyRaw(vk: Uint8Array, proof: Uint8Array, inputs: Field[]): Promise<boolean> {
    try {
      return await new UltraHonkVerifierBackend(this.api).verifyProof({ proof, publicInputs: hexInputs(inputs), verificationKey: vk }, TARGET);
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    await this.api.destroy();
  }
}
