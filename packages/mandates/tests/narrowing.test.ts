import { describe, expect, it } from "vitest";
import { delegate, mandateHash, narrows, type Constraint, type Mandate } from "../src/index";
import { codes, engine, inDays, payAction, people, resign, rootMandate, settleConstraints, usdc, world, zeroSpent, type World } from "./helpers";

const extra: Record<string, Constraint> = {
  blocked: { attr: "counterparty", noneOf: [people.mallory.did] },
  pricing: { attr: "pricing", is: "fixed", when: ["agents/job/offer"] },
  minWindow: { attr: "disputeWindowSeconds", min: 10, when: ["settle/pay"] },
};

function parent(w: World, o: Parameters<typeof rootMandate>[1] = {}): Mandate {
  return rootMandate(w, { constraints: { ...settleConstraints(), ...extra }, delegation: { maxDepth: 2 }, ...o });
}

/** A child of `p` with the same everything, edited by `edit`. */
function child(w: World, p: Mandate, edit: (m: Mandate) => void = () => {}): Mandate {
  return resign(p, people.ops, w.clock, (m) => {
    m.id = `urn:uuid:child-${Math.random()}`;
    m.issuer = people.ops.did;
    m.credentialSubject.id = people.errands.did;
    m.credentialSubject.parent = { id: p.id, hash: mandateHash(p) };
    m.credentialSubject.delegation = { maxDepth: p.credentialSubject.delegation.maxDepth - 1 };
    m.validUntil = inDays(w.clock, 3);
    m.credentialStatus = { type: "BitstringStatusListEntry", statusListIndex: 0, statusListCredential: `${people.ops.did}#status` };
    edit(m);
  });
}

const set = (dim: string, c: Constraint) => (m: Mandate) => {
  m.credentialSubject.constraints[dim] = c;
};

async function problems(w: World, p: Mandate, edit?: (m: Mandate) => void) {
  return codes({ reasons: await narrows(p, child(w, p, edit)) });
}

describe("narrowing (§7.2, §7.3)", () => {
  const cases: { op: string; dim: string; narrower: Constraint; wider: Constraint; widerCode?: string }[] = [
    {
      op: "anyOf",
      dim: "attesters",
      narrower: { attr: "attester", anyOf: [people.ci.did], when: ["settle/pay"] },
      wider: { attr: "attester", anyOf: [people.ci.did, people.conner.did, people.mallory.did], when: ["settle/pay"] },
    },
    {
      op: "noneOf",
      dim: "blocked",
      narrower: { attr: "counterparty", noneOf: [people.mallory.did, people.arbiter.did] },
      wider: { attr: "counterparty", noneOf: [] },
    },
    {
      op: "within",
      dim: "categories",
      narrower: { attr: "category", within: ["software.ci", "software.tests.*", "physical.errand"], when: ["settle/pay", "agents/job/offer"] },
      wider: { attr: "category", within: ["software.*", "physical.*"], when: ["settle/pay", "agents/job/offer"] },
    },
    {
      op: "is",
      dim: "pricing",
      narrower: { attr: "pricing", is: "fixed", when: ["agents/job/offer"] },
      wider: { attr: "pricing", is: "hourly", when: ["agents/job/offer"] },
    },
    {
      op: "max",
      dim: "spendPerTx",
      narrower: { attr: "spend", max: usdc(20), when: ["settle/pay"] },
      wider: { attr: "spend", max: String(Number(usdc(30)) + 1), when: ["settle/pay"] },
    },
    {
      op: "min",
      dim: "minWindow",
      narrower: { attr: "disputeWindowSeconds", min: 3600, when: ["settle/pay"] },
      wider: { attr: "disputeWindowSeconds", min: 9, when: ["settle/pay"] },
    },
    {
      op: "budget",
      dim: "spendPerDay",
      narrower: { attr: "spend", budget: usdc(50), period: "P1D" },
      wider: { attr: "spend", budget: usdc(101), period: "P1D" },
    },
  ];

  for (const c of cases) {
    it(`${c.op}: a narrower child passes, an equal child passes, a wider one fails`, async () => {
      const w = world();
      const p = parent(w);
      expect(await problems(w, p, set(c.dim, c.narrower))).toEqual([]);
      expect(await problems(w, p)).toEqual([]);
      const r = await narrows(p, child(w, p, set(c.dim, c.wider)));
      expect(r.map((x) => x.code)).toEqual(["narrowing.widened"]);
      expect(r[0]).toMatchObject({ link: 1, dimension: c.dim, op: c.op, approvable: false });
    });
  }

  it("within: a wildcard child isn't covered by an exact parent", async () => {
    const w = world();
    const p = parent(w, { constraints: { ...settleConstraints(), categories: { attr: "category", within: ["software.ci"] } } });
    expect(await problems(w, p, set("categories", { attr: "category", within: ["software.*"] }))).toEqual(["narrowing.widened"]);
    expect(await problems(w, p, set("categories", { attr: "category", within: ["software.ci.*"] }))).toEqual(["narrowing.widened"]);
    expect(await problems(w, p, set("categories", { attr: "category", within: ["software"] }))).toEqual(["narrowing.widened"]);
  });

  it("a dropped dimension fails: narrowing.dropped", async () => {
    const w = world();
    const p = parent(w);
    expect(await problems(w, p, (m) => delete m.credentialSubject.constraints.blocked)).toEqual(["narrowing.dropped"]);
    expect(await problems(w, p, (m) => delete m.credentialSubject.constraints.spendTotal)).toEqual(["narrowing.dropped"]);
  });

  it("an added dimension passes", async () => {
    const w = world();
    const p = parent(w);
    expect(await problems(w, p, set("onlyDana", { attr: "counterparty", anyOf: [people.dana.did], when: ["settle/pay"] }))).toEqual([]);
  });

  it("a changed attr, operator or budget period fails: narrowing.changedMeaning", async () => {
    const w = world();
    const p = parent(w);
    expect(await problems(w, p, set("spendPerTx", { attr: "price", max: usdc(30), when: ["settle/pay"] }))).toEqual(["narrowing.changedMeaning"]);
    expect(await problems(w, p, set("attesters", { attr: "attester", within: [people.ci.did], when: ["settle/pay"] }))).toEqual(["narrowing.changedMeaning"]);
    expect(await problems(w, p, set("spendPerDay", { attr: "spend", budget: usdc(100), period: "P7D" }))).toEqual(["narrowing.changedMeaning"]);
  });

  it("`when`: the same or wider passes, narrowed fails", async () => {
    const w = world();
    const p = parent(w);
    const tx = (when?: string[]) => set("spendPerTx", { attr: "spend", max: usdc(30), ...(when ? { when } : {}) });
    expect(await problems(w, p, tx(["settle/pay"]))).toEqual([]);
    expect(await problems(w, p, tx(["settle/pay", "mandates/delegate"]))).toEqual([]);
    expect(await problems(w, p, tx())).toEqual([]);
    expect(await problems(w, p, tx(["mandates/delegate"]))).toEqual(["narrowing.widened"]);
    const r = await narrows(p, child(w, p, tx(["mandates/delegate"])));
    expect(r[0]).toMatchObject({ dimension: "spendPerTx", op: "when" });
    // A limit that applied to every action can't be scoped to some.
    expect(await problems(w, p, set("spendPerDay", { attr: "spend", budget: usdc(100), period: "P1D", when: ["settle/pay"] }))).toEqual(["narrowing.widened"]);
  });

  it("delegation.maxDepth: not reduced fails, and a parent with 0 can't delegate", async () => {
    const w = world();
    const p = parent(w);
    expect(await problems(w, p, (m) => (m.credentialSubject.delegation.maxDepth = 2))).toEqual(["narrowing.depth"]);
    expect(await problems(w, p, (m) => (m.credentialSubject.delegation.maxDepth = 0))).toEqual([]);
    const zero = parent(w, { delegation: { maxDepth: 0 } });
    expect(await problems(w, zero, (m) => (m.credentialSubject.delegation.maxDepth = 0))).toEqual(["narrowing.depth"]);
  });

  it("escalation: approvable, approvalTtlSeconds, and escalation where the parent has none each fail", async () => {
    const w = world();
    const p = parent(w);
    const esc = (approvable: string[], approvalTtlSeconds: number) => (m: Mandate) => (m.credentialSubject.escalation = { approvable, approvalTtlSeconds });
    expect(await problems(w, p, esc(["spendPerTx"], 600))).toEqual([]);
    expect(await problems(w, p, (m) => delete m.credentialSubject.escalation)).toEqual([]);
    expect(await problems(w, p, esc(["spendPerTx", "asset"], 3600))).toEqual(["narrowing.escalation"]);
    expect(await problems(w, p, esc(["spendPerTx"], 3601))).toEqual(["narrowing.escalation"]);
    const none = parent(w, { escalation: undefined });
    expect(await problems(w, none, esc(["spendPerTx"], 60))).toEqual(["narrowing.escalation"]);
  });

  it("revocation.maxAgeSeconds widened fails", async () => {
    const w = world();
    const p = parent(w);
    expect(await problems(w, p, (m) => (m.credentialSubject.revocation.maxAgeSeconds = 600))).toEqual([]);
    expect(await problems(w, p, (m) => (m.credentialSubject.revocation.maxAgeSeconds = 7200))).toEqual(["narrowing.revocation"]);
  });

  it("the time window: a later expiry or an earlier start fails", async () => {
    const w = world();
    const p = parent(w);
    expect(await problems(w, p, (m) => (m.validUntil = inDays(w.clock, 8)))).toEqual(["narrowing.window"]);
    expect(await problems(w, p, (m) => (m.validFrom = new Date(w.clock.now() - 1000).toISOString()))).toEqual(["narrowing.window"]);
  });

  it("reports every problem of a child that widens several things", async () => {
    const w = world();
    const p = parent(w);
    const r = await narrows(
      p,
      child(w, p, (m) => {
        set("spendPerTx", { attr: "spend", max: usdc(31), when: ["settle/pay"] })(m);
        delete m.credentialSubject.constraints.blocked;
        m.credentialSubject.revocation.maxAgeSeconds = 86_400;
      }),
    );
    expect(codes({ reasons: r })).toEqual(["narrowing.dropped", "narrowing.revocation", "narrowing.widened"]);
  });
});

describe("delegate()", () => {
  it("signs a child that narrows, linked to its parent", async () => {
    const w = world();
    const root = rootMandate(w);
    const r = await delegate([root], people.ops, w.clock, {
      subject: people.errands.did,
      validUntil: inDays(w.clock, 3),
      status: w.opsStatus.allocate(),
      tighten: { spendPerTx: { attr: "spend", max: usdc(20), when: ["settle/pay"] } },
      add: { onlyDana: { attr: "counterparty", anyOf: [people.dana.did], when: ["settle/pay"] } },
      purpose: "Errands only.",
    });
    if (!("mandate" in r)) throw new Error(JSON.stringify(r.problems));
    const m = r.mandate;
    expect(m.issuer).toBe(people.ops.did);
    expect(m.credentialSubject.parent).toEqual({ id: root.id, hash: mandateHash(root) });
    expect(m.credentialSubject.delegation.maxDepth).toBe(0);
    expect(m.credentialSubject.constraints.spendTotal).toEqual(root.credentialSubject.constraints.spendTotal);
    expect(m.credentialSubject.escalation).toEqual(root.credentialSubject.escalation);
    expect(m.proof).toBeDefined();
  });

  it("returns problems and signs nothing when the child would widen", async () => {
    const w = world();
    const root = rootMandate(w);
    const r = await delegate([root], people.ops, w.clock, {
      subject: people.errands.did,
      validUntil: inDays(w.clock, 30),
      status: w.opsStatus.allocate(),
      tighten: { spendPerTx: { attr: "spend", max: usdc(500), when: ["settle/pay"] } },
    });
    expect("problems" in r && codes({ reasons: r.problems })).toEqual(["narrowing.widened", "narrowing.window"]);
  });

  it("refuses a delegator who isn't the leaf's subject, and a tighten of an unknown dimension", async () => {
    const w = world();
    const root = rootMandate(w);
    const o = { subject: people.errands.did, validUntil: inDays(w.clock, 3), status: w.opsStatus.allocate(), tighten: {} };
    const notMine = await delegate([root], people.mallory, w.clock, o);
    expect("problems" in notMine && codes({ reasons: notMine.problems })).toEqual(["chain.brokenLink"]);
    const unknown = await delegate([root], people.ops, w.clock, { ...o, tighten: { nope: { attr: "spend", max: "1" } } });
    expect("problems" in unknown && codes({ reasons: unknown.problems })).toEqual(["chain.malformed"]);
    const zero = rootMandate(w, { delegation: { maxDepth: 0 } });
    const fromZero = await delegate([zero], people.ops, w.clock, o);
    expect("problems" in fromZero && codes({ reasons: fromZero.problems })).toEqual(["narrowing.depth"]);
  });

  it("a widened chain is denied outright by decide, never escalated", async () => {
    const w = world();
    const root = rootMandate(w);
    const wide = child(w, root, set("spendPerTx", { attr: "spend", max: usdc(100), when: ["settle/pay"] }));
    // 45 USDC is over the root's approvable 30 USDC per payment, but the widened link makes it a deny.
    const action = payAction(w, people.errands.did, { spend: usdc(45) });
    const d = await (await engine()).decide({ chain: [root, wide], presenter: people.errands.did, action, state: zeroSpent(wide), status: w.status(), clock: w.clock });
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toEqual(["constraint.failed", "narrowing.widened"]);
    expect(d.reasons.find((r) => r.code === "constraint.failed")).toMatchObject({ link: 0, dimension: "spendPerTx", approvable: true });
  });
});
