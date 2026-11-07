import { describe, expect, it } from "vitest";
import { SpendLedger, delegate, type Action, type Constraint, type Mandate, type SpendStatement } from "../src/index";
import { MINT, codes, engine, inDays, payAction, people, rootMandate, settleConstraints, twoLinks, usdc, world, zeroSpent, type World } from "./helpers";

async function decide(w: World, chain: Mandate[], action: Action, state?: SpendStatement) {
  const leaf = chain[chain.length - 1];
  return (await engine()).decide({ chain, presenter: leaf.credentialSubject.id, action, state: state ?? zeroSpent(leaf), status: w.status(), clock: w.clock });
}

function rootWith(w: World, extra: Record<string, Constraint>) {
  return rootMandate(w, { constraints: { ...settleConstraints(), ...extra } });
}

const ops = people.ops.did;

describe("the action against the chain (§8.2 step 10)", () => {
  it("max: the limit itself is allowed, one more unit is over", async () => {
    const w = world();
    const root = rootMandate(w);
    expect((await decide(w, [root], payAction(w, ops, { spend: usdc(30) }))).outcome).toBe("allow");
    const d = await decide(w, [root], payAction(w, ops, { spend: String(Number(usdc(30)) + 1) }));
    expect(d.outcome).toBe("escalate");
    expect(d.approver).toBe(people.conner.did);
    expect(d.reasons).toEqual([
      { code: "constraint.failed", link: 0, dimension: "spendPerTx", op: "max", attr: "spend", limit: usdc(30), value: "30000001", approvable: true },
    ]);
  });

  it("min: the limit itself is allowed, one less is denied when not approvable", async () => {
    const w = world();
    const root = rootWith(w, { minWindow: { attr: "disputeWindowSeconds", min: 3600, when: ["settle/pay"] } });
    expect((await decide(w, [root], payAction(w, ops, { disputeWindowSeconds: 3600 }))).outcome).toBe("allow");
    const d = await decide(w, [root], payAction(w, ops, { disputeWindowSeconds: 3599 }));
    expect(d.outcome).toBe("deny");
    expect(d.reasons[0]).toMatchObject({ code: "constraint.failed", dimension: "minWindow", op: "min", limit: 3600, value: 3599, approvable: false });
  });

  it("anyOf: an attester outside the set is denied; an array attribute needs one element in the set", async () => {
    const w = world();
    const root = rootWith(w, { verified: { attr: "counterpartyCredentials", anyOf: [`VerifiedBusiness@${people.verify.did}`], when: ["settle/pay"] } });
    const d = await decide(w, [root], payAction(w, ops, { attester: people.mallory.did }));
    expect(d.outcome).toBe("deny");
    expect(d.reasons[0]).toMatchObject({ dimension: "attesters", op: "anyOf", value: people.mallory.did });
    expect((await decide(w, [root], payAction(w, ops, { counterpartyCredentials: ["Other@x", `VerifiedBusiness@${people.verify.did}`] }))).outcome).toBe("allow");
    expect(codes(await decide(w, [root], payAction(w, ops, { counterpartyCredentials: ["Other@x"] })))).toEqual(["constraint.failed"]);
    expect(codes(await decide(w, [root], payAction(w, ops, { counterpartyCredentials: [] })))).toEqual(["constraint.failed"]);
  });

  it("noneOf: a listed value is denied, for strings and arrays", async () => {
    const w = world();
    const root = rootWith(w, {
      blocked: { attr: "counterparty", noneOf: [people.mallory.did] },
      noShady: { attr: "counterpartyCredentials", noneOf: ["Shady@x"], when: ["settle/pay"] },
    });
    expect((await decide(w, [root], payAction(w, ops))).outcome).toBe("allow");
    expect(codes(await decide(w, [root], payAction(w, ops, { counterparty: people.mallory.did })))).toEqual(["constraint.failed"]);
    expect(codes(await decide(w, [root], payAction(w, ops, { counterpartyCredentials: ["Fine@y", "Shady@x"] })))).toEqual(["constraint.failed"]);
  });

  it("within: patterns match by prefix; every element of an array must match", async () => {
    const w = world();
    const root = rootWith(w, { labels: { attr: "labels", within: ["software.*"], when: ["settle/pay"] } });
    const ok = (category: string, labels: string[] = ["software.ci"]) => decide(w, [root], payAction(w, ops, { category, labels }));
    expect((await ok("software.ci")).outcome).toBe("allow");
    expect((await ok("software.tests.unit")).outcome).toBe("allow");
    expect((await ok("physical.errand")).outcome).toBe("allow");
    expect((await ok("software")).outcome).toBe("escalate");
    expect((await ok("physical.errand.big")).outcome).toBe("escalate");
    expect((await ok("softwareX.ci")).outcome).toBe("escalate");
    expect(codes(await ok("software.ci", ["software.a", "physical.b"]))).toEqual(["constraint.failed"]);
    expect(codes(await ok("software.ci", []))).toEqual(["constraint.failed"]);
  });

  it("is: equal passes, anything else fails", async () => {
    const w = world();
    const root = rootWith(w, { mustRelease: { attr: "attesterConfirms", is: true, when: ["settle/pay"] } });
    expect((await decide(w, [root], payAction(w, ops, { attesterConfirms: true }))).outcome).toBe("allow");
    expect(codes(await decide(w, [root], payAction(w, ops, { attesterConfirms: false })))).toEqual(["constraint.failed"]);
    expect(codes(await decide(w, [root], payAction(w, ops, { attesterConfirms: "true" })))).toEqual(["constraint.failed"]);
  });

  it("a numeric limit fails closed on a value that isn't a number", async () => {
    const w = world();
    const root = rootMandate(w);
    for (const bad of ["abc", true, ["1"]]) {
      expect(codes(await decide(w, [root], payAction(w, ops, { disputeWindowSeconds: bad as never }))), String(bad)).toEqual(["constraint.failed"]);
    }
  });

  it("a missing attribute denies: attr.missing", async () => {
    const w = world();
    const root = rootWith(w, { region: { attr: "region", anyOf: ["us"], when: ["settle/pay"] } });
    const d = await decide(w, [root], payAction(w, ops));
    expect(d.outcome).toBe("deny");
    expect(d.reasons).toEqual([{ code: "attr.missing", link: 0, dimension: "region", op: "anyOf", attr: "region", approvable: false }]);
  });

  it("`when` scopes a constraint to the action types it names", async () => {
    const w = world();
    const root = rootMandate(w);
    const fund: Action = {
      type: "mandates/delegate",
      profile: "settle/1",
      id: "act-fund",
      actor: ops,
      at: w.clock.iso(),
      attrs: { spend: usdc(50), counterparty: people.errands.did, child: "sha256:11", asset: MINT, task: "https://zk-toip.example/spec/mandates/issue/0.1" },
    };
    // spendPerTx (30) applies only to settle/pay, so funding 50 is fine; the daily budget still applies.
    expect((await decide(w, [root], fund)).outcome).toBe("allow");
    expect(codes(await decide(w, [root], { ...fund, attrs: { ...fund.attrs, spend: usdc(101) } }))).toEqual(["budget.exceeded"]);
    expect(codes(await decide(w, [root], { ...fund, attrs: { ...fund.attrs, asset: "OtherMint" } }))).toEqual(["constraint.failed"]);
  });

  it("an action type outside `actions` is denied", async () => {
    const w = world();
    const root = rootMandate(w);
    const refund: Action = { type: "settle/refund", profile: "settle/1", id: "r1", actor: ops, at: w.clock.iso(), attrs: { spend: "0", payment: "p1", counterparty: people.dana.did, task: "https://zk-toip.example/spec/settle/escrow/sign/0.1" } };
    const d = await decide(w, [root], refund);
    expect(d.outcome).toBe("deny");
    expect(d.reasons[0]).toMatchObject({ dimension: "actions", attr: "type", value: "settle/refund" });
  });

  it("checks every link, not only the leaf", async () => {
    const w = world();
    const root = rootMandate(w);
    const r = await delegate([root], people.ops, w.clock, {
      subject: people.errands.did,
      validUntil: inDays(w.clock, 3),
      status: w.opsStatus.allocate(),
      tighten: { spendPerTx: { attr: "spend", max: usdc(20), when: ["settle/pay"] } },
    });
    if (!("mandate" in r)) throw new Error("delegate failed");
    const chain = [root, r.mandate];
    const at25 = await decide(w, chain, payAction(w, people.errands.did, { spend: usdc(25) }));
    expect(at25.reasons.map((x) => [x.link, x.dimension])).toEqual([[1, "spendPerTx"]]);
    const at45 = await decide(w, chain, payAction(w, people.errands.did, { spend: usdc(45.5) }));
    expect(at45.reasons.map((x) => [x.link, x.dimension])).toEqual([
      [0, "spendPerTx"],
      [1, "spendPerTx"],
    ]);
    expect(at45.outcome).toBe("escalate");
    expect(at45.approver).toBe(people.conner.did);
    // Ops agent could approve the 25 (only its own link fails).
    expect(at25.approver).toBe(people.ops.did);
  });
});

describe("budgets (§8.6) with SpendLedger", () => {
  const H = 3_600_000;

  it("P1D is a rolling window: a spend 86,401 seconds ago doesn't count, one 86,399 seconds ago does", async () => {
    const w = world();
    const root = rootMandate(w, { constraints: { ...settleConstraints(), spendTotal: { attr: "spend", budget: usdc(1000), period: "total" } } });
    const ledger = new SpendLedger();
    ledger.reserve(root.id, "a1", usdc(90), w.clock.now());
    const state = () => ({ mandate: root.id, spent: ledger.spent(root.id, w.clock.now()) });
    w.clock.advance(H);
    expect((await decide(w, [root], payAction(w, ops, { spend: usdc(10) }), state())).outcome).toBe("allow");
    const over = await decide(w, [root], payAction(w, ops, { spend: String(Number(usdc(10)) + 1) }), state());
    expect(over.outcome).toBe("escalate");
    expect(over.reasons).toEqual([
      { code: "budget.exceeded", link: 0, dimension: "spendPerDay", op: "budget", attr: "spend", limit: usdc(100), value: "10000001", spent: usdc(90), period: "P1D", approvable: true },
    ]);
    w.clock.advance(86_399_000 - H);
    expect(ledger.spent(root.id, w.clock.now()).P1D).toBe(usdc(90));
    expect((await decide(w, [root], payAction(w, ops, { spend: usdc(20) }), state())).outcome).toBe("escalate");
    w.clock.advance(2000);
    expect(ledger.spent(root.id, w.clock.now()).P1D).toBe("0");
    expect(ledger.spent(root.id, w.clock.now()).total).toBe(usdc(90));
    expect((await decide(w, [root], payAction(w, ops, { spend: usdc(20) }), state())).outcome).toBe("allow");
  });

  it("total: over the total budget is denied when it isn't approvable", async () => {
    const w = world();
    const root = rootMandate(w);
    const ledger = new SpendLedger();
    for (let i = 0; i < 7; i++) {
      ledger.reserve(root.id, `a${i}`, usdc(28), w.clock.now());
      w.clock.advance(86_400_000 / 2);
    }
    const state = { mandate: root.id, spent: ledger.spent(root.id, w.clock.now()) };
    expect(state.spent.total).toBe(usdc(196));
    expect((await decide(w, [root], payAction(w, ops, { spend: usdc(4) }), state)).outcome).toBe("allow");
    const d = await decide(w, [root], payAction(w, ops, { spend: usdc(5) }), state);
    expect(d.outcome).toBe("deny");
    expect(d.reasons.map((r) => r.dimension)).toEqual(["spendTotal"]);
  });

  it("budgets are checked on the leaf only", async () => {
    const w = world();
    const chain = await twoLinks(w);
    // The leaf's own statement: 50 of its 60 spent. The root's 100 per day isn't evaluated for the leaf.
    const state = { mandate: chain[1].id, spent: { P1D: usdc(50), P7D: usdc(50), P30D: usdc(50), total: usdc(50) } };
    expect((await decide(w, chain, payAction(w, people.errands.did, { spend: usdc(10) }), state)).outcome).toBe("allow");
    const d = await decide(w, chain, payAction(w, people.errands.did, { spend: usdc(10.5) }), state);
    expect(d.reasons.map((r) => [r.link, r.dimension])).toEqual([[1, "spendTotal"]]);
  });

  it("no spend statement for the leaf denies when it has a budget", async () => {
    const w = world();
    const root = rootMandate(w);
    const d = await (await engine()).decide({ chain: [root], presenter: ops, action: payAction(w, ops), status: w.status(), clock: w.clock });
    expect(d.outcome).toBe("deny");
    expect(d.reasons.map((r) => r.attr).sort()).toEqual(["spent.P1D", "spent.total"]);
    const wrong = await decide(w, [root], payAction(w, ops), { mandate: "urn:uuid:other", spent: { P1D: "0", total: "0" } });
    expect(codes(wrong)).toEqual(["attr.missing"]);
  });

  it("SpendLedger: release, approvals used, tryReserve, save and restore", () => {
    const w = world();
    const root = rootMandate(w);
    const ledger = new SpendLedger();
    ledger.reserve(root.id, "a1", usdc(60), w.clock.now());
    expect(() => ledger.reserve(root.id, "a1", usdc(1), w.clock.now())).toThrow(/already/);
    expect(() => ledger.reserve(root.id, "a2", "-5", w.clock.now())).toThrow(/units/);
    ledger.reserve(root.id, "a2", usdc(10), w.clock.now());
    expect(ledger.spent(root.id, w.clock.now())).toEqual({ P1D: usdc(70), P7D: usdc(70), P30D: usdc(70), total: usdc(70) });
    ledger.release("a2");
    expect(ledger.spent(root.id, w.clock.now()).P1D).toBe(usdc(60));
    // tryReserve checks the mandate's budgets and reserves in one step, so two racing actions can't both fit.
    expect(ledger.tryReserve(root, "a3", usdc(40), w.clock.now())).toEqual([]);
    const second = ledger.tryReserve(root, "a4", usdc(1), w.clock.now());
    expect(second.map((r) => r.dimension)).toEqual(["spendPerDay"]);
    expect(ledger.spent(root.id, w.clock.now()).P1D).toBe(usdc(100));
    ledger.markApprovalUsed("ap1");
    const again = new SpendLedger(JSON.parse(JSON.stringify(ledger.save())));
    expect(again.approvalUsed("ap1")).toBe(true);
    expect(again.approvalUsed("ap2")).toBe(false);
    expect(again.spent(root.id, w.clock.now())).toEqual(ledger.spent(root.id, w.clock.now()));
    expect(ledger.spent("urn:uuid:none", w.clock.now()).total).toBe("0");
  });

  it("SpendLedger: a refund gives budget back (agents decision 4), in full or in part", () => {
    const w = world();
    const root = rootMandate(w);
    const ledger = new SpendLedger();
    ledger.reserve(root.id, "a1", usdc(60), w.clock.now());
    ledger.reserve(root.id, "a2", usdc(30), w.clock.now());
    ledger.refund("a1", usdc(20));
    expect(ledger.spent(root.id, w.clock.now()).total).toBe(usdc(70));
    expect(() => ledger.refund("a1", usdc(41))).toThrow(/more than/);
    ledger.refund("a1");
    expect(ledger.spent(root.id, w.clock.now())).toEqual({ P1D: usdc(30), P7D: usdc(30), P30D: usdc(30), total: usdc(30) });
    expect(() => ledger.refund("nope")).toThrow(/no reservation/);
    const again = new SpendLedger(ledger.save());
    expect(again.spent(root.id, w.clock.now()).total).toBe(usdc(30));
  });
});
