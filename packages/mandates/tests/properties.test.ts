/**
 * Seeded random chains, parents, children and actions, evaluated on the policy's facts (no signatures),
 * so ten thousand cases per property run in seconds. A small generator, no new dependency.
 */
import { describe, expect, it } from "vitest";
import type { Constraint, LinkFacts, PolicyInput, Outcome } from "../src/index";
import { engine } from "./helpers";

const CASES = Number(process.env.PROPERTY_CASES ?? 10_000);

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  const chance = (p: number) => next() < p;
  const subset = <T>(xs: readonly T[], min = 0): T[] => {
    const out = xs.filter(() => chance(0.5));
    while (out.length < min) out.push(pick(xs));
    return [...new Set(out)];
  };
  return { int, pick, chance, subset };
}
type R = ReturnType<typeof rng>;

const TYPES = ["t/a", "t/b", "t/c"];
const WHO = ["p1", "p2", "p3", "p4"];
const CATS = ["a", "a.x", "a.y", "a.x.z", "b", "b.q"];
const PATTERNS = ["a.*", "a.x.*", "a.x", "a.y", "b.*", "b", "a"];
const PERIODS = ["P1D", "total"] as const;
const DIMS = ["types", "who", "notWho", "cat", "tags", "nMax", "nMin", "flag", "perTx", "daily", "total"] as const;

function constraintFor(r: R, dim: (typeof DIMS)[number]): Constraint {
  const when = r.chance(0.3) ? { when: r.subset(TYPES, 1) } : {};
  switch (dim) {
    case "types":
      return { attr: "type", anyOf: r.subset(TYPES, 1) };
    case "who":
      return { attr: "who", anyOf: r.subset(WHO, 1), ...when };
    case "notWho":
      return { attr: "who", noneOf: r.subset(WHO), ...when };
    case "cat":
      return { attr: "cat", within: r.subset(PATTERNS, 1), ...when };
    case "tags":
      return { attr: "tags", within: r.subset(PATTERNS, 1), ...when };
    case "nMax":
      return { attr: "n", max: r.int(11), ...when };
    case "nMin":
      return { attr: "n", min: r.int(11), ...when };
    case "flag":
      return { attr: "flag", is: r.chance(0.5), ...when };
    case "perTx":
      return { attr: "spend", max: String(r.int(11)), ...when };
    case "daily":
      return { attr: "spend", budget: String(r.int(21)), period: "P1D", ...when };
    case "total":
      return { attr: "spend", budget: String(r.int(31)), period: r.pick(PERIODS) };
  }
}

/** Usually narrower than `c`, sometimes wider or changed. */
function mutate(r: R, c: Constraint): Constraint {
  const out = structuredClone(c) as any;
  const roll = r.int(10);
  const widen = roll >= 8;
  if (roll === 9 && out.when) delete out.when;
  else if (roll === 9) out.when = r.subset(TYPES, 1);
  if ("anyOf" in out) out.anyOf = widen ? [...new Set([...out.anyOf, r.pick(out.attr === "type" ? TYPES : WHO)])] : r.subset(out.anyOf, 1);
  else if ("noneOf" in out) out.noneOf = widen ? r.subset(out.noneOf) : [...new Set([...out.noneOf, ...r.subset(WHO)])];
  else if ("within" in out) out.within = widen ? [...new Set([...out.within, r.pick(PATTERNS)])] : narrowPatterns(r, out.within);
  else if ("is" in out) out.is = widen ? !out.is : out.is;
  else if ("max" in out) out.max = bump(out.max, widen ? r.int(3) : -r.int(3));
  else if ("min" in out) out.min = bump(out.min, widen ? -r.int(3) : r.int(3));
  else if ("budget" in out) out.budget = bump(out.budget, widen ? r.int(3) : -r.int(3)) as string;
  return out;
}

function bump(v: string | number, d: number): string | number {
  const n = Math.max(0, Number(v) + d);
  return typeof v === "string" ? String(n) : n;
}

function narrowPatterns(r: R, ps: string[]): string[] {
  const out = ps.flatMap((p) => (p.endsWith(".*") && r.chance(0.5) ? [p.slice(0, -1) + r.pick(["x", "y", "x.*"])] : r.chance(0.8) ? [p] : []));
  return out.length ? out : [ps[0]];
}

let seq = 0;
function link(constraints: Record<string, Constraint>, o: { depth: number; approvable: string[] }): LinkFacts {
  const i = ++seq;
  return {
    id: `urn:uuid:${i}`,
    issuer: `did:example:${i}`,
    subject: `did:example:${i + 1}`,
    profile: "test/1",
    validFromS: 0,
    validUntilS: 1000,
    constraints,
    delegation: { maxDepth: o.depth },
    escalation: { approvable: o.approvable, approvalTtlSeconds: 60 },
    revocation: { maxAgeSeconds: 60 },
  };
}

function rootLink(r: R, o: { budgets: boolean }): LinkFacts {
  const dims = DIMS.filter((d) => d === "types" || (r.chance(0.45) && (o.budgets || !["daily", "total"].includes(d))));
  const constraints = Object.fromEntries(dims.map((d) => [d, constraintFor(r, d)]));
  return link(constraints, { depth: 3, approvable: r.subset(dims) });
}

function childLink(r: R, p: LinkFacts, o: { budgets: boolean; wide?: number }): LinkFacts {
  const constraints: Record<string, Constraint> = {};
  const wide = o.wide ?? 0.1;
  for (const [name, c] of Object.entries(p.constraints)) {
    if (r.chance(wide / 3)) continue; // dropped
    constraints[name] = r.chance(0.5) ? c : mutate(r, c);
  }
  for (const d of DIMS) if (!constraints[d] && r.chance(0.15) && (o.budgets || !["daily", "total"].includes(d))) constraints[d] = constraintFor(r, d);
  const approvable = r.chance(wide) ? [...p.escalation!.approvable, "nMax"] : r.subset(p.escalation!.approvable);
  const c = link(constraints, { depth: r.chance(wide) ? p.delegation.maxDepth : p.delegation.maxDepth - 1, approvable });
  c.issuer = p.subject;
  return c;
}

function action(r: R): PolicyInput["action"] {
  const attrs: Record<string, unknown> = { spend: String(r.int(12)) };
  if (r.chance(0.9)) attrs.who = r.pick(WHO);
  if (r.chance(0.9)) attrs.cat = r.pick(CATS);
  if (r.chance(0.9)) attrs.tags = r.subset(CATS, 1);
  if (r.chance(0.9)) attrs.n = r.int(12);
  if (r.chance(0.9)) attrs.flag = r.chance(0.5);
  return { type: r.pick(TYPES), profile: "test/1", id: "a", actor: "x", at: "t", attrs: attrs as never };
}

function input(chain: LinkFacts[], act: PolicyInput["action"], r: R, skipNarrowing = false): PolicyInput {
  const spent = { P1D: String(r.int(15)), P7D: "0", P30D: "0", total: String(r.int(25)) };
  return {
    nowS: 500,
    action: act,
    actionHash: "sha256:a",
    chain,
    structural: [],
    approvalProblems: [],
    state: { spent: Object.fromEntries(chain.map((l) => [l.id, spent])) },
    approvals: [],
    requirements: {},
    facts: { rootCredentials: [], passport: null },
    ...(skipNarrowing ? { options: { skipNarrowing: true } } : {}),
  };
}

describe("properties of the policy (§15)", () => {
  it(`monotonicity: adding a link never turns deny or escalate into allow (${CASES} cases)`, async () => {
    const e = await engine();
    const r = rng(1);
    const seen: Record<Outcome, number> = { allow: 0, escalate: 0, deny: 0 };
    for (let i = 0; i < CASES; i++) {
      const root = rootLink(r, { budgets: true });
      const chain = [root];
      if (r.chance(0.5)) chain.push(childLink(r, root, { budgets: true }));
      const longer = [...chain, childLink(r, chain[chain.length - 1], { budgets: true })];
      const a = action(r);
      const seed = r.int(1e9);
      const before = e.evaluate(input(chain, a, rng(seed))).outcome;
      const after = e.evaluate(input(longer, a, rng(seed))).outcome;
      seen[before]++;
      if (before !== "allow") expect(after, JSON.stringify({ chain: longer, a })).not.toBe("allow");
    }
    expect(Math.min(seen.allow, seen.escalate, seen.deny)).toBeGreaterThan(CASES / 50);
  });

  it(`narrowing is sound: if narrows(p, c), every action c allows, p allows (${CASES} cases)`, async () => {
    const e = await engine();
    const r = rng(2);
    let narrowed = 0;
    let allowed = 0;
    for (let i = 0; i < CASES; i++) {
      const p = rootLink(r, { budgets: true });
      const c = childLink(r, p, { budgets: true });
      if (e.narrowing(p, c).length > 0) continue;
      narrowed++;
      // Several actions per pair, so enough of them are allowed for the property to bite.
      for (let k = 0; k < 8; k++) {
        const a = action(r);
        const seed = r.int(1e9);
        if (e.evaluate(input([c], a, rng(seed))).outcome !== "allow") continue;
        allowed++;
        expect(e.evaluate(input([p], a, rng(seed))).outcome, JSON.stringify({ p, c, a })).toBe("allow");
      }
    }
    expect(narrowed).toBeGreaterThan(CASES / 10);
    expect(allowed).toBeGreaterThan(CASES / 100);
  });

  it(`narrowing is transitive over three links (${CASES} cases)`, async () => {
    const e = await engine();
    const r = rng(3);
    let both = 0;
    for (let i = 0; i < CASES; i++) {
      const a = rootLink(r, { budgets: true });
      const b = childLink(r, a, { budgets: true, wide: 0.03 });
      const c = childLink(r, b, { budgets: true, wide: 0.03 });
      if (e.narrowing(a, b).length > 0 || e.narrowing(b, c).length > 0) continue;
      both++;
      const ac = { ...c, issuer: a.subject };
      expect(e.narrowing(a, ac), JSON.stringify({ a, b, c })).toEqual([]);
    }
    expect(both).toBeGreaterThan(CASES / 10);
  });

  it(`the per-link check catches widening even with the narrowing step switched off (${CASES} cases)`, async () => {
    // Budgets are left out: only the leaf's budgets are evaluated, and an ancestor's are enforced by funding (§8.6).
    const e = await engine();
    const r = rng(4);
    let widened = 0;
    for (let i = 0; i < CASES; i++) {
      const p = rootLink(r, { budgets: false });
      const c = childLink(r, p, { budgets: false, wide: 0.6 });
      if (e.narrowing(p, c).length === 0) continue;
      widened++;
      const a = action(r);
      const seed = r.int(1e9);
      const skipped = e.evaluate(input([p, c], a, rng(seed), true)).outcome;
      expect(e.evaluate(input([p, c], a, rng(seed))).outcome).toBe("deny");
      if (e.evaluate(input([p], a, rng(seed))).outcome !== "allow") expect(skipped, JSON.stringify({ p, c, a })).not.toBe("allow");
    }
    expect(widened).toBeGreaterThan(CASES / 5);
  });
});
