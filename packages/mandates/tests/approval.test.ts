import { describe, expect, it } from "vitest";
import { SpendLedger, actionHash, approve, verifyApproval, type Action, type Approval, type Mandate } from "../src/index";
import { MINT, codes, engine, payAction, people, resign, twoLinks, usdc, world, zeroSpent, type World } from "./helpers";

async function decide(w: World, chain: Mandate[], action: Action, approvals: Approval[], usedApprovals?: (id: string) => boolean) {
  const leaf = chain[chain.length - 1];
  return (await engine()).decide({
    chain,
    presenter: leaf.credentialSubject.id,
    action,
    approvals,
    ...(usedApprovals ? { usedApprovals } : {}),
    state: zeroSpent(leaf),
    status: w.status(),
    clock: w.clock,
  });
}

async function setup() {
  const w = world();
  const chain = await twoLinks(w);
  const action = payAction(w, people.errands.did, { spend: usdc(45.5), price: usdc(45) });
  return { w, chain, action };
}

describe("approvals (§9)", () => {
  it("a valid approval turns escalate into allow", async () => {
    const { w, chain, action } = await setup();
    const before = await decide(w, chain, action, []);
    expect(before.outcome).toBe("escalate");
    expect(before.approver).toBe(people.conner.did);
    const ap = approve(people.conner, w.clock, { chain, action, ttlSeconds: 3600 });
    expect(ap).toMatchObject({ type: "mandates/approval", version: 1, issuer: people.conner.did, subject: people.errands.did, actionHash: actionHash(action), uses: 1 });
    expect(ap.chain).toEqual(chain.map((m) => m.id));
    expect(await verifyApproval(ap, { chain, action, clock: w.clock })).toEqual([]);
    const after = await decide(w, chain, action, [ap]);
    expect(after.reasons).toEqual([]);
    expect(after.outcome).toBe("allow");
  });

  it("binds to the exact action: a different amount or counterparty is approval.wrongAction", async () => {
    const { w, chain, action } = await setup();
    const ap = approve(people.conner, w.clock, { chain, action, ttlSeconds: 3600 });
    for (const other of [
      { ...action, attrs: { ...action.attrs, spend: usdc(45.6) } },
      { ...action, attrs: { ...action.attrs, counterparty: people.mallory.did } },
      { ...action, id: "act-other" },
    ]) {
      const d = await decide(w, chain, other, [ap]);
      expect(d.outcome).toBe("deny");
      expect(codes(d)).toEqual(["approval.wrongAction", "constraint.failed"]);
    }
  });

  it("expired: approval.expired", async () => {
    const { w, chain, action } = await setup();
    const ap = approve(people.conner, w.clock, { chain, action, ttlSeconds: 600 });
    w.clock.advance(601_000);
    const d = await decide(w, chain, action, [ap]);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toEqual(["approval.expired", "constraint.failed"]);
  });

  it("used: approval.used, with SpendLedger recording single use", async () => {
    const { w, chain, action } = await setup();
    const ap = approve(people.conner, w.clock, { chain, action, ttlSeconds: 600 });
    const ledger = new SpendLedger();
    expect((await decide(w, chain, action, [ap], (id) => ledger.approvalUsed(id))).outcome).toBe("allow");
    ledger.markApprovalUsed(ap.id);
    const d = await decide(w, chain, action, [ap], (id) => ledger.approvalUsed(id));
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("approval.used");
  });

  it("signed by someone outside the chain: approval.notInChain", async () => {
    const { w, chain, action } = await setup();
    const ap = approve(people.mallory, w.clock, { chain, action, ttlSeconds: 600 });
    const d = await decide(w, chain, action, [ap]);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("approval.notInChain");
  });

  it("longer than approvalTtlSeconds, tampered, or for another subject or chain: approval.invalid", async () => {
    const { w, chain, action } = await setup();
    const long = approve(people.conner, w.clock, { chain, action, ttlSeconds: 3601 });
    expect(codes(await decide(w, chain, action, [long]))).toContain("approval.invalid");

    const ap = approve(people.conner, w.clock, { chain, action, ttlSeconds: 600 });
    const tampered = { ...ap, validUntil: new Date(w.clock.now() + 500_000).toISOString() };
    expect(codes(await decide(w, chain, action, [tampered]))).toContain("approval.invalid");

    const wrongSubject = approve(people.conner, w.clock, { chain, action, ttlSeconds: 600 });
    const resigned = resign(wrongSubject as never, people.conner, w.clock, (a) => ((a as unknown as Approval).subject = people.ops.did)) as unknown as Approval;
    expect(codes(await decide(w, chain, action, [resigned]))).toContain("approval.invalid");

    const otherChain = resign(ap as never, people.conner, w.clock, (a) => ((a as unknown as Approval).chain = [chain[0].id])) as unknown as Approval;
    expect(codes(await decide(w, chain, action, [otherChain]))).toContain("approval.notInChain");
  });

  it("never clears a constraint failure on a dimension that isn't approvable", async () => {
    const { w, chain } = await setup();
    const action = payAction(w, people.errands.did, { asset: "OtherMint", spend: usdc(45.5) });
    const ap = approve(people.conner, w.clock, { chain, action, ttlSeconds: 600 });
    const d = await decide(w, chain, action, [ap]);
    expect(d.outcome).toBe("deny");
    expect(d.reasons.filter((r) => !r.approvable).map((r) => r.dimension)).toEqual(["asset", "asset"]);
    expect(d.reasons.some((r) => r.dimension === "spendPerTx")).toBe(false);
    expect(MINT).not.toBe("OtherMint");
  });

  it("never clears status.revoked or a narrowing failure", async () => {
    const { w, chain, action } = await setup();
    const ap = approve(people.conner, w.clock, { chain, action, ttlSeconds: 600 });
    w.opsStatus.revoke(chain[1].credentialStatus);
    const revoked = await decide(w, chain, action, [ap]);
    expect(revoked.outcome).toBe("deny");
    expect(codes(revoked)).toEqual(["status.revoked"]);

    const w2 = world();
    const [root, leaf] = await twoLinks(w2);
    const wide = resign(leaf, people.ops, w2.clock, (m) => (m.credentialSubject.constraints.spendPerTx = { attr: "spend", max: usdc(100), when: ["settle/pay"] }));
    const a2 = payAction(w2, people.errands.did, { spend: usdc(45.5) });
    const ap2 = approve(people.conner, w2.clock, { chain: [root, wide], action: a2, ttlSeconds: 600 });
    const d = await decide(w2, [root, wide], a2, [ap2]);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toEqual(["narrowing.widened"]);
  });

  it("an approval by the issuer of link 1 doesn't clear a failure at link 0", async () => {
    const { w, chain, action } = await setup();
    const byOps = approve(people.ops, w.clock, { chain, action, ttlSeconds: 600 });
    expect(await verifyApproval(byOps, { chain, action, clock: w.clock })).toEqual([]);
    const d = await decide(w, chain, action, [byOps]);
    expect(d.reasons.map((r) => [r.link, r.dimension])).toEqual([[0, "spendPerTx"]]);
    expect(d.outcome).toBe("escalate");
    expect(d.approver).toBe(people.conner.did);
  });
});
