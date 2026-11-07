/**
 * Counterparties check too (design §11.3, C2): a rogue hirer that skips its guard and talks to Settle directly
 * is refused by an honest worker's gates.
 */
import { describe, expect, it } from "vitest";
import { defaultEngine, issueMandate, jcsHash, mandateHash, present, StatusRegistry, type Action, type Mandate } from "@zk-toip/mandates";
import { DemoClock, signDocument } from "@zk-toip/trust-core";
import { mandateGates } from "../src/guard/gates";
import { taskUri, USDC } from "../src/config";
import { issuePassport } from "../src/passport";
import { FakeHub, MINT, NAMES, makeLink, people, rootConstraints, verified } from "./helpers";
import type { Terms } from "@zk-toip/settle/src/protocol/documents";

const fee = (p: bigint) => (p / 100n < 500_000n ? 500_000n : p / 100n);

async function setup() {
  const clock = new DemoClock(new Date().toISOString());
  const engine = await defaultEngine();
  const hub = new FakeHub();
  const reg = new StatusRegistry(people.conner, clock);
  const opsReg = new StatusRegistry(people.ops, clock);
  const root = issueMandate(people.conner, clock, {
    subject: people.ops.did,
    validUntil: new Date(clock.now() + 7 * 86_400_000).toISOString(),
    status: reg.allocate(),
    profile: "settle/1",
    constraints: rootConstraints(),
    delegation: { maxDepth: 1 },
    escalation: { approvable: ["spendPerTx"], approvalTtlSeconds: 3600 },
    revocation: { maxAgeSeconds: 3600 },
  });
  const publish = async () => {
    await hub.putStatus(reg.sign());
    await hub.putStatus(opsReg.sign());
  };
  await publish();
  const refused: string[][] = [];
  const gates = mandateGates({
    me: people.coder,
    engine,
    status: hub.resolver(),
    requirements: { passport: "required", rootMustHold: [`VerifiedBusiness@${people.verify.did}`] },
    clock,
    mint: MINT,
    arbiter: people.arbiter.did,
    feeFor: fee,
    name: (d) => NAMES[d] ?? d,
    onRefused: (r) => refused.push(r.reasons),
  });
  const passportFor = (who = people.ops) =>
    issuePassport(people.conner, clock, {
      agent: who.did,
      name: NAMES[who.did],
      description: "",
      operator: { id: people.conner.did, name: "Conner Swann" },
      accountable: { id: people.conner.did, name: "Conner Swann" },
      runtime: { kind: "llm-agent", provider: "scripted", model: "scripted:x", toolsHash: "sha256:x" },
      endpoints: [],
      audit: { aid: "E", trail: "E", witnesses: [] },
    });
  const link = makeLink(people.coder, { units: USDC(20), attester: people.ci.did, clock });
  const action = (l = link, actor = people.ops.did): Action => ({
    type: "settle/pay",
    profile: "settle/1",
    id: `act-${crypto.randomUUID()}`,
    actor,
    at: clock.iso(),
    attrs: {
      spend: String(BigInt(l.units) + fee(BigInt(l.units))),
      asset: MINT,
      price: l.units,
      counterparty: l.issuer,
      counterpartyCredentials: [],
      category: "software.tests",
      attester: l.attester!,
      arbiter: people.arbiter.did,
      disputeWindowSeconds: 0,
      link: jcsHash(l),
      job: "job-1",
      task: taskUri("settle/checkout/start"),
      purpose: l.title,
    },
  });
  const rootCreds = [verified(people.conner, "Conner Swann", "", clock)];
  const presentation = (o: { chain?: Mandate[]; a?: Action; audience?: string; who?: typeof people.ops } = {}) => {
    const who = o.who ?? people.ops;
    const a = o.a ?? action(link, who.did);
    const chain = o.chain ?? [root];
    return present(who, clock, { audience: o.audience ?? people.coder.did, action: a, actionHash: jcsHash(a), chain, approvals: [], passport: passportFor(who), rootCredentials: rootCreds, spend: { mandate: chain[chain.length - 1].id, spent: { P1D: "0", P7D: "0", P30D: "0", total: "0" } } });
  };
  const invoice = (p: unknown, sender = people.ops.did, l = link, checkout = "c-1") => gates.beforeInvoice({ link: l, sender, attachments: p === undefined ? undefined : { presentation: p }, checkout });
  return { clock, engine, hub, reg, opsReg, root, publish, gates, refused, link, action, presentation, invoice, passportFor };
}

const terms = (o: Partial<{ payer: string; units: string; fee: string; attester: string; window: number; arbiter: string; mint: string }> = {}) =>
  ({
    payer: { did: o.payer ?? people.ops.did },
    amount: { units: o.units ?? USDC(20).toString(), mint: o.mint ?? MINT },
    fee: { units: o.fee ?? "500000" },
    conditions: { attester: o.attester ?? people.ci.did, disputeWindowSeconds: o.window ?? 0 },
    arbiter: { did: o.arbiter ?? people.arbiter.did },
  }) as unknown as Terms;

describe("a worker's gates against a rogue hirer", () => {
  it("a valid presentation is allowed, and matching terms are accepted", async () => {
    const s = await setup();
    expect(await s.invoice(s.presentation())).toBeNull();
    expect(await s.gates.beforeAccept({ terms: terms(), sender: people.ops.did, checkout: "c-1" })).toEqual([]);
  });

  it("no presentation: no invoice, and the hirer is told why", async () => {
    const s = await setup();
    expect(await s.invoice(undefined)).toMatch(/No mandate presentation/);
    expect(s.refused[0][0]).toMatch(/No mandate presentation/);
  });

  it("a widened chain is refused", async () => {
    const s = await setup();
    const c = structuredClone(s.root.credentialSubject);
    const child = signDocument(
      {
        ...structuredClone(s.root),
        id: `urn:uuid:${crypto.randomUUID()}`,
        issuer: people.ops.did,
        proof: undefined,
        credentialSubject: { ...c, id: people.errands.did, parent: { id: s.root.id, hash: mandateHash(s.root) }, delegation: { maxDepth: 0 }, constraints: { ...c.constraints, spendPerTx: { attr: "spend", max: USDC(1000).toString(), when: ["settle/pay"] } } },
        credentialStatus: s.opsReg.allocate(),
      } as Mandate,
      people.ops,
      s.clock,
    );
    await s.publish();
    const r = await s.invoice(s.presentation({ chain: [s.root, child], who: people.errands }), people.errands.did);
    expect(r).toMatch(/widens/);
  });

  it("a forged mandate is refused", async () => {
    const s = await setup();
    const forged = structuredClone(s.root);
    (forged.credentialSubject.constraints.spendPerTx as { max: string }).max = USDC(1000).toString();
    expect(await s.invoice(s.presentation({ chain: [forged] }))).toMatch(/signature that doesn't verify/);
  });

  it("a revoked mandate is refused, and so is a stale status list", async () => {
    const s = await setup();
    s.reg.revoke(s.root.credentialStatus);
    await s.publish();
    expect(await s.invoice(s.presentation())).toMatch(/revoked/);
    const t = await setup();
    t.clock.advance(2 * 3600_000);
    expect(await t.invoice(t.presentation())).toMatch(/too old/);
  });

  it("a presentation for another worker, or another link, is refused", async () => {
    const s = await setup();
    expect(await s.invoice(s.presentation({ audience: people.dana.did }))).toMatch(/meant for someone else/);
    const other = makeLink(people.coder, { units: USDC(20), attester: people.ci.did, clock: s.clock });
    expect(await s.invoice(s.presentation({ a: s.action(other) }))).toMatch(/another payment link/);
    // A presentation sent by someone other than its issuer.
    expect(await s.invoice(s.presentation(), people.quickfix.did)).toBeTruthy();
  });

  it("a valid presentation, then terms that don't match it: the terms are refused", async () => {
    const s = await setup();
    expect(await s.invoice(s.presentation())).toBeNull();
    const accept = (t: Terms) => s.gates.beforeAccept({ terms: t, sender: people.ops.did, checkout: "c-1" });
    expect(await accept(terms({ attester: people.ops.did }))).toContain("the attester isn't the presented one");
    expect(await accept(terms({ window: 7 * 86400 }))).toContain("the dispute window isn't the presented one");
    expect(await accept(terms({ units: USDC(25).toString() }))).toContain("the price isn't the presented one");
    expect(await accept(terms({ payer: people.quickfix.did }))).toContain("the payer isn't the agent that presented");
    // Terms for a checkout nobody presented for.
    expect(await s.gates.beforeAccept({ terms: terms(), sender: people.ops.did, checkout: "c-2" })).toEqual(["no checked mandate presentation for these terms"]);
  });
});
