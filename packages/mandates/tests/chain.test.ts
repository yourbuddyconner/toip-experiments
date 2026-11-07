import { describe, expect, it } from "vitest";
import { issueMandate, mandateHash, type Mandate } from "../src/index";
import { codes, engine, forge, inDays, payAction, people, resign, rootMandate, twoLinks, world, zeroSpent, type World } from "./helpers";

async function decide(w: World, chain: Mandate[], o: { presenter?: string; action?: ReturnType<typeof payAction> } = {}) {
  const leaf = chain[chain.length - 1];
  const presenter = o.presenter ?? leaf.credentialSubject.id;
  return (await engine()).decide({
    chain,
    presenter,
    action: o.action ?? payAction(w, presenter),
    state: zeroSpent(leaf),
    status: w.status(),
    clock: w.clock,
  });
}

describe("chain structure (§8.2 steps 1–8)", () => {
  it("allows an action inside a valid two-link chain", async () => {
    const w = world();
    const chain = await twoLinks(w);
    const d = await decide(w, chain);
    expect(d.reasons).toEqual([]);
    expect(d.outcome).toBe("allow");
    expect(d.chain).toEqual(chain.map((m) => m.id));
    expect(d.parties[1]).toEqual({ issuer: people.ops.did, subject: people.errands.did });
    expect(d.policy.id).toBe("mandates/check/1");
    expect(d.policy.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("denies a tampered mandate: chain.signatureInvalid", async () => {
    const w = world();
    const [root, child] = await twoLinks(w);
    const tampered = structuredClone(child);
    (tampered.credentialSubject.constraints.spendPerTx as { max: string }).max = "999000000";
    const d = await decide(w, [root, tampered]);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("chain.signatureInvalid");
  });

  it("denies a link whose issuer isn't the parent's subject: chain.brokenLink", async () => {
    const w = world();
    const [root, child] = await twoLinks(w);
    const forged = resign(child, people.mallory, w.clock, (m) => (m.issuer = people.mallory.did));
    const d = await decide(w, [root, forged]);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("chain.brokenLink");
  });

  it("denies a wrong parent hash: chain.brokenLink", async () => {
    const w = world();
    const [root, child] = await twoLinks(w);
    const bad = resign(child, people.ops, w.clock, (m) => (m.credentialSubject.parent = { id: root.id, hash: "sha256:" + "0".repeat(64) }));
    const d = await decide(w, [root, bad]);
    expect(codes(d)).toContain("chain.brokenLink");
    expect(child.credentialSubject.parent).toEqual({ id: root.id, hash: mandateHash(root) });
  });

  it("denies a root that names a parent: chain.brokenLink", async () => {
    const w = world();
    const root = resign(rootMandate(w), people.conner, w.clock, (m) => (m.credentialSubject.parent = { id: "urn:uuid:x", hash: "sha256:00" }));
    expect(codes(await decide(w, [root]))).toContain("chain.brokenLink");
  });

  it("denies a presenter who isn't the leaf's subject: chain.notPresenter", async () => {
    const w = world();
    const chain = await twoLinks(w);
    const d = await decide(w, chain, { presenter: people.mallory.did });
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("chain.notPresenter");
  });

  it("denies a cycle: chain.cycle", async () => {
    const w = world();
    const root = rootMandate(w, { delegation: { maxDepth: 2 } });
    const back = resign(root, people.ops, w.clock, (m) => {
      m.id = "urn:uuid:back";
      m.issuer = people.ops.did;
      m.credentialSubject.id = people.conner.did;
      m.credentialSubject.parent = { id: root.id, hash: mandateHash(root) };
      m.credentialSubject.delegation = { maxDepth: 1 };
    });
    expect(codes(await decide(w, [root, back]))).toContain("chain.cycle");
    const self = resign(rootMandate(w), people.conner, w.clock, (m) => (m.credentialSubject.id = people.conner.did));
    expect(codes(await decide(w, [self]))).toContain("chain.cycle");
  });

  it("denies six links: chain.malformed", async () => {
    const w = world();
    const chain = [rootMandate(w, { delegation: { maxDepth: 4 } })];
    for (let i = 0; i < 5; i++) chain.push(chain[0]);
    const d = await decide(w, chain);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("chain.malformed");
  });

  it("denies an unknown operator: constraint.unknownOp", async () => {
    const w = world();
    const root = resign(rootMandate(w), people.conner, w.clock, (m) => {
      (m.credentialSubject.constraints as Record<string, unknown>).weird = { attr: "spend", near: "5" };
    });
    const d = await decide(w, [root]);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("constraint.unknownOp");
  });

  it("denies a constraint with two operators, or a bad value: chain.malformed", async () => {
    const w = world();
    for (const bad of [
      { attr: "spend", max: "5", min: "1" },
      { attr: "spend", max: "9007199254740992" },
      { attr: "spend", max: "1.5" },
      { attr: "spend", budget: "5", period: "P2D" },
      { attr: "category", within: ["soft*"] },
      { attr: "category", anyOf: "x" },
      { attr: "category", anyOf: ["a"], when: [] },
    ]) {
      const root = resign(rootMandate(w), people.conner, w.clock, (m) => {
        (m.credentialSubject.constraints as Record<string, unknown>).bad = bad;
      });
      const d = await decide(w, [root]);
      expect(codes(d), JSON.stringify(bad)).toContain("chain.malformed");
    }
  });

  it("denies a missing validUntil or credentialStatus: chain.malformed", async () => {
    const w = world();
    const subject = structuredClone(rootMandate(w).credentialSubject);
    const status = w.connerStatus.allocate();
    const noExpiry = forge(people.conner, w.clock, subject, { status });
    const noStatus = forge(people.conner, w.clock, subject, { validUntil: inDays(w.clock, 1) });
    expect(codes(await decide(w, [noExpiry]))).toContain("chain.malformed");
    expect(codes(await decide(w, [noStatus]))).toContain("chain.malformed");
  });

  it("denies a credential that isn't a Mandate, or a wrong mandateVersion: chain.malformed", async () => {
    const w = world();
    const subject = structuredClone(rootMandate(w).credentialSubject);
    const o = { validUntil: inDays(w.clock, 1), status: w.connerStatus.allocate() };
    expect(codes(await decide(w, [forge(people.conner, w.clock, subject, { ...o, type: ["VerifiableCredential", "Passport"] })]))).toContain("chain.malformed");
    expect(codes(await decide(w, [forge(people.conner, w.clock, { ...subject, mandateVersion: 2 }, o)]))).toContain("chain.malformed");
    expect(codes(await decide(w, [forge(people.conner, w.clock, { ...subject, profile: "nope/1" }, o)]))).toContain("chain.malformed");
  });

  it("denies a root without an actions dimension or a budget (settle/1): chain.malformed", async () => {
    const w = world();
    const subject = structuredClone(rootMandate(w).credentialSubject);
    const o = { validUntil: inDays(w.clock, 1), status: w.connerStatus.allocate() };
    const noActions = structuredClone(subject);
    delete noActions.constraints.actions;
    const noBudget = structuredClone(subject);
    delete noBudget.constraints.spendPerDay;
    delete noBudget.constraints.spendTotal;
    expect(codes(await decide(w, [forge(people.conner, w.clock, noActions, o)]))).toContain("chain.malformed");
    expect(codes(await decide(w, [forge(people.conner, w.clock, noBudget, o)]))).toContain("chain.malformed");
  });

  it("refuses to issue a malformed root", () => {
    const w = world();
    expect(() =>
      issueMandate(people.conner, w.clock, {
        subject: people.ops.did,
        validUntil: inDays(w.clock, 1),
        status: w.connerStatus.allocate(),
        profile: "settle/1",
        constraints: { actions: { attr: "type", anyOf: ["settle/pay"] } },
        delegation: { maxDepth: 0 },
        revocation: { maxAgeSeconds: 3600 },
      }),
    ).toThrow(/budget/);
  });

  it("denies a profile mismatch: chain.profileMismatch", async () => {
    const w = world();
    const chain = await twoLinks(w);
    const action = { ...payAction(w, people.errands.did), profile: "capture/1" };
    expect(codes(await decide(w, chain, { action }))).toContain("chain.profileMismatch");
  });

  it("denies an action type the profile doesn't define, or one missing a required attribute: action.malformed", async () => {
    const w = world();
    const chain = await twoLinks(w);
    const unknown = { ...payAction(w, people.errands.did), type: "settle/teleport" };
    expect(codes(await decide(w, chain, { action: unknown }))).toContain("action.malformed");
    const a = payAction(w, people.errands.did);
    delete (a.attrs as Record<string, unknown>).counterparty;
    expect(codes(await decide(w, chain, { action: a }))).toContain("action.malformed");
    const big = payAction(w, people.errands.did, { spend: "9007199254740992" });
    expect(codes(await decide(w, chain, { action: big }))).toContain("action.malformed");
    const otherActor = payAction(w, people.mallory.did);
    expect(codes(await decide(w, chain, { action: otherActor }))).toContain("action.malformed");
  });

  it("denies an expired chain and one not yet valid", async () => {
    const w = world();
    const chain = await twoLinks(w);
    w.clock.advance(3 * 86_400_000);
    const d = await decide(w, chain);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("chain.expired");
    expect(d.reasons.find((r) => r.code === "chain.expired")?.link).toBe(1);

    const w2 = world();
    w2.clock.advance(10 * 60_000);
    const future = rootMandate(w2);
    w2.clock.advance(-10 * 60_000);
    expect(codes(await decide(w2, [future]))).toContain("chain.notYetValid");
    w2.clock.advance(6 * 60_000);
    expect(codes(await decide(w2, [future]))).not.toContain("chain.notYetValid");
  });
});
