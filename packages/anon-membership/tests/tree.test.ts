import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fieldFromHex as F } from "../src/field";
import { initHashing, nodeHash } from "../src/hash";
import { GroupTree, verifyPath, zeroHashes } from "../src/tree";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

beforeAll(initHashing);

/** The root of a full tree of 2^depth leaves, computed level by level with no shortcuts. */
function naiveRoot(leaves: bigint[], depth: number): bigint {
  let level = Array.from({ length: 2 ** depth }, (_, i) => leaves[i] ?? 0n);
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed);

describe("GroupTree", () => {
  it("has the zero values Z[0] = 0, Z[i+1] = H(3, Z[i], Z[i])", () => {
    const z = zeroHashes(20);
    expect(z.length).toBe(21);
    expect(z.slice(0, 4)).toEqual(vectors.zeros.map(F));
    expect(new GroupTree(20).root()).toBe(z[20]);
  });

  it("matches a naive full-tree computation for random sets", () => {
    for (const depth of [1, 3, 5]) {
      for (let trial = 0; trial < 4; trial++) {
        const n = 1 + (rand() % 2 ** depth);
        const leaves = Array.from({ length: n }, () => BigInt(rand()) + 1n);
        const t = new GroupTree(depth);
        for (const l of leaves) t.append(l);
        expect(t.root()).toBe(naiveRoot(leaves, depth));
        expect(GroupTree.fromLeaves(leaves, depth).root()).toBe(t.root());
        // Remove a random leaf.
        const r = rand() % n;
        t.remove(r);
        leaves[r] = 0n;
        expect(t.root()).toBe(naiveRoot(leaves, depth));
        for (let i = 0; i < n; i++) expect(verifyPath(leaves[i], t.path(i), t.root())).toBe(true);
      }
    }
  });

  it("gives paths that verify, and refuses a wrong leaf, sibling or index", () => {
    const t = GroupTree.fromLeaves([11n, 22n, 33n, 44n, 55n], 20);
    const p = t.path(2);
    expect(p.siblings.length).toBe(20);
    expect(verifyPath(33n, p, t.root())).toBe(true);
    expect(verifyPath(34n, p, t.root())).toBe(false);
    expect(verifyPath(33n, { ...p, index: 3 }, t.root())).toBe(false);
    const s = [...p.siblings];
    s[4] = 1n;
    expect(verifyPath(33n, { index: 2, siblings: s }, t.root())).toBe(false);
  });

  it("matches the depth-20 path vector that nargo test checks", () => {
    const v = vectors.path;
    const t = GroupTree.fromLeaves([11n, 22n, F(v.leaf)], 20);
    expect(t.root()).toBe(F(v.root));
    expect(t.path(2).siblings).toEqual(v.siblings.map(F));
  });

  it("appends in order, never reuses an index, and counts non-zero leaves", () => {
    const t = new GroupTree(20);
    expect(t.append(5n)).toBe(0);
    expect(t.append(6n)).toBe(1);
    t.remove(0);
    expect(t.append(7n)).toBe(2);
    expect(t.length()).toBe(3);
    expect(t.size()).toBe(2);
    expect(t.leaf(0)).toBe(0n);
    expect(t.indexOf(5n)).toBe(-1);
    expect(t.indexOf(7n)).toBe(2);
    expect(t.indexOf(0n)).toBe(-1);
  });

  it("set() writes any index below the capacity, and 0 removes", () => {
    const t = new GroupTree(4);
    t.set(9, 3n);
    expect(t.length()).toBe(10);
    expect(t.root()).toBe(naiveRoot([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 3n], 4));
    t.set(9, 0n);
    expect(t.root()).toBe(new GroupTree(4).root());
  });

  it("holds 2^20 leaves and no more", () => {
    const t = new GroupTree(20);
    t.set(2 ** 20 - 1, 8n);
    expect(verifyPath(8n, t.path(2 ** 20 - 1), t.root())).toBe(true);
    expect(() => t.append(9n)).toThrow(/full/);
    expect(() => t.set(2 ** 20, 1n)).toThrow();
    expect(() => t.path(2 ** 20)).toThrow();
    expect(() => new GroupTree(0)).toThrow();
    expect(() => new GroupTree(33)).toThrow();
  });

  it("round-trips a snapshot of 32-byte big-endian leaves", () => {
    const t = GroupTree.fromLeaves([1n, 0n, 0xabcdefn], 20);
    const snap = t.snapshot();
    expect(snap.length).toBe(96);
    expect(snap[95]).toBe(0xef);
    const u = GroupTree.fromSnapshot(snap, 20);
    expect(u.root()).toBe(t.root());
    expect(u.length()).toBe(3);
    expect(u.size()).toBe(2);
    expect(() => GroupTree.fromSnapshot(new Uint8Array(33), 20)).toThrow();
    expect(() => GroupTree.fromSnapshot(new Uint8Array(32).fill(0xff), 20)).toThrow(/modulus/);
  });

  it("builds a 5,000-leaf tree from a snapshot quickly", () => {
    const leaves = Array.from({ length: 5000 }, (_, i) => BigInt(i + 1));
    const t0 = performance.now();
    const t = GroupTree.fromLeaves(leaves, 20);
    const ms = performance.now() - t0;
    expect(t.size()).toBe(5000);
    expect(ms).toBeLessThan(3000);
  });
});
