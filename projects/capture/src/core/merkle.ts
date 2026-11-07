/** RFC 6962 Merkle trees (SHA-256, 0x00 leaf and 0x01 node prefixes): a camera anchors a batch of manifest ids under one root. */
import { concat, equal, sha } from "./bytes";

const leafHash = (x: Uint8Array) => sha(concat(Uint8Array.of(0), x));
const nodeHash = (l: Uint8Array, r: Uint8Array) => sha(concat(Uint8Array.of(1), l, r));

/** Largest power of two smaller than n. */
const split = (n: number) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

function root(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 1) return leafHash(leaves[0]);
  const k = split(leaves.length);
  return nodeHash(root(leaves.slice(0, k)), root(leaves.slice(k)));
}

export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (!leaves.length) throw new Error("empty batch");
  return root(leaves);
}

export function merklePath(leaves: Uint8Array[], index: number): Uint8Array[] {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  return index < k ? [...merklePath(leaves.slice(0, k), index), root(leaves.slice(k))] : [...merklePath(leaves.slice(k), index - k), root(leaves.slice(0, k))];
}

/** The root the path leads to from `leaf`, or null when the path is the wrong length. RFC 9162 §2.1.3.2. */
export function rootFromPath(leaf: Uint8Array, index: number, size: number, path: Uint8Array[]): Uint8Array | null {
  if (index < 0 || index >= size) return null;
  let fn = index;
  let sn = size - 1;
  let r = leafHash(leaf);
  for (const p of path) {
    if (sn === 0) return null;
    if (fn & 1 || fn === sn) {
      r = nodeHash(p, r);
      if (!(fn & 1)) {
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else r = nodeHash(r, p);
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 ? r : null;
}

export const verifyPath = (leaf: Uint8Array, index: number, size: number, path: Uint8Array[], expected: Uint8Array) => equal(rootFromPath(leaf, index, size, path) ?? undefined, expected);
