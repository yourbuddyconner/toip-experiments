import { assertField, fieldFromHex, fieldToHex, type Field } from "./field";
import { MAX_LIMIT, assertDay, commitmentOf, leafHash, type Leaf } from "./hash";
import { verifyPath, type MerklePath } from "./tree";

export const GROUP_SLOTS = 4;
export const ATTR_SLOTS = 4;
const U64 = 1n << 64n;

export type Predicate =
  | { op: "any" }
  | { op: "eq"; value: Field }
  | { op: "gte"; value: bigint } // below 2^64
  | { op: "lte"; value: bigint };

const OPS = { any: 0, eq: 1, gte: 2, lte: 3 } as const;

/** The public half of a proof. The verifier rebuilds it from its own data and requires an exact match. */
export interface Statement {
  /** 1 to 4 groups. The proof says the member is in one of them, not which. */
  groups: { groupId: Field; root: Field }[];
  schemaId: Field;
  /** Days since 1970-01-01 UTC. The leaf's validUntilDay must be at least this. */
  today: number;
  /** The leaf's registeredDay must be at most this. */
  registeredBy: number;
  /** Up to 4, one per attribute slot. Missing slots are "any". */
  predicates: Predicate[];
  scope: Field;
  /** How many nullifiers one member may make in this scope: 1 to 65536. */
  limit: number;
  /** What the proof is bound to (tipline's "message"). */
  signal: Field;
}

/** The private half. */
export interface Witness {
  secret: Field;
  /** Which of the statement's groups holds the leaf. */
  groupIndex: number;
  leaf: Leaf;
  path: MerklePath;
  /** The rate-limit index k, below the statement's limit. Default 0. */
  messageIndex?: number;
}

/** Defaults that make a statement mean "a current member of this group": tipline's case. */
export function simpleStatement(s: { groups: { groupId: Field; root: Field }[]; scope: Field; signal: Field; today: number }): Statement {
  return { ...s, schemaId: 0n, registeredBy: s.today, predicates: [], limit: 1 };
}

function predicateOk(p: Predicate): boolean {
  if (p.op === "any") return true;
  if (p.op === "eq") return typeof p.value === "bigint" && p.value >= 0n;
  if (p.op === "gte" || p.op === "lte") return typeof p.value === "bigint" && p.value >= 0n && p.value < U64;
  return false;
}

/** Throws if the statement can't be a public input of the circuit. */
export function checkStatement(s: Statement): void {
  if (!Array.isArray(s.groups) || s.groups.length < 1 || s.groups.length > GROUP_SLOTS) throw new Error("a statement has 1 to 4 groups");
  for (const g of s.groups) {
    assertField(g.groupId);
    assertField(g.root);
    if (g.root === 0n) throw new Error("a group root is never 0");
  }
  assertField(s.schemaId);
  assertDay(s.today, "today");
  assertDay(s.registeredBy, "registeredBy");
  if (!Array.isArray(s.predicates) || s.predicates.length > ATTR_SLOTS) throw new Error("at most 4 predicates");
  for (const p of s.predicates) if (!p || !predicateOk(p)) throw new Error(`bad predicate ${JSON.stringify(p, (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
  for (const p of s.predicates) if (p.op !== "any") assertField(p.value);
  assertField(s.scope);
  if (s.scope === 0n) throw new Error("the scope is never 0");
  if (!Number.isInteger(s.limit) || s.limit < 1 || s.limit > MAX_LIMIT) throw new Error("limit must be 1..65536");
  assertField(s.signal);
}

function padded<T>(xs: T[], n: number, fill: T): T[] {
  return [...xs, ...Array.from({ length: n - xs.length }, () => fill)];
}

function predicateHolds(p: Predicate, attr: Field): boolean {
  switch (p.op) {
    case "any":
      return true;
    case "eq":
      return attr === p.value;
    case "gte":
      return attr < U64 && attr >= p.value;
    case "lte":
      return attr < U64 && attr <= p.value;
  }
}

/** Why a witness can't satisfy a statement, or null. The circuit enforces the same rules. */
export function whyUnsatisfied(s: Statement, w: Witness): string | null {
  const g = s.groups[w.groupIndex];
  if (!Number.isInteger(w.groupIndex) || !g) return "group index out of range";
  if (w.leaf.commitment !== commitmentOf(w.secret, g.groupId)) return "the leaf's commitment is not this secret's for this group";
  if (w.path.siblings.length !== 20) return "the path is not depth 20";
  if (!verifyPath(leafHash(w.leaf), w.path, g.root)) return "not a member: the leaf is not under the group's root";
  if (w.leaf.schemaId !== s.schemaId) return "the leaf has another schema";
  if (w.leaf.validUntilDay < s.today) return "membership expired";
  if (w.leaf.registeredDay > s.registeredBy) return "registered too recently";
  const preds = padded(s.predicates, ATTR_SLOTS, { op: "any" } as Predicate);
  for (let j = 0; j < ATTR_SLOTS; j++) if (!predicateHolds(preds[j], w.leaf.attrs[j])) return `attribute ${j} does not meet its predicate`;
  const k = w.messageIndex ?? 0;
  if (!Number.isInteger(k) || k < 0 || k >= s.limit) return "message index not below the limit";
  return null;
}

const H = fieldToHex;

/** The circuit's inputs, by name, as noir_js takes them. */
export function circuitInputs(s: Statement, w: Witness): Record<string, unknown> {
  const groups = padded(s.groups, GROUP_SLOTS, { groupId: 0n, root: 0n });
  const preds = padded(s.predicates, ATTR_SLOTS, { op: "any" } as Predicate);
  return {
    secret: H(w.secret),
    group_index: w.groupIndex,
    valid_until_day: w.leaf.validUntilDay,
    registered_day: w.leaf.registeredDay,
    attrs: w.leaf.attrs.map(H),
    index: w.path.index,
    siblings: w.path.siblings.map(H),
    k: w.messageIndex ?? 0,
    group_ids: groups.map((g) => H(g.groupId)),
    roots: groups.map((g) => H(g.root)),
    schema_id: H(s.schemaId),
    today: s.today,
    registered_by: s.registeredBy,
    ops: preds.map((p) => OPS[p.op]),
    operands: preds.map((p) => H(p.op === "any" ? 0n : p.value)),
    scope: H(s.scope),
    limit: s.limit,
    signal: H(s.signal),
  };
}

/** The 23 public inputs in circuit order, as fields: the statement, then the nullifier. */
export function publicInputs(s: Statement, nullifier: Field): Field[] {
  const groups = padded(s.groups, GROUP_SLOTS, { groupId: 0n, root: 0n });
  const preds = padded(s.predicates, ATTR_SLOTS, { op: "any" } as Predicate);
  return [
    ...groups.map((g) => g.groupId),
    ...groups.map((g) => g.root),
    s.schemaId,
    BigInt(s.today),
    BigInt(s.registeredBy),
    ...preds.map((p) => BigInt(OPS[p.op])),
    ...preds.map((p) => (p.op === "any" ? 0n : p.value)),
    s.scope,
    BigInt(s.limit),
    s.signal,
    nullifier,
  ];
}

// ── JSON form ───────────────────────────────────────────────────────

export interface StatementJson {
  groups: { groupId: string; root: string }[];
  schemaId: string;
  today: number;
  registeredBy: number;
  predicates: ({ op: "any" } | { op: "eq" | "gte" | "lte"; value: string })[];
  scope: string;
  limit: number;
  signal: string;
}

export function encodeStatement(s: Statement): StatementJson {
  checkStatement(s);
  return {
    groups: s.groups.map((g) => ({ groupId: H(g.groupId), root: H(g.root) })),
    schemaId: H(s.schemaId),
    today: s.today,
    registeredBy: s.registeredBy,
    predicates: s.predicates.map((p) => (p.op === "any" ? { op: "any" } : { op: p.op, value: H(p.value) })),
    scope: H(s.scope),
    limit: s.limit,
    signal: H(s.signal),
  };
}

export function decodeStatement(j: unknown): Statement {
  const o = j as StatementJson;
  if (!o || typeof o !== "object" || !Array.isArray(o.groups) || !Array.isArray(o.predicates)) throw new Error("malformed statement");
  const s: Statement = {
    groups: o.groups.map((g) => ({ groupId: fieldFromHex(g.groupId), root: fieldFromHex(g.root) })),
    schemaId: fieldFromHex(o.schemaId),
    today: o.today,
    registeredBy: o.registeredBy,
    predicates: o.predicates.map((p) => {
      if (p.op === "any") return { op: "any" };
      if (p.op === "eq" || p.op === "gte" || p.op === "lte") return { op: p.op, value: fieldFromHex(p.value) };
      throw new Error("unknown predicate op");
    }),
    scope: fieldFromHex(o.scope),
    limit: o.limit,
    signal: fieldFromHex(o.signal),
  };
  checkStatement(s);
  return s;
}

/** Equal as public inputs: trailing "any" predicates are the same as missing ones. */
export function sameStatement(a: Statement, b: Statement): boolean {
  const pa = publicInputs(a, 0n);
  const pb = publicInputs(b, 0n);
  return a.groups.length === b.groups.length && pa.every((x, i) => x === pb[i]);
}
