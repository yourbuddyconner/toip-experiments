import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fieldFromHex as F, FIELD_MODULUS } from "../src/field";
import {
  NEVER_EXPIRES,
  TAG,
  commitmentOf,
  hash,
  initHashing,
  leafHash,
  nodeHash,
  nullifierOf,
  plainLeaf,
  poseidon2,
  type Leaf,
} from "../src/hash";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

beforeAll(initHashing);

describe("Poseidon2", () => {
  it("matches the committed vectors, which nargo test also checks in Noir", () => {
    expect(vectors.poseidon2.map((v: { inputs: string[] }) => v.inputs.length)).toEqual([1, 2, 3, 4, 9]);
    for (const v of vectors.poseidon2) expect(poseidon2(v.inputs.map(F))).toBe(F(v.output));
  });

  it("is Barretenberg's sponge: a known value for [1, 2]", () => {
    // From bb.js 6.0.0's poseidon2Hash, recorded by hand on 2026-11-06.
    expect(poseidon2([1n, 2n])).toBe(F("0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383"));
  });

  it("hash(...xs) is poseidon2(xs)", () => {
    expect(hash(1n, 2n, 3n)).toBe(poseidon2([1n, 2n, 3n]));
  });

  it("refuses non-field inputs", () => {
    expect(() => poseidon2([FIELD_MODULUS])).toThrow();
    expect(() => poseidon2([-1n])).toThrow();
  });

  it("depends on the input length (no padding collisions)", () => {
    expect(poseidon2([1n, 0n])).not.toBe(poseidon2([1n]));
  });
});

describe("tagged hashes", () => {
  it("uses the documented tags", () => {
    expect(TAG).toEqual({ COMMIT: 1n, NULLIFIER: 2n, NODE: 3n, LEAF: 4n });
  });

  it("commitment = H(1, secret, groupId)", () => {
    const v = vectors.commitment;
    expect(commitmentOf(F(v.secret), F(v.groupId))).toBe(F(v.output));
    expect(commitmentOf(5n, 6n)).toBe(poseidon2([1n, 5n, 6n]));
  });

  it("node = H(3, left, right)", () => {
    const v = vectors.node;
    expect(nodeHash(F(v.left), F(v.right))).toBe(F(v.output));
  });

  it("leaf = H(4, commitment, schemaId, validUntilDay, registeredDay, attrs[0..3])", () => {
    const v = vectors.leaf;
    const leaf: Leaf = {
      commitment: F(v.commitment),
      schemaId: F(v.schemaId),
      validUntilDay: v.validUntilDay,
      registeredDay: v.registeredDay,
      attrs: v.attrs.map(F),
    };
    expect(leafHash(leaf)).toBe(F(v.output));
    expect(leafHash(leaf)).toBe(poseidon2([4n, leaf.commitment, leaf.schemaId, BigInt(v.validUntilDay), BigInt(v.registeredDay), ...leaf.attrs]));
  });

  it("nullifier = H(2, secret, scope, k)", () => {
    for (const v of vectors.nullifier) expect(nullifierOf(F(v.secret), F(v.scope), v.k)).toBe(F(v.output));
    expect(nullifierOf(7n, 8n)).toBe(nullifierOf(7n, 8n, 0));
  });

  it("nullifiers are deterministic per (secret, scope, k) and differ otherwise", () => {
    const a = nullifierOf(11n, 100n, 0);
    expect(nullifierOf(11n, 100n, 0)).toBe(a);
    expect(nullifierOf(11n, 101n, 0)).not.toBe(a);
    expect(nullifierOf(12n, 100n, 0)).not.toBe(a);
    expect(nullifierOf(11n, 100n, 1)).not.toBe(a);
  });

  it("refuses a k outside 0..65535 and day numbers outside 32 bits", () => {
    expect(() => nullifierOf(1n, 1n, -1)).toThrow();
    expect(() => nullifierOf(1n, 1n, 65536)).toThrow();
    expect(() => nullifierOf(1n, 1n, 1.5)).toThrow();
    const leaf = plainLeaf(9n);
    expect(() => leafHash({ ...leaf, validUntilDay: 2 ** 32 })).toThrow();
    expect(() => leafHash({ ...leaf, registeredDay: -1 })).toThrow();
  });

  it("a plain leaf has no schema, no attributes, registration day 0, and never expires", () => {
    expect(plainLeaf(9n)).toEqual({ commitment: 9n, schemaId: 0n, validUntilDay: NEVER_EXPIRES, registeredDay: 0, attrs: [0n, 0n, 0n, 0n] });
    expect(NEVER_EXPIRES).toBe(2 ** 32 - 1);
  });

  it("matches the zero hashes and the tree root in the vectors", () => {
    let z = 0n;
    for (const [i, hex] of vectors.zeros.entries()) {
      expect(z).toBe(F(hex));
      if (i < vectors.zeros.length - 1) z = nodeHash(z, z);
    }
    const p = vectors.path;
    let node = F(p.leaf);
    for (let i = 0; i < p.siblings.length; i++) {
      const s = F(p.siblings[i]);
      node = (p.index >> i) & 1 ? nodeHash(s, node) : nodeHash(node, s);
    }
    expect(node).toBe(F(p.root));
  });
});
