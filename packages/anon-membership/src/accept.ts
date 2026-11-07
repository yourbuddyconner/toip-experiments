import type { Clock } from "@zk-toip/trust-core";
import { dayOf, groupFieldOf } from "./encode";
import { fieldFromHex, type Field } from "./field";
import { parseMembershipProof, type MembershipVerifier } from "./prove";
import { checkRootLog, epochIndex, type GroupRoot } from "./roots";
import { sameStatement, type Predicate, type Statement } from "./statement";

/** What a verifier accepts. Groups are in statement slot order. */
export interface AcceptPolicy {
  /** 1 to 4 groups, each with the issuer DID pinned out of band. */
  groups: { group: string; issuer: string }[];
  /** Pinned verification-key hashes. */
  vkHashes: string[];
  /** How many epochs after a root stops being the newest it is still accepted. */
  maxEpochAge: number;
  /** The smallest anonymity set: the sum of the groups' sizes at the roots used. */
  minSize: number;
  schemaId?: Field;
  predicates?: Predicate[];
  /** registeredBy must be today minus this. Default 0. */
  minRegisteredDays?: number;
  /** Nullifiers per member in the scope. Default 1. */
  limit?: number;
  /** Roots fixed in advance (a poll's), hex, per slot. If set, only these are accepted. */
  pinnedRoots?: string[];
  /** How many days `today` may lag the verifier's clock. Default 1. */
  maxDayLag?: number;
}

export type AcceptReason =
  | "malformed"
  | "circuit"
  | "group"
  | "log"
  | "equivocation"
  | "unknownRoot"
  | "stale"
  | "tooSmall"
  | "scope"
  | "signal"
  | "statement"
  | "proof";

export type Acceptance =
  | { ok: true; nullifier: Field; statement: Statement; roots: GroupRoot[]; size: number }
  | { ok: false; reason: AcceptReason; evidence?: [GroupRoot, GroupRoot] };

/** The newest document in the log carrying `root`, and how many epochs ago it stopped being current (0 if it is the head's). */
function findRoot(log: GroupRoot[], root: Field, nowIndex: number): { doc: GroupRoot; age: number } | null {
  for (let i = log.length - 1; i >= 0; i--) {
    if (fieldFromHex(log[i].root) !== root) continue;
    const age = i === log.length - 1 ? 0 : nowIndex - epochIndex(log[i].epoch, log[i].period);
    return { doc: log[i], age };
  }
  return null;
}

/**
 * Decides whether a membership proof is acceptable: the circuit is pinned, the groups are the
 * policy's, each root is in its issuer's verified log, fresh, and the set big enough, the scope and
 * signal are what the verifier computed itself, the statement matches the policy, and the proof verifies.
 */
export async function acceptMembership(
  proof: unknown,
  ctx: {
    policy: AcceptPolicy;
    /** Root logs by group, as fetched. Each is checked here. */
    logs: Record<string, GroupRoot[]>;
    verifier: MembershipVerifier;
    scope: Field;
    signal: Field;
    clock: Clock;
  },
): Promise<Acceptance> {
  const { policy, clock } = ctx;
  const parsed = parseMembershipProof(proof);
  if (!parsed) return { ok: false, reason: "malformed" };
  const { statement: s, proof: p } = parsed;

  if (!policy.vkHashes.includes(p.vkHash) || !ctx.verifier.vkHashes().includes(p.vkHash)) return { ok: false, reason: "circuit" };
  if (s.groups.length !== policy.groups.length || s.groups.some((g, i) => g.groupId !== groupFieldOf(policy.groups[i].group))) {
    return { ok: false, reason: "group" };
  }

  const roots: GroupRoot[] = [];
  let size = 0;
  for (let i = 0; i < policy.groups.length; i++) {
    const { group, issuer } = policy.groups[i];
    const log = ctx.logs[group];
    const check = log ? await checkRootLog(log, issuer, clock) : null;
    if (!check || !check.ok) {
      if (check && check.reason === "equivocation") return { ok: false, reason: "equivocation", evidence: check.evidence };
      return { ok: false, reason: "log" };
    }
    if (check.head.group !== group) return { ok: false, reason: "log" };
    const nowIndex = Math.floor(clock.now() / 1000 / check.head.period);
    const found = findRoot(log, s.groups[i].root, nowIndex);
    if (!found) return { ok: false, reason: "unknownRoot" };
    if (policy.pinnedRoots && fieldFromHex(policy.pinnedRoots[i] ?? "0x" + "0".repeat(64)) !== s.groups[i].root) return { ok: false, reason: "unknownRoot" };
    if (!policy.pinnedRoots && found.age > policy.maxEpochAge) return { ok: false, reason: "stale" };
    roots.push(found.doc);
    size += found.doc.size;
  }
  if (size < policy.minSize) return { ok: false, reason: "tooSmall" };
  if (s.scope !== ctx.scope) return { ok: false, reason: "scope" };
  if (s.signal !== ctx.signal) return { ok: false, reason: "signal" };

  const today = dayOf(clock.now());
  if (s.today > today || s.today < today - (policy.maxDayLag ?? 1)) return { ok: false, reason: "statement" };
  const expected: Statement = {
    groups: s.groups,
    schemaId: policy.schemaId ?? 0n,
    today: s.today,
    registeredBy: s.today - (policy.minRegisteredDays ?? 0),
    predicates: policy.predicates ?? [],
    scope: ctx.scope,
    limit: policy.limit ?? 1,
    signal: ctx.signal,
  };
  if (!sameStatement(s, expected)) return { ok: false, reason: "statement" };

  const v = await ctx.verifier.verify(proof, expected);
  if (!v.ok) return { ok: false, reason: v.reason === "unknownCircuit" ? "circuit" : "proof" };
  return { ok: true, nullifier: v.nullifier, statement: s, roots, size };
}
