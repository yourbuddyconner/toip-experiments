/** Gates and eligibility in words, for people (design §10.1). */
import type { Gate, GatePredicate, GroupDescriptor, SlotSpec } from "./documents";

function list(xs: string[], joiner = "or"): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} ${joiner} ${xs[xs.length - 1]}`;
}

const OP_WORDS = { eq: "", gte: "at least ", lte: "at most " } as const;

function predicateWords(p: GatePredicate, slot: SlotSpec | undefined): string {
  const label = slot?.label ?? p.attr;
  if (slot?.encoding === "day") return p.op === "lte" ? `${label} on or before ${p.value}` : p.op === "gte" ? `${label} on or after ${p.value}` : `${label} ${p.value}`;
  return `${label} ${OP_WORDS[p.op]}${p.value}`;
}

/** "a nursing license with license type RN, from Cascade Board of Nursing or Pine Valley Board of Nursing, held in a group for at least 7 days" */
export function gateInWords(gate: Gate, descs: (GroupDescriptor | undefined)[]): string {
  const known = descs.filter((d): d is GroupDescriptor => !!d);
  if (!known.length) return "membership in a group this app doesn't know";
  const slots = known[0].schema.slots;
  const what = known[0].credentialLabel;
  const preds = gate.where.map((p) => predicateWords(p, slots.find((s) => s?.name === p.attr) ?? undefined));
  let s = `${/^[aeiou]/i.test(what) ? "an" : "a"} ${what}`;
  if (preds.length) s += ` with ${list(preds, "and")}`;
  s += `, from ${list(known.map((d) => d.title))}`;
  if (gate.minRegisteredDays > 0) s += `, held in a group for at least ${gate.minRegisteredDays} day${gate.minRegisteredDays === 1 ? "" : "s"}`;
  return s;
}

/** What a member's plain values are, per group, as their client keeps them. */
export interface MembershipView {
  group: string;
  values: Record<string, string>;
  registeredDay: number;
  validUntilDay: number;
  /** Whether the latest root holds the leaf yet. */
  inRoot: boolean;
}

export type Eligibility =
  | { ok: true; group: string }
  | { ok: false; reason: string; code: "noMembership" | "attribute" | "tooRecent" | "expired" | "notInRootYet" };

function holds(p: GatePredicate, value: string | undefined, slot: SlotSpec | undefined): boolean {
  if (value === undefined) return false;
  if (p.op === "eq") return value === p.value;
  const enc = (v: string) => (slot?.encoding === "day" ? Date.parse(v + "T00:00:00Z") : Number(v));
  return p.op === "gte" ? enc(value) >= enc(p.value) : enc(value) <= enc(p.value);
}

/** Whether a member can prove this gate, and if not, why, in words. Checked before any proof. */
export function eligibility(gate: Gate, descs: (GroupDescriptor | undefined)[], mine: MembershipView[], today: number, purpose = "This forum"): Eligibility {
  const inGate = mine.filter((m) => gate.anyOf.some((g) => g.group === m.group));
  const desc = (group: string) => descs.find((d) => d?.id === group);
  if (!inGate.length) {
    const what = descs.find(Boolean)?.credentialLabel ?? "membership";
    return { ok: false, code: "noMembership", reason: `${purpose} needs ${gateInWords(gate, descs)}. You haven't joined any of these groups with a ${what}.` };
  }
  let firstWhy: Eligibility | null = null;
  for (const m of inGate) {
    const slots = desc(m.group)?.schema.slots ?? [];
    const failed = gate.where.find((p) => !holds(p, m.values[p.attr], slots.find((s) => s?.name === p.attr) ?? undefined));
    if (failed) {
      const slot = slots.find((s) => s?.name === failed.attr) ?? undefined;
      const yours = m.values[failed.attr];
      firstWhy ??= {
        ok: false,
        code: "attribute",
        reason:
          failed.op === "eq"
            ? `${purpose} is for ${slot?.label ?? failed.attr} ${failed.value}; yours is ${yours ?? "not set"}.`
            : `${purpose} needs ${predicateWords(failed, slot)}; yours is ${yours ?? "not set"}.`,
      };
      continue;
    }
    if (m.validUntilDay < today) {
      firstWhy ??= { ok: false, code: "expired", reason: `Your membership in ${desc(m.group)?.title ?? m.group} has expired. Renew your credential and join again.` };
      continue;
    }
    const wait = m.registeredDay + gate.minRegisteredDays - today;
    if (wait > 0) {
      firstWhy ??= { ok: false, code: "tooRecent", reason: `${purpose} needs a membership held for ${gate.minRegisteredDays} days. You can post in ${wait} day${wait === 1 ? "" : "s"}.` };
      continue;
    }
    if (!m.inRoot) {
      firstWhy ??= { ok: false, code: "notInRootYet", reason: `${desc(m.group)?.title ?? "The group"} hasn't published a root with your membership yet. Roots come out at most once an hour.` };
      continue;
    }
    return { ok: true, group: m.group };
  }
  return firstWhy!;
}
