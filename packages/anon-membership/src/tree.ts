import { fieldFromBytes32, fieldToBytes, type Field } from "./field";
import { nodeHash } from "./hash";

/** The compiled circuit's depth. GroupTree takes others for tests and future circuits. */
export const DEPTH = 20;
export type Depth = number;

/** A leaf's index and its siblings, leaf level first. */
export interface MerklePath {
  index: number;
  siblings: Field[];
}

const zeroCache: Field[] = [0n];

/** Z[0] = 0, Z[i+1] = H(3, Z[i], Z[i]), for i up to `depth`. */
export function zeroHashes(depth: number): Field[] {
  while (zeroCache.length <= depth) {
    const z = zeroCache[zeroCache.length - 1];
    zeroCache.push(nodeHash(z, z));
  }
  return zeroCache.slice(0, depth + 1);
}

function checkDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 1 || depth > 32) throw new Error("depth must be 1..32");
}

/**
 * A fixed-depth, sparse Poseidon2 Merkle tree of leaves. An empty leaf is 0.
 * Leaves are appended in order; removing a leaf sets it to 0 and its index is not reused.
 */
export class GroupTree {
  readonly depth: number;
  private readonly z: Field[];
  /** levels[0] holds the leaves; levels[depth][0] is the root. Missing entries are zero subtrees. */
  private readonly levels: Field[][];
  private readonly index = new Map<Field, number>();
  private count = 0;
  private len = 0;

  constructor(depth: Depth = DEPTH) {
    checkDepth(depth);
    this.depth = depth;
    this.z = zeroHashes(depth);
    this.levels = Array.from({ length: depth + 1 }, () => []);
  }

  /** Builds bottom-up, about 2n hashes for n leaves. */
  static fromLeaves(leaves: Field[], depth: Depth = DEPTH): GroupTree {
    const t = new GroupTree(depth);
    if (leaves.length > 2 ** depth) throw new Error("too many leaves for the depth");
    t.levels[0] = [...leaves];
    t.len = leaves.length;
    leaves.forEach((l, i) => {
      if (l !== 0n) {
        t.count++;
        t.index.set(l, i);
      }
    });
    for (let l = 1; l <= depth; l++) {
      const below = t.levels[l - 1];
      const row: Field[] = [];
      for (let i = 0; i < below.length; i += 2) row.push(nodeHash(below[i] ?? t.z[l - 1], below[i + 1] ?? t.z[l - 1]));
      t.levels[l] = row;
    }
    return t;
  }

  /** The snapshot is the leaf list, indices 0 to length - 1, as 32-byte big-endian values. */
  static fromSnapshot(snapshot: Uint8Array, depth: Depth = DEPTH): GroupTree {
    if (snapshot.length % 32 !== 0) throw new Error("a snapshot is a whole number of 32-byte leaves");
    const leaves: Field[] = [];
    for (let i = 0; i < snapshot.length; i += 32) leaves.push(fieldFromBytes32(snapshot.subarray(i, i + 32)));
    return GroupTree.fromLeaves(leaves, depth);
  }

  capacity(): number {
    return 2 ** this.depth;
  }

  private node(level: number, i: number): Field {
    return this.levels[level][i] ?? this.z[level];
  }

  /** Appends at the next index and returns it. */
  append(leaf: Field): number {
    if (this.len >= this.capacity()) throw new Error("the tree is full");
    const i = this.len;
    this.set(i, leaf);
    return i;
  }

  /** Writes a leaf at any index below the capacity. 0 removes. */
  set(index: number, leaf: Field): void {
    this.checkIndex(index);
    const old = this.node(0, index);
    if (old !== 0n) {
      this.count--;
      if (this.index.get(old) === index) this.index.delete(old);
    }
    if (leaf !== 0n) {
      this.count++;
      this.index.set(leaf, index);
    }
    this.levels[0][index] = leaf;
    if (index >= this.len) this.len = index + 1;
    let i = index;
    for (let l = 1; l <= this.depth; l++) {
      i >>= 1;
      this.levels[l][i] = nodeHash(this.node(l - 1, 2 * i), this.node(l - 1, 2 * i + 1));
    }
  }

  remove(index: number): void {
    if (index >= this.len) throw new Error("no leaf at that index");
    this.set(index, 0n);
  }

  leaf(index: number): Field {
    this.checkIndex(index);
    return this.node(0, index);
  }

  /** The index of a non-zero leaf, or -1. */
  indexOf(leaf: Field): number {
    if (leaf === 0n) return -1;
    return this.index.get(leaf) ?? -1;
  }

  root(): Field {
    return this.node(this.depth, 0);
  }

  /** Non-zero leaves. */
  size(): number {
    return this.count;
  }

  /** The next index. */
  length(): number {
    return this.len;
  }

  leaves(): Field[] {
    return Array.from({ length: this.len }, (_, i) => this.node(0, i));
  }

  path(index: number): MerklePath {
    this.checkIndex(index);
    const siblings: Field[] = [];
    let i = index;
    for (let l = 0; l < this.depth; l++) {
      siblings.push(this.node(l, i ^ 1));
      i >>= 1;
    }
    return { index, siblings };
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.len * 32);
    for (let i = 0; i < this.len; i++) out.set(fieldToBytes(this.node(0, i)), i * 32);
    return out;
  }

  private checkIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.capacity()) throw new Error(`index ${index} is outside the tree`);
  }
}

/** True if `leaf` at `path.index` with `path.siblings` gives `root`. */
export function verifyPath(leaf: Field, path: MerklePath, root: Field): boolean {
  let node = leaf;
  let i = path.index;
  if (!Number.isInteger(i) || i < 0 || i >= 2 ** path.siblings.length) return false;
  for (const s of path.siblings) {
    node = i & 1 ? nodeHash(s, node) : nodeHash(node, s);
    i >>= 1;
  }
  return node === root;
}
