import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJson, verifyDocument, type Clock } from "@toip-tools/trust-core";
import { groupFieldOf } from "./encode.js";
import { fieldFromHex, fieldToHex } from "./field.js";
import { GroupTree } from "./tree.js";

export const ROOT_TYPE = "anon-membership/root";
export const DAY_SECONDS = 86_400;

/** A signed group root. One per epoch, hash-chained. */
export interface GroupRoot {
  id: string;
  type: typeof ROOT_TYPE;
  v: 1;
  issuer: string;
  /** "<issuer DID>#<name>". */
  group: string;
  /** The group as the circuit sees it: groupFieldOf(group), hex. */
  groupId: string;
  circuit: string;
  /** Seconds per epoch: 86400 for daily roots. */
  period: number;
  /** The epoch: a UTC day ("2026-11-06") for daily roots, else the period's start time. */
  epoch: string;
  /** 0 for the group's first root. */
  seq: number;
  /** rootDocHash of the previous root, or null. */
  prev: string | null;
  root: string;
  /** The next leaf index. */
  length: number;
  /** Non-zero leaves. */
  size: number;
  /** Hex SHA-256 of the snapshot bytes. */
  snapshotHash: string;
  issuedAt: string;
  /** Application fields the issuer signs with the root, such as attribute counts. */
  ext?: Record<string, unknown>;
  /** The eddsa-jcs-2022 Data Integrity proof from trust-core's signDocument. */
  proof?: Record<string, unknown>;
}

export function epochOf(ms: number, period = DAY_SECONDS): string {
  if (!Number.isInteger(period) || period < 1) throw new Error("period must be a positive number of seconds");
  const start = Math.floor(ms / 1000 / period) * period * 1000;
  const iso = new Date(start).toISOString();
  return period === DAY_SECONDS ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, "Z");
}

/** The epoch's index: periods since 1970. */
export function epochIndex(epoch: string, period = DAY_SECONDS): number {
  const ms = Date.parse(period === DAY_SECONDS ? epoch + "T00:00:00Z" : epoch);
  if (Number.isNaN(ms) || epochOf(ms, period) !== epoch) throw new Error(`not an epoch: ${epoch}`);
  return Math.floor(ms / 1000 / period);
}

/** Hex SHA-256 of the JCS of the signed root document. */
export function rootDocHash(doc: GroupRoot): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));
}

export function snapshotMatches(doc: GroupRoot, snapshot: Uint8Array): boolean {
  return snapshot.length === doc.length * 32 && bytesToHex(sha256(snapshot)) === doc.snapshotHash;
}

/** Rebuilds the tree from a snapshot and checks it against the signed root: hash, root, length and size. */
export function treeFromRoot(doc: GroupRoot, snapshot: Uint8Array, depth = 20): GroupTree {
  if (!snapshotMatches(doc, snapshot)) throw new Error("the snapshot does not match the root document's snapshotHash");
  const tree = GroupTree.fromSnapshot(snapshot, depth);
  if (tree.root() !== fieldFromHex(doc.root) || tree.size() !== doc.size) throw new Error("the snapshot's tree does not match the signed root");
  return tree;
}

export type RootLogCheck =
  | { ok: true; head: GroupRoot }
  | { ok: false; reason: "signature" | "issuer" | "chain" | "equivocation"; evidence?: [GroupRoot, GroupRoot]; detail?: string };

/** Two validly signed, different roots of one group with the same seq or epoch, if `docs` holds any. Checks no signatures. */
export function findEquivocation(docs: GroupRoot[]): [GroupRoot, GroupRoot] | null {
  const seen = new Map<string, { doc: GroupRoot; hash: string }>();
  for (const doc of docs) {
    const hash = rootDocHash(doc);
    for (const key of [`${doc.group} seq ${doc.seq}`, `${doc.group} epoch ${doc.epoch}`]) {
      const other = seen.get(key);
      if (other && other.hash !== hash) return [other.doc, doc];
      if (!other) seen.set(key, { doc, hash });
    }
  }
  return null;
}

/**
 * Checks a group's root log, oldest first: each document signed by `expectedIssuer`, one group,
 * seq 0, 1, 2, …, each `prev` the hash of the one before, and epochs strictly rising.
 * Two signed roots for one seq or one epoch are returned as evidence of equivocation.
 */
export async function checkRootLog(log: GroupRoot[], expectedIssuer: string, clock: Clock): Promise<RootLogCheck> {
  if (!Array.isArray(log) || log.length === 0) return { ok: false, reason: "chain", detail: "empty log" };
  for (const doc of log) {
    if (!doc || doc.type !== ROOT_TYPE || doc.v !== 1) return { ok: false, reason: "chain", detail: "not a root document" };
    if (doc.issuer !== expectedIssuer) return { ok: false, reason: "issuer" };
    const sig = await verifyDocument(doc, clock);
    if (!sig.valid) return { ok: false, reason: "signature" };
  }
  const evidence = findEquivocation(log);
  if (evidence) return { ok: false, reason: "equivocation", evidence };
  const first = log[0];
  for (let i = 0; i < log.length; i++) {
    const d = log[i];
    if (d.group !== first.group || d.period !== first.period || d.circuit !== first.circuit) return { ok: false, reason: "chain", detail: "mixed groups" };
    if (d.groupId !== fieldToHex(groupFieldOf(d.group))) return { ok: false, reason: "chain", detail: "groupId does not match group" };
    if (d.seq !== i) return { ok: false, reason: "chain", detail: `seq ${d.seq} at position ${i}` };
    if (d.prev !== (i === 0 ? null : rootDocHash(log[i - 1]))) return { ok: false, reason: "chain", detail: `broken prev at seq ${i}` };
    try {
      fieldFromHex(d.root);
      if (i > 0 && epochIndex(d.epoch, d.period) <= epochIndex(log[i - 1].epoch, d.period)) return { ok: false, reason: "chain", detail: "epochs out of order" };
    } catch {
      return { ok: false, reason: "chain", detail: "bad root or epoch" };
    }
  }
  return { ok: true, head: log[log.length - 1] };
}
