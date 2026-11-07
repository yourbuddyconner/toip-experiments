import { BackendType, BarretenbergSync } from "@aztec/bb.js";
import { assertField, fieldFromBytes32, fieldToBytes, type Field } from "./field.js";

/** Domain tags, the first input of each hash. The circuit uses the same values. */
export const TAG = { COMMIT: 1n, NULLIFIER: 2n, NODE: 3n, LEAF: 4n } as const;

/** The largest day number, for leaves that never expire. Day numbers fit in 32 bits. */
export const NEVER_EXPIRES = 2 ** 32 - 1;
/** Rate-limit indexes are below this. */
export const MAX_LIMIT = 65536;

let bb: BarretenbergSync | undefined;
let loading: Promise<void> | undefined;

/**
 * Loads Barretenberg's WebAssembly once, for hashing. Call before any hash function.
 * It needs no setup data and fetches nothing beyond bb.js's own bundled module.
 */
export function initHashing(): Promise<void> {
  if (bb) return Promise.resolve();
  loading ??= BarretenbergSync.new({ backend: BackendType.Wasm }).then(
    (api) => {
      bb = api;
    },
    (e) => {
      loading = undefined;
      throw e;
    },
  );
  return loading;
}

/** Poseidon2 over BN254 as Noir's `Poseidon2::hash(inputs, inputs.length)` (noir-lang/poseidon v0.4.0). */
export function poseidon2(inputs: Field[]): Field {
  if (!bb) throw new Error("call initHashing() first");
  const { hash } = bb.poseidon2Hash({ inputs: inputs.map((f) => fieldToBytes(assertField(f))) });
  return fieldFromBytes32(hash);
}

/** Agora's name for the same hash. */
export function hash(...inputs: Field[]): Field {
  return poseidon2(inputs);
}

export function nodeHash(left: Field, right: Field): Field {
  return poseidon2([TAG.NODE, left, right]);
}

/** H(1, secret, groupId). The member sends only this to the issuer. Per group, so issuers can't match members. */
export function commitmentOf(secret: Field, groupId: Field): Field {
  return poseidon2([TAG.COMMIT, secret, groupId]);
}

/** What the issuer puts in the tree for one member. */
export interface Leaf {
  commitment: Field;
  /** The attribute layout. 0 when the group has no attributes. */
  schemaId: Field;
  /** Last day (days since 1970-01-01 UTC) the membership is valid. */
  validUntilDay: number;
  /** Day the member was registered. */
  registeredDay: number;
  attrs: [Field, Field, Field, Field];
}

/** A leaf with no attributes that never expires: tipline's case, where the root itself is the revocation. */
export function plainLeaf(commitment: Field): Leaf {
  return { commitment, schemaId: 0n, validUntilDay: NEVER_EXPIRES, registeredDay: 0, attrs: [0n, 0n, 0n, 0n] };
}

export function assertDay(d: number, what = "day"): number {
  if (!Number.isInteger(d) || d < 0 || d > NEVER_EXPIRES) throw new Error(`${what} must be an integer in 0..2^32-1`);
  return d;
}

/** H(4, commitment, schemaId, validUntilDay, registeredDay, attrs[0], attrs[1], attrs[2], attrs[3]). */
export function leafHash(leaf: Leaf): Field {
  if (leaf.attrs.length !== 4) throw new Error("a leaf has 4 attribute slots");
  return poseidon2([
    TAG.LEAF,
    leaf.commitment,
    leaf.schemaId,
    BigInt(assertDay(leaf.validUntilDay, "validUntilDay")),
    BigInt(assertDay(leaf.registeredDay, "registeredDay")),
    ...leaf.attrs,
  ]);
}

/** H(2, secret, scope, k). `k` is the rate-limit index, below the statement's limit; 0 for one per scope. */
export function nullifierOf(secret: Field, scope: Field, k = 0): Field {
  if (!Number.isInteger(k) || k < 0 || k >= MAX_LIMIT) throw new Error("k must be an integer in 0..65535");
  return poseidon2([TAG.NULLIFIER, secret, scope, BigInt(k)]);
}
