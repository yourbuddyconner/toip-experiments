/**
 * From a forum's gate to the circuit's statement (design §7.4). The host and the client both call
 * compileGate, so they make the same public inputs; the host requires an exact match.
 */
import {
  dayFromIso,
  fieldFromBytes,
  fieldFromHex,
  fieldToHex,
  groupFieldOf,
  messageOf,
  scopeOf,
  type Field,
  type LeafFields,
  type Predicate,
  type Statement,
} from "@toip-tools/anon-membership";
import type { Credential } from "@toip-tools/trust-core";
import { APP, type Encoding, type Gate, type GroupDescriptor, type GroupRoot, type NymPass, type SlotSpec } from "./documents";

const enc = new TextEncoder();
const U64 = 1n << 64n;

/** f(utf8(value)), the design's f(). */
export function fieldOfText(text: string): Field {
  return fieldFromBytes(enc.encode(text));
}

export function schemaFieldOf(schemaId: string): Field {
  return fieldOfText(schemaId);
}

/** An attribute value as a field, by its slot's encoding. */
export function encodeAttribute(value: unknown, encoding: Encoding): Field {
  if (value === undefined || value === null || value === "") throw new GateError(`missing value`);
  switch (encoding) {
    case "hash":
      return fieldOfText(String(value));
    case "u64": {
      const s = String(value);
      if (!/^\d+$/.test(s)) throw new GateError(`not a whole number: ${s}`);
      const n = BigInt(s);
      if (n >= U64) throw new GateError(`too large: ${s}`);
      return n;
    }
    case "day":
      try {
        return BigInt(dayFromIso(String(value)));
      } catch {
        throw new GateError(`not a date: ${String(value)}`);
      }
  }
}

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

function pick(obj: unknown, path: string): unknown {
  let v: unknown = obj;
  for (const k of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

/** The leaf's fields for a credential: schema, days and attributes. validUntilDay defaults to a year after joining. */
export function leafFieldsFromCredential(desc: GroupDescriptor, vc: Credential, registeredDay: number): { fields: LeafFields; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const attrs = desc.schema.slots.map((slot) => {
    if (!slot) return 0n;
    const v = pick(vc, slot.from);
    values[slot.name] = String(v);
    return encodeAttribute(v, slot.encoding);
  }) as LeafFields["attrs"];
  while (attrs.length < 4) attrs.push(0n);
  const validUntilDay = vc.validUntil ? Math.floor(Date.parse(vc.validUntil) / 86_400_000) : registeredDay + 365;
  return { fields: { schemaId: fieldFromHex(desc.schema.schemaId), validUntilDay, registeredDay, attrs }, values };
}

/** Why a gate can't be compiled against these descriptors, or null. */
export function gateProblem(gate: Gate, descs: (GroupDescriptor | undefined)[]): string | null {
  if (!gate || !Array.isArray(gate.anyOf) || gate.anyOf.length < 1 || gate.anyOf.length > 4) return "a gate names 1 to 4 groups";
  if (new Set(gate.anyOf.map((g) => g.group)).size !== gate.anyOf.length) return "a gate names each group once";
  for (let i = 0; i < gate.anyOf.length; i++) {
    const d = descs[i];
    if (!d || d.id !== gate.anyOf[i].group) return `unknown group ${gate.anyOf[i].group}`;
    if (d.issuer !== gate.anyOf[i].registrar) return `group ${d.id} is run by another registrar`;
  }
  const schema = descs[0]!.schema.schemaId;
  if (descs.some((d) => d!.schema.schemaId !== schema)) return "every group in a gate must have the same schema";
  if (!Array.isArray(gate.where) || gate.where.length > 4) return "at most 4 predicates";
  const slots = descs[0]!.schema.slots;
  const used = new Set<number>();
  for (const p of gate.where) {
    const j = slots.findIndex((s) => s?.name === p.attr);
    if (j < 0) return `no attribute named ${p.attr}`;
    if (used.has(j)) return `two predicates on ${p.attr}`;
    used.add(j);
    if (!["eq", "gte", "lte"].includes(p.op)) return `unknown op ${p.op}`;
    if (p.op !== "eq" && slots[j]!.encoding === "hash") return `${p.attr} can only be compared for equality`;
    try {
      encodeAttribute(p.value, slots[j]!.encoding);
    } catch (e) {
      return `${p.attr}: ${(e as Error).message}`;
    }
  }
  if (!Number.isInteger(gate.minRegisteredDays) || gate.minRegisteredDays < 0 || gate.minRegisteredDays > 3650) return "minRegisteredDays must be 0 to 3650";
  if (!Number.isInteger(gate.minAnonymitySet) || gate.minAnonymitySet < 0) return "minAnonymitySet must be a whole number";
  return null;
}

/** The statement's predicates, one per slot, from the gate's `where`. */
export function compilePredicates(gate: Gate, slots: (SlotSpec | null)[]): Predicate[] {
  return [0, 1, 2, 3].map((j) => {
    const slot = slots[j];
    const p = slot ? gate.where.find((w) => w.attr === slot.name) : undefined;
    if (!slot || !p) return { op: "any" } as Predicate;
    return { op: p.op, value: encodeAttribute(p.value, slot.encoding) } as Predicate;
  });
}

/**
 * The exact statement a proof for this gate must have. `descs` and `roots` are in gate order.
 * Throws GateError if the gate is malformed.
 */
export function compileGate(o: { gate: Gate; descs: GroupDescriptor[]; roots: Field[]; today: number; scope: Field; signal: Field; limit?: number }): Statement {
  const why = gateProblem(o.gate, o.descs);
  if (why) throw new GateError(why);
  if (o.roots.length !== o.descs.length) throw new GateError("one root per group");
  return {
    groups: o.descs.map((d, i) => ({ groupId: groupFieldOf(d.id), root: o.roots[i] })),
    schemaId: fieldFromHex(o.descs[0].schema.schemaId),
    today: o.today,
    registeredBy: o.today - o.gate.minRegisteredDays,
    predicates: compilePredicates(o.gate, o.descs[0].schema.slots),
    scope: o.scope,
    limit: o.limit ?? 1,
    signal: o.signal,
  };
}

// ── Scopes and signals ─────────────────────────────────────────────

export const forumNymScope = (forumId: string) => scopeOf(APP, "forum-nym", forumId);
export const threadNymScope = (forumId: string, threadId: string) => scopeOf(APP, "thread-nym", forumId, threadId);
export const pollScope = (pollId: string) => scopeOf(APP, "poll", pollId);

/** The scope a pass is for: the forum's, or one thread's. */
export function passScope(forumId: string, thread: string | null): Field {
  return thread ? threadNymScope(forumId, thread) : forumNymScope(forumId);
}

/** f(JCS(pass without zk and proof)): binds the proof to the session DID, the forum, the policy and the times. */
export function passSignal(pass: Omit<NymPass, "zk" | "proof"> & { zk?: unknown; proof?: unknown }): Field {
  const { zk: _z, proof: _p, ...rest } = pass;
  return messageOf(APP, { kind: "nym-pass", pass: rest });
}

export function voteSignal(pollId: string, choice: number): Field {
  return messageOf(APP, { kind: "vote", poll: pollId, choice });
}

// ── Anonymity sets ─────────────────────────────────────────────────

/**
 * About how many people could have made a proof: the sum of the groups' sizes, narrowed by the
 * published counts for equality predicates. Range predicates and minRegisteredDays narrow it further,
 * by an amount nobody outside the registrar can count.
 */
export function anonymityEstimate(gate: Gate, descs: GroupDescriptor[], roots: (GroupRoot | undefined)[]): number {
  let total = 0;
  for (let i = 0; i < descs.length; i++) {
    const r = roots[i];
    if (!r) continue;
    let n = r.size;
    const counts = (r.ext?.counts ?? {}) as Record<string, Record<string, number>>;
    for (const p of gate.where) {
      if (p.op !== "eq") continue;
      const slot = descs[i].schema.slots.find((s) => s?.name === p.attr);
      if (!slot?.publishCounts || !counts[slot.name]) continue;
      n = Math.min(n, counts[slot.name][fieldToHex(encodeAttribute(p.value, slot.encoding))] ?? 0);
    }
    total += n;
  }
  return total;
}
