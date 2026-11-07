import { describe, expect, it } from "vitest";
import { issueCredential, type Credential } from "@toip-tools/trust-core";
import { actionHash, approve, present, staticStatusResolver, type Presentation, type Requirements } from "../src/index";
import { codes, engine, inDays, payAction, people, twoLinks, usdc, world, zeroSpent, type World } from "./helpers";

async function setup(o: { spend?: string } = {}) {
  const w = world();
  const chain = await twoLinks(w);
  const action = payAction(w, people.errands.did, { spend: o.spend ?? usdc(20.5) });
  const p = present(people.errands, w.clock, {
    audience: people.dana.did,
    action,
    actionHash: actionHash(action),
    chain,
    approvals: [],
    spend: zeroSpent(chain[1]),
  });
  return { w, chain, action, p };
}

async function verify(w: World, p: Presentation, o: { sender?: string; me?: string; requirements?: Requirements; status?: ReturnType<World["status"]> } = {}) {
  return (await engine()).verifyPresentation(p, {
    sender: o.sender ?? people.errands.did,
    me: o.me ?? people.dana.did,
    status: o.status ?? w.status(),
    clock: w.clock,
    ...(o.requirements ? { requirements: o.requirements } : {}),
  });
}

function verifiedBusiness(w: World, subject: string, issuer = people.verify): Credential {
  return issueCredential(issuer, w.clock, { type: ["VerifiableCredential", "VerifiedBusiness"], credentialSubject: { id: subject, name: "Conner Swann" }, validUntil: inDays(w.clock, 30) });
}

describe("presentations (§8.7)", () => {
  it("a valid presentation verifies to allow", async () => {
    const { w, p } = await setup();
    expect(p).toMatchObject({ type: "mandates/presentation", issuer: people.errands.did, audience: people.dana.did });
    expect(p.proof).toBeDefined();
    const d = await verify(w, p);
    expect(d.reasons).toEqual([]);
    expect(d.outcome).toBe("allow");
  });

  it("a presentation by someone other than the holder fails: chain.notPresenter", async () => {
    const { w, chain, action } = await setup();
    const stolen = present(people.mallory, w.clock, { audience: people.dana.did, action, actionHash: actionHash(action), chain, approvals: [], spend: zeroSpent(chain[1]) });
    const d = await verify(w, stolen, { sender: people.mallory.did });
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("chain.notPresenter");
  });

  it("a presentation forwarded by another sender fails: chain.notPresenter", async () => {
    const { w, p } = await setup();
    const d = await verify(w, p, { sender: people.mallory.did });
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("chain.notPresenter");
  });

  it("a tampered presentation fails: presentation.invalid", async () => {
    const { w, p } = await setup();
    const tampered = structuredClone(p);
    tampered.at = new Date(w.clock.now() + 1000).toISOString();
    expect(codes(await verify(w, tampered))).toContain("presentation.invalid");
    const hashMismatch = present(people.errands, w.clock, { ...p, actionHash: "sha256:" + "1".repeat(64) });
    expect(codes(await verify(w, hashMismatch))).toContain("presentation.invalid");
  });

  it("a presentation for another counterparty fails: presentation.wrongAudience", async () => {
    const { w, p } = await setup();
    const d = await verify(w, p, { me: people.ci.did });
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toEqual(["presentation.wrongAudience"]);
  });

  it("uses the presenter's spend statement as the budget state", async () => {
    const { w, chain, action } = await setup({ spend: usdc(20) });
    const p = present(people.errands, w.clock, { audience: people.dana.did, action, actionHash: actionHash(action), chain, approvals: [], spend: { mandate: chain[1].id, spent: { P1D: usdc(45), total: usdc(45) } } });
    const d = await verify(w, p);
    expect(d.outcome).toBe("deny");
    expect(d.reasons.map((r) => [r.code, r.dimension])).toEqual([["budget.exceeded", "spendTotal"]]);
  });

  it("carries approvals: an escalated payment verifies with the principal's approval", async () => {
    const { w, chain } = await setup();
    const action = payAction(w, people.errands.did, { spend: usdc(45.5) });
    const base = { audience: people.dana.did, action, actionHash: actionHash(action), chain, spend: zeroSpent(chain[1]) };
    expect((await verify(w, present(people.errands, w.clock, { ...base, approvals: [] }))).outcome).toBe("escalate");
    const ap = approve(people.conner, w.clock, { chain, action, ttlSeconds: 600 });
    expect((await verify(w, present(people.errands, w.clock, { ...base, approvals: [ap] }))).outcome).toBe("allow");
  });

  it("uses status-list hints, but a newer list from the verifier's resolver wins", async () => {
    const { w, chain, action } = await setup();
    const hints = [w.connerStatus.sign(), w.opsStatus.sign()];
    const p = present(people.errands, w.clock, { audience: people.dana.did, action, actionHash: actionHash(action), chain, approvals: [], spend: zeroSpent(chain[1]), statusLists: hints });
    expect((await verify(w, p, { status: staticStatusResolver([]) })).outcome).toBe("allow");
    w.clock.advance(1000);
    w.opsStatus.revoke(chain[1].credentialStatus);
    const d = await verify(w, p, { status: staticStatusResolver([w.opsStatus.sign()]) });
    expect(codes(d)).toEqual(["status.revoked"]);
  });

  it("applies the verifier's requirements: root credentials, passport, maxLinks", async () => {
    const { w, chain, action } = await setup();
    const rootMustHold = [`VerifiedBusiness@${people.verify.did}`];
    const passport = issueCredential(people.conner, w.clock, { type: ["VerifiableCredential", "AgentPassport"], credentialSubject: { id: people.errands.did, name: "Errands agent" }, validUntil: inDays(w.clock, 30) });
    const make = (extra: Partial<Presentation>) =>
      present(people.errands, w.clock, { audience: people.dana.did, action, actionHash: actionHash(action), chain, approvals: [], spend: zeroSpent(chain[1]), ...extra });

    const none = await verify(w, make({}), { requirements: { rootMustHold, passport: "required" } });
    expect(none.outcome).toBe("deny");
    expect(none.reasons.map((r) => r.requirement).sort()).toEqual(["passport", "rootMustHold"]);

    const full = await verify(w, make({ rootCredentials: [verifiedBusiness(w, people.conner.did)], passport }), { requirements: { rootMustHold, passport: "required", passportIssuerMustBeRoot: true } });
    expect(full.reasons).toEqual([]);
    expect(full.outcome).toBe("allow");

    // A credential about someone else, or from another issuer, doesn't count.
    const wrongSubject = await verify(w, make({ rootCredentials: [verifiedBusiness(w, people.ops.did)] }), { requirements: { rootMustHold } });
    expect(wrongSubject.reasons.map((r) => r.requirement)).toEqual(["rootMustHold"]);
    const wrongIssuer = await verify(w, make({ rootCredentials: [verifiedBusiness(w, people.conner.did, people.mallory)] }), { requirements: { rootMustHold } });
    expect(wrongIssuer.reasons.map((r) => r.requirement)).toEqual(["rootMustHold"]);

    const operatorPassport = issueCredential(people.ops, w.clock, { type: ["VerifiableCredential", "AgentPassport"], credentialSubject: { id: people.errands.did }, validUntil: inDays(w.clock, 30) });
    const notRoot = await verify(w, make({ passport: operatorPassport }), { requirements: { passport: "required", passportIssuerMustBeRoot: true } });
    expect(notRoot.reasons.map((r) => r.requirement)).toEqual(["passportIssuerMustBeRoot"]);

    const tooLong = await verify(w, make({}), { requirements: { maxLinks: 1 } });
    expect(tooLong.reasons.map((r) => [r.code, r.requirement])).toEqual([["requirement.failed", "maxLinks"]]);
  });
});
