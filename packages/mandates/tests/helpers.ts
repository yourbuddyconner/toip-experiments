import { DemoClock, identityFromSeed, issueCredential, seedFrom, signDocument, type Clock, type Identity } from "@toip-tools/trust-core";
import {
  MandateEngine,
  StatusRegistry,
  delegate,
  issueMandate,
  staticStatusResolver,
  type Action,
  type Constraint,
  type Mandate,
  type MandateSubject,
} from "../src/index";

export const START = "2026-11-06T10:00:00Z";
export const MINT = "TestUsdcMint1111111111111111111111111111111";

export const id = (label: string): Identity => identityFromSeed(seedFrom(`mandates-test/${label}`));

export const people = {
  conner: id("conner"),
  ops: id("ops"),
  errands: id("errands"),
  dana: id("dana"),
  ci: id("ci"),
  arbiter: id("arbiter"),
  verify: id("settle-verify"),
  mallory: id("mallory"),
};

export const names: Record<string, string> = {
  [people.conner.did]: "Conner Swann",
  [people.ops.did]: "Ops agent",
  [people.errands.did]: "Errands agent",
  [people.dana.did]: "Dana",
};

export const usdc = (n: number) => String(Math.round(n * 1_000_000));
export const inDays = (clock: DemoClock, days: number) => new Date(clock.now() + days * 86_400_000).toISOString();

let enginePromise: Promise<MandateEngine> | null = null;
export const engine = () => (enginePromise ??= MandateEngine.load());

/** The demo mandate of the design, §7.1. */
export function settleConstraints(): Record<string, Constraint> {
  return {
    actions: { attr: "type", anyOf: ["settle/pay", "settle/attest", "settle/dispute", "agents/job/offer", "mandates/delegate"] },
    asset: { attr: "asset", anyOf: [MINT], when: ["settle/pay", "mandates/delegate"] },
    spendPerTx: { attr: "spend", max: usdc(30), when: ["settle/pay"] },
    spendPerDay: { attr: "spend", budget: usdc(100), period: "P1D" },
    spendTotal: { attr: "spend", budget: usdc(200), period: "total" },
    categories: { attr: "category", within: ["software.*", "physical.errand"], when: ["settle/pay", "agents/job/offer"] },
    attesters: { attr: "attester", anyOf: [people.ci.did, people.conner.did], when: ["settle/pay"] },
    arbiters: { attr: "arbiter", anyOf: [people.arbiter.did], when: ["settle/pay"] },
    minWindow: { attr: "disputeWindowSeconds", min: 0, when: ["settle/pay"] },
    tasks: { attr: "task", within: ["https://toip.tools/spec/settle/*", "https://toip.tools/spec/agents/*", "https://toip.tools/spec/mandates/*"] },
  };
}

export interface World {
  clock: DemoClock;
  connerStatus: StatusRegistry;
  opsStatus: StatusRegistry;
  errandsStatus: StatusRegistry;
  /** Freshly signed lists from every registry. */
  status: () => ReturnType<typeof staticStatusResolver>;
}

export function world(): World {
  const clock = new DemoClock(START);
  const connerStatus = new StatusRegistry(people.conner, clock);
  const opsStatus = new StatusRegistry(people.ops, clock);
  const errandsStatus = new StatusRegistry(people.errands, clock);
  return {
    clock,
    connerStatus,
    opsStatus,
    errandsStatus,
    status: () => staticStatusResolver([connerStatus.sign(), opsStatus.sign(), errandsStatus.sign()]),
  };
}

export function rootMandate(w: World, o: Partial<Omit<MandateSubject, "id" | "mandateVersion" | "parent">> & { subject?: string; validUntil?: string } = {}): Mandate {
  return issueMandate(people.conner, w.clock, {
    subject: o.subject ?? people.ops.did,
    validUntil: o.validUntil ?? inDays(w.clock, 7),
    status: w.connerStatus.allocate(),
    profile: o.profile ?? "settle/1",
    purpose: o.purpose ?? "Keep the demo repo green and run small errands for me.",
    constraints: o.constraints ?? settleConstraints(),
    delegation: o.delegation ?? { maxDepth: 1 },
    escalation: "escalation" in o ? o.escalation : { approvable: ["spendPerTx", "spendPerDay", "categories"], approvalTtlSeconds: 3600 },
    revocation: o.revocation ?? { maxAgeSeconds: 3600 },
  });
}

/** Root (Conner → Ops) and a child (Ops → Errands) with the same limits but a 60 USDC total. */
export async function twoLinks(w: World): Promise<Mandate[]> {
  const root = rootMandate(w);
  const r = await delegate([root], people.ops, w.clock, {
    subject: people.errands.did,
    validUntil: inDays(w.clock, 3),
    status: w.opsStatus.allocate(),
    tighten: { spendTotal: { attr: "spend", budget: usdc(60), period: "total" } },
    maxDepth: 0,
  });
  if (!("mandate" in r)) throw new Error(JSON.stringify(r.problems));
  return [root, r.mandate];
}

let n = 0;
export function payAction(w: World, actor: string, attrs: Partial<Action["attrs"]> = {}): Action {
  return {
    type: "settle/pay",
    profile: "settle/1",
    id: `act-${++n}`,
    actor,
    at: w.clock.iso(),
    attrs: {
      spend: usdc(20.5),
      asset: MINT,
      price: usdc(20),
      counterparty: people.dana.did,
      counterpartyCredentials: [`VerifiedBusiness@${people.verify.did}`],
      category: "physical.errand",
      attester: people.conner.did,
      arbiter: people.arbiter.did,
      disputeWindowSeconds: 0,
      link: "sha256:00",
      job: "job-1",
      task: "https://toip.tools/spec/settle/checkout/start/0.1",
      purpose: "Pick up a parcel at the post office on Main St",
      ...attrs,
    } as Action["attrs"],
  };
}

export const zeroSpent = (mandate: Mandate) => ({ mandate: mandate.id, spent: { P1D: "0", P7D: "0", P30D: "0", total: "0" } });

/** Signs any mandate-shaped credential, so tests can build chains that issueMandate and delegate would refuse. */
export function forge(issuer: Identity, clock: Clock, subject: Record<string, unknown>, o: { validUntil?: string; status?: unknown; type?: string[] } = {}): Mandate {
  return issueCredential(issuer, clock, {
    type: o.type ?? ["VerifiableCredential", "Mandate"],
    credentialSubject: subject as Mandate["credentialSubject"],
    ...(o.validUntil !== undefined ? { validUntil: o.validUntil } : {}),
    ...(o.status !== undefined ? { credentialStatus: o.status as Mandate["credentialStatus"] } : {}),
  }) as Mandate;
}

/** Edits a signed mandate and signs it again as `issuer`. */
export function resign(m: Mandate, issuer: Identity, clock: Clock, edit: (m: Mandate) => void): Mandate {
  const copy = structuredClone(m);
  delete copy.proof;
  edit(copy);
  return signDocument(copy, issuer, clock);
}

export const codes = (d: { reasons: { code: string }[] }) => [...new Set(d.reasons.map((r) => r.code))].sort();
