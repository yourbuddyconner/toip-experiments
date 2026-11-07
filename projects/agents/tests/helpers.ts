/** Test fixtures: a Settle party spy, a fake TSP endpoint and hub, local witnesses, and a guard built on them. */
import { ed25519Signer, localWitnessClient, MemoryStore, Witness, type WitnessClient } from "@zk-toip/eventlog";
import { defaultEngine, issueMandate, StatusRegistry, type Constraint, type Mandate, type MandateEngine, type StatusResolver } from "@zk-toip/mandates";
import { DemoClock, identityFromSeed, issueCredential, seedFrom, signDocument, type Clock, type Credential, type Identity, type StatusListDoc } from "@zk-toip/trust-core";
import type { Checkout, PaymentLink } from "@zk-toip/settle/src/agents/party";
import type { PaymentState } from "@zk-toip/settle/src/agents/base";
import { createAgentTrail, type EventlogSink } from "../src/audit/sink";
import { Guard, type GuardOptions, type SettlePort } from "../src/guard/guard";
import { signProfile, type HubPort, type WorkerProfile } from "../src/hub/client";
import { issuePassport } from "../src/passport";
import { JOB_QUOTE } from "../src/protocol/tasks";
import { USDC } from "../src/config";
import type { GuardApi } from "../src/guard/api";

export const MINT = "TestUsdcMint1111111111111111111111111111111";
export const id = (label: string): Identity => identityFromSeed(seedFrom(`agents-test/${label}`));
export const people = {
  conner: id("conner"),
  ops: id("ops"),
  errands: id("errands"),
  coder: id("coder"),
  dana: id("dana"),
  ci: id("ci"),
  arbiter: id("arbiter"),
  verify: id("settle-verify"),
  quickfix: id("quickfix"),
  byteWorks: id("byte-works"),
};
export const NAMES: Record<string, string> = {
  [people.conner.did]: "Conner Swann",
  [people.ops.did]: "Ops agent",
  [people.errands.did]: "Errands agent",
  [people.coder.did]: "Coder agent",
  [people.dana.did]: "Dana Ruiz",
  [people.ci.did]: "Demo CI",
  [people.arbiter.did]: "Settle Arbitration",
  [people.verify.did]: "Settle Verify",
  [people.quickfix.did]: "QuickFix",
};

export async function until<T>(what: string, cond: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface Sent {
  to: string;
  type: string;
  payload: any;
}

/** A TSP endpoint that records what it sends, and lets a test deliver messages to its handlers. */
export class FakeEndpoint {
  readonly sent: Sent[] = [];
  private readonly handlers = new Map<string, (doc: any, ctx: { sender: string }) => unknown>();
  constructor(readonly vid: string) {}
  async notify(to: string, spec: { typeUri: string }, payload: unknown) {
    this.sent.push({ to, type: spec.typeUri, payload: structuredClone(payload) });
    return "delivered";
  }
  async request(): Promise<never> {
    throw new Error("no requests in tests");
  }
  handle(spec: { typeUri: string }, h: (doc: any, ctx: { sender: string }) => unknown) {
    this.handlers.set(spec.typeUri, h);
  }
  async deliver(spec: { typeUri: string }, payload: unknown, sender: string): Promise<unknown> {
    const h = this.handlers.get(spec.typeUri);
    if (!h) throw new Error(`no handler for ${spec.typeUri}`);
    return h({ type: spec.typeUri, payload: structuredClone(payload), issuer: sender }, { sender });
  }
  of(type: string): Sent[] {
    return this.sent.filter((s) => s.type.includes(type));
  }
}

/** A Settle party spy: it records checkouts and wallet sends, and moves no money. */
export class FakeSettle implements SettlePort {
  readonly did: string;
  readonly name: string;
  readonly endpoint: FakeEndpoint;
  readonly directory = { mint: MINT, arbiter: { did: people.arbiter.did }, names: { ...NAMES } };
  readonly payments = new Map<string, PaymentState>();
  readonly checkouts = new Map<string, Checkout>();
  readonly checkoutCalls: { link: PaymentLink; attachments: any; at: number }[] = [];
  readonly sends: { to: string; amount: bigint }[] = [];
  readonly attests: { id: string; claim: string }[] = [];
  balance: bigint;
  onCheckout?: (link: PaymentLink, attachments: any) => void;

  constructor(
    readonly identity: Identity,
    o: { balance?: bigint } = {},
  ) {
    this.did = identity.did;
    this.name = NAMES[identity.did] ?? "agent";
    this.endpoint = new FakeEndpoint(identity.did);
    this.balance = o.balance ?? USDC(150);
  }
  async checkout(link: PaymentLink, opts: { attachments?: unknown } = {}): Promise<Checkout> {
    this.onCheckout?.(link, opts.attachments);
    const need = BigInt(link.units) + this.feeFor(BigInt(link.units));
    if (need > this.balance) throw new Error("not enough in your wallet");
    this.balance -= need;
    this.checkoutCalls.push({ link, attachments: structuredClone(opts.attachments), at: Date.now() });
    const c: Checkout = { id: `checkout-${this.checkoutCalls.length}`, link, status: "contacting", at: new Date().toISOString() };
    this.checkouts.set(c.id, c);
    return c;
  }
  feeFor(price: bigint): bigint {
    const f = (price * 100n) / 10_000n;
    return f < 500_000n ? 500_000n : f;
  }
  async openWallet() {
    return { token: `wallet-${this.name}` };
  }
  async walletBalance() {
    return this.balance;
  }
  async sendFromWallet(to: string, amount: bigint) {
    if (amount > this.balance) throw new Error("not enough");
    this.balance -= amount;
    this.sends.push({ to, amount });
  }
  async attest(id: string, claim: "complete" | "not-complete") {
    this.attests.push({ id, claim });
  }
  async dispute() {}
  async createLink(o: { title: string; units: bigint; release: PaymentLink["release"]; attester?: string; disputeWindowDays?: number }): Promise<PaymentLink> {
    return makeLink(this.identity, { title: o.title, units: o.units, attester: o.attester ?? null, disputeWindowDays: o.disputeWindowDays ?? 0 });
  }
}

export class FakeHub implements HubPort {
  readonly lists = new Map<string, StatusListDoc>();
  constructor(readonly profiles: WorkerProfile[] = []) {}
  async workers() {
    return this.profiles;
  }
  async putStatus(list: StatusListDoc) {
    this.lists.set(list.id, list);
  }
  resolver(): StatusResolver {
    return { get: async (id) => this.lists.get(id) ?? null };
  }
}

export function verified(subject: Identity, name: string, category: string, clock: Clock): Credential {
  return issueCredential(people.verify, clock, {
    type: ["VerifiableCredential", "VerifiedBusiness"],
    credentialSubject: { id: subject.did, name, category },
    validUntil: new Date(clock.now() + 365 * 86_400_000).toISOString(),
  });
}

export function makeLink(issuer: Identity, o: { title?: string; units: bigint; attester: string | null; disputeWindowDays?: number; credentials?: Credential[]; clock?: Clock }): PaymentLink {
  const clock = o.clock ?? new DemoClock(new Date().toISOString());
  return signDocument(
    {
      type: "settle/payment-link" as const,
      issuer: issuer.did,
      id: `link-${crypto.randomUUID()}`,
      name: NAMES[issuer.did] ?? "worker",
      title: o.title ?? "A job",
      units: o.units.toString(),
      release: o.attester ? ("attester-confirms" as const) : ("payer-confirms" as const),
      ...(o.attester ? { attester: o.attester, attesterName: NAMES[o.attester] ?? "" } : {}),
      disputeWindowDays: o.disputeWindowDays ?? 0,
      credentials: o.credentials ?? [],
      created: clock.iso(),
    },
    issuer,
    clock,
  ) as PaymentLink;
}

/** The demo's root constraints (design §7.1), with tweaks. */
export function rootConstraints(o: { perTx?: number; perDay?: number; total?: number } = {}): Record<string, Constraint> {
  return {
    actions: { attr: "type", anyOf: ["settle/pay", "settle/attest", "settle/dispute", "agents/job/offer", "mandates/delegate"] },
    asset: { attr: "asset", anyOf: [MINT], when: ["settle/pay", "mandates/delegate"] },
    spendPerTx: { attr: "spend", max: USDC(o.perTx ?? 30).toString(), when: ["settle/pay"] },
    spendPerDay: { attr: "spend", budget: USDC(o.perDay ?? 100).toString(), period: "P1D" },
    spendTotal: { attr: "spend", budget: USDC(o.total ?? 200).toString(), period: "total" },
    categories: { attr: "category", within: ["software.*", "physical.errand"], when: ["settle/pay", "agents/job/offer"] },
    attesters: { attr: "attester", anyOf: [people.ci.did, people.conner.did], when: ["settle/pay"] },
    arbiters: { attr: "arbiter", anyOf: [people.arbiter.did], when: ["settle/pay"] },
    minWindow: { attr: "disputeWindowSeconds", min: 0, when: ["settle/pay"] },
    tasks: { attr: "task", within: ["https://zk-toip.example/spec/settle/*", "https://zk-toip.example/spec/agents/*", "https://zk-toip.example/spec/mandates/*"] },
  };
}

export interface Fixture {
  options: GuardOptions;
  clock: DemoClock;
  engine: MandateEngine;
  guard: Guard;
  settle: FakeSettle;
  hub: FakeHub;
  registry: StatusRegistry;
  opsRegistry: StatusRegistry;
  mandate: Mandate;
  sink: EventlogSink;
  witness: Witness;
  witnessClient: WitnessClient;
  /** Offers a job to a worker and delivers its quote. Returns the quote id. */
  quote(o: { worker: Identity; units: number; attester?: string | null; release?: "ci" | "principal"; category?: string; maxPrice?: string; credentials?: Credential[]; note?: string; disputeWindowDays?: number }): Promise<string>;
}

export async function fixture(o: { approvable?: string[]; constraints?: Record<string, Constraint>; balance?: bigint; witness?: "ok" | "down"; start?: string } = {}): Promise<Fixture> {
  const clock = new DemoClock(o.start ?? new Date().toISOString());
  const engine = await defaultEngine();
  const registry = new StatusRegistry(people.conner, clock);
  const opsRegistry = new StatusRegistry(people.ops, clock);
  const mandate = issueMandate(people.conner, clock, {
    subject: people.ops.did,
    validUntil: new Date(clock.now() + 7 * 86_400_000).toISOString(),
    status: registry.allocate(),
    profile: "settle/1",
    purpose: "Keep the demo repo green and run small errands for me.",
    constraints: o.constraints ?? rootConstraints(),
    delegation: { maxDepth: 1 },
    escalation: { approvable: o.approvable ?? ["spendPerTx", "spendPerDay", "categories"], approvalTtlSeconds: 3600 },
    revocation: { maxAgeSeconds: 3600 },
  });
  const profiles = [
    signProfile(people.coder, clock, { name: "Coder agent", kind: "agent", skills: ["software"] }),
    signProfile(people.quickfix, clock, { name: "QuickFix", kind: "agent", skills: ["software"] }),
    signProfile(people.dana, clock, { name: "Dana Ruiz", kind: "human", skills: ["courier"] }),
    signProfile(people.errands, clock, { name: "Errands agent", kind: "agent", skills: ["errands"], wallet: "wallet-errands" }),
  ];
  const hub = new FakeHub(profiles);
  await hub.putStatus(registry.sign());
  const witness = new Witness({ signer: ed25519Signer(people.conner.signingSecret), store: new MemoryStore(), clock });
  const up = localWitnessClient(witness);
  const down: WitnessClient = { aid: witness.aid, submit: async () => Promise.reject(new Error("unreachable")), addReceipts: async () => undefined, query: async () => "", head: async () => undefined };
  const witnessClient: WitnessClient = { aid: witness.aid, submit: (s) => (mode.down ? down.submit(s) : up.submit(s)), addReceipts: (s) => up.addReceipts(s), query: (q) => up.query(q), head: (l) => up.head(l) };
  const mode = { down: o.witness === "down" };
  const sink = await createAgentTrail({ identity: people.ops, rotationSeed: seedFrom("rot/ops"), principalNext: "EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", witnesses: [witnessClient], clock, timeoutMs: 1000 });
  const settle = new FakeSettle(people.ops, { ...(o.balance !== undefined ? { balance: o.balance } : {}) });
  const passport = issuePassport(people.conner, clock, {
    agent: people.ops.did,
    name: "Ops agent",
    description: "test",
    operator: { id: people.conner.did, name: "Conner Swann" },
    accountable: { id: people.conner.did, name: "Conner Swann" },
    runtime: { kind: "llm-agent", provider: "scripted", model: "scripted:test", toolsHash: "sha256:x" },
    endpoints: [],
    audit: { aid: sink.aid, trail: sink.trailId, witnesses: sink.witnesses },
  });
  const options: GuardOptions = {
    name: "Ops agent",
    identity: people.ops,
    settle,
    engine,
    audit: sink,
    hub,
    status: hub.resolver(),
    clock,
    passport,
    principal: people.conner.did,
    chain: [mandate],
    rootCredentials: [verified(people.conner, "Conner Swann", "", clock)],
    statusRegistry: opsRegistry,
    ci: { did: people.ci.did, repo: "/tmp/repo.git" },
    names: (d) => NAMES[d],
    maxWaitSeconds: 1,
  };
  const guard = new Guard(options);
  return {
    options,
    clock,
    engine,
    guard,
    settle,
    hub,
    registry,
    opsRegistry,
    mandate,
    sink,
    witness,
    witnessClient,
    async quote(q) {
      const release = q.release ?? "ci";
      const offered = await guard.offerJob({ worker: q.worker.did, title: "A job", description: "Do it", category: q.category ?? "software.tests", maxPrice: q.maxPrice ?? "200", release, disputeWindowDays: q.disputeWindowDays ?? 0 });
      if (!offered.ok) throw new Error(`offer refused: ${JSON.stringify(offered)}`);
      const attester = q.attester === undefined ? (release === "ci" ? people.ci.did : people.conner.did) : q.attester;
      const link = makeLink(q.worker, { units: USDC(q.units), attester, disputeWindowDays: q.disputeWindowDays ?? 0, credentials: q.credentials ?? [], clock });
      const before = guard.quotes.size;
      await settle.endpoint.deliver(JOB_QUOTE, { job: offered.value.job, link, ...(q.note ? { note: q.note } : {}) }, q.worker.did);
      await until("the quote", () => guard.quotes.size > before);
      return [...guard.quotes.keys()].pop()!;
    },
    ...{ setWitnessDown: (v: boolean) => (mode.down = v) },
  } as Fixture & { setWitnessDown(v: boolean): void };
}

/** The trail's bodies, by kind, in order. */
export async function trailBodies(sink: EventlogSink): Promise<{ kind: string; body: any; s: number }[]> {
  const out: { kind: string; body: any; s: number }[] = [];
  for (const m of await sink.store.all(sink.trailId)) {
    if (m.t !== "ten") continue;
    const h = JSON.parse(m.raw);
    const raw = h.a ? await sink.store.getBody(h.a) : undefined;
    out.push({ kind: h.k, body: raw ? JSON.parse(raw) : undefined, s: m.s });
  }
  return out;
}

/** A guard that records which tools reached it. */
export function recordingGuard(): GuardApi & { reached: string[] } {
  const reached: string[] = [];
  const ok = async (name: string) => {
    reached.push(name);
    return { ok: true as const, value: {} };
  };
  return {
    reached,
    whoami: async () => (reached.push("whoami"), { name: "x", did: "did:x", principal: "p", passport: null, mandate: [], budgets: [], wallet: "0", paused: false, revoked: false }),
    findWorkers: async () => (reached.push("find_workers"), [{ name: "Coder agent", did: "did:key:z6Mkcoder", kind: "agent" as const, skills: ["software"], verified: null }]),
    offerJob: () => ok("offer_job") as never,
    inbox: async () => (reached.push("inbox"), []),
    checkMandate: () => ok("check_mandate") as never,
    hire: async () => (reached.push("hire"), { status: "error", error: "x" }),
    attest: () => ok("attest"),
    dispute: () => ok("dispute"),
    delegate: () => ok("delegate") as never,
    payments: async () => (reached.push("payments"), []),
    report: () => ok("report"),
    quote: () => ok("quote") as never,
    decline: () => ok("decline"),
    deliver: () => ok("deliver"),
    readFile: () => ok("read_file") as never,
    writeFile: () => ok("write_file") as never,
    runTests: () => ok("run_tests") as never,
    sessionStart: async () => undefined,
    modelTurn: async () => undefined,
    toolCall: async (t) => void reached.push(`call:${t.tool}`),
    toolResult: async () => undefined,
    sessionEnd: async () => undefined,
    control: () => "run",
    notices: () => [],
  };
}

