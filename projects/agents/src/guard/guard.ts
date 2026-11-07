/**
 * The guard (design §5, §12.3): deterministic code between the model and the keys. It holds the identity, the
 * Settle party and the audit trail. Every gated tool call becomes an action, is decided against the mandate
 * chain, is logged (witnessed first, if it spends or signs), and only then carried out.
 */
import {
  delegate as delegateMandate,
  isRevoked,
  jcsHash,
  mandateHash,
  present,
  requestApproval,
  sendMandate,
  serveMandateTasks,
  SpendLedger,
  type Action,
  type Approval,
  type Decision,
  type Mandate,
  type MandateEngine,
  type Reason,
  type Requirements,
  type StatusRegistry,
  type StatusResolver,
} from "@zk-toip/mandates";
import { verifyCredential, type Clock, type Credential, type Handler, type Identity, type Traffic } from "@zk-toip/trust-core";
import type { Checkout, PayeeGates, PaymentLink } from "@zk-toip/settle/src/agents/party";
import { verifyLink } from "@zk-toip/settle/src/agents/party";
import type { PaymentState, AgentEvent } from "@zk-toip/settle/src/agents/base";
import { hex } from "@zk-toip/settle/src/agents/base";
import { termsHash } from "@zk-toip/settle/src/protocol/documents";
import { APPROVAL_REQUEST_TTL_SECONDS, parseUsdc, taskUri, usdc } from "../config";
import type { AuditSink } from "../audit/sink";
import type { HubPort, WorkerProfile } from "../hub/client";
import { verifyProfile } from "../hub/client";
import { verifyPassport } from "../passport";
import {
  CONTROL,
  JOB_DECLINE,
  JOB_DELIVER,
  JOB_OFFER,
  JOB_QUOTE,
  JOB_REFUSED,
  JOB_WATCH,
  REPORT,
  TASK,
  type Control,
  type JobDecline,
  type JobDeliver,
  type JobOffer,
  type JobQuote,
  type JobRefused,
  type Release,
  type TaskMessage,
} from "../protocol/tasks";
import type { DecisionView, DelegationDraft, GuardApi, HireResult, InboxEvent, JobDraft, PaymentCard, ToolResult, WhoAmI, WorkerCard } from "./api";
import { decisionView, guardRefusal } from "./explain";
import type { Workspace } from "./workspace";

type Spec = { typeUri: string };

/** The part of a Settle Party the guard uses. A test can stand in a spy. */
export interface SettlePort {
  readonly did: string;
  readonly name: string;
  readonly endpoint: { notify(to: string, spec: any, payload: unknown): Promise<unknown>; handle<P, R>(spec: any, h: Handler<P, R>): void };
  readonly directory: { mint: string; arbiter: { did: string }; names: Record<string, string> };
  readonly payments: Map<string, PaymentState>;
  readonly checkouts: Map<string, Checkout>;
  gates?: PayeeGates;
  checkout(link: PaymentLink, opts?: { attachments?: unknown }): Promise<Checkout>;
  feeFor(price: bigint): bigint;
  openWallet(): Promise<{ token: string }>;
  walletBalance(): Promise<bigint>;
  sendFromWallet(to: any, amount: bigint): Promise<void>;
  attest(paymentId: string, claim: "complete" | "not-complete", note?: string): Promise<void>;
  dispute(paymentId: string, reason: string): Promise<void>;
  createLink(o: { title: string; units: bigint; release: PaymentLink["release"]; attester?: string; disputeWindowDays?: number }): Promise<PaymentLink>;
}

export interface GuardOptions {
  name: string;
  identity: Identity;
  settle: SettlePort;
  engine: MandateEngine;
  audit: AuditSink;
  hub: HubPort;
  status: StatusResolver;
  clock: Clock;
  passport: Credential;
  /** The root principal: approvals go there, and it may control the agent. */
  principal: string;
  chain?: Mandate[];
  /** The principal's credentials to show counterparties (Settle Verify's VerifiedBusiness). */
  rootCredentials?: Credential[];
  /** This agent's own status list, for mandates it issues. */
  statusRegistry?: StatusRegistry;
  /** The CI attester, for `release: "ci"`, and the repository code jobs use. */
  ci?: { did: string; repo: string };
  /** Worker agents: their files, and what they require of a hirer's presentation. */
  workspace?: Workspace;
  workerRequirements?: Requirements;
  names?: (did: string) => string | undefined;
  /** Called when a principal or delegator gives this agent work. */
  onTask?: (text: string, from: string) => void;
  /** Narration. */
  onNote?: (text: string) => void;
  /** How long a hire may wait in the inbox at most (seconds). Tests use less. */
  maxWaitSeconds?: number;
}

interface HirerJob {
  id: string;
  worker: string;
  workerName: string;
  title: string;
  category: string;
  maxUnits: bigint;
  attester: string | null; // null: payer-confirms
  disputeWindowDays: number;
  release: JobDraft["release"];
  checkout?: string;
  status: string;
}

interface Quote {
  id: string;
  job: string;
  from: string;
  link: PaymentLink;
  note?: string;
  at: string;
}

interface Pending {
  request: string;
  quote: string;
  action: Action;
  actionHash: string;
  expiresAt: number;
  state: "waiting" | "granted" | "denied" | "lapsed" | "failed";
  justification: string;
}

interface WorkerJob {
  offer: JobOffer;
  hirer: string;
  verified: boolean;
  verifiedText: string[];
  link?: PaymentLink;
  delivered?: string;
}

export interface GuardSnapshot {
  v: 1;
  did: string;
  chain: Mandate[];
  ledger: ReturnType<SpendLedger["save"]>;
  jobs: (Omit<HirerJob, "maxUnits"> & { maxUnits: string })[];
  quotes: Quote[];
  quoteSeq: number;
  pending: Pending[];
  offers: [string, WorkerJob][];
  issued: { mandate: Mandate; to: string; funded: string }[];
  checkoutAction: [string, { action: string; job: string }][];
  paymentSeen: [string, string][];
  paused: boolean;
  revoked: boolean;
}

const uuid = () => globalThis.crypto.randomUUID();
const short = (s: string) => s.slice(0, 8);

export class Guard implements GuardApi {
  readonly did: string;
  readonly name: string;
  chain: Mandate[];
  readonly ledger = new SpendLedger();
  paused = false;
  stopped = false;
  revoked = false;
  readonly jobs = new Map<string, HirerJob>();
  readonly quotes = new Map<string, Quote>();
  readonly pending = new Map<string, Pending>();
  readonly offers = new Map<string, WorkerJob>();
  /** Child mandates this agent issued. */
  readonly issued: { mandate: Mandate; to: string; funded: string }[] = [];
  private readonly events: InboxEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly noticeQueue: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private quoteSeq = 0;
  private readonly paymentSeen = new Map<string, string>();
  /** Checkout id → the hire's action id, so budgets follow payments. */
  private readonly checkoutAction = new Map<string, { action: string; job: string }>();
  private lastDecision?: { s: number; d: string };

  constructor(private readonly o: GuardOptions & { snapshot?: GuardSnapshot }) {
    this.did = o.identity.did;
    this.name = o.name;
    this.chain = o.chain ?? [];
    if (o.snapshot) this.restore(o.snapshot);
    this.mount();
  }

  /** Everything the guard needs to pick up where it left off. Keys aren't in it. Save it with the Settle party's snapshot. */
  snapshot(): GuardSnapshot {
    return structuredClone({
      v: 1 as const,
      did: this.did,
      chain: this.chain,
      ledger: this.ledger.save(),
      jobs: [...this.jobs.values()].map((j) => ({ ...j, maxUnits: j.maxUnits.toString() })),
      quotes: [...this.quotes.values()],
      quoteSeq: this.quoteSeq,
      pending: [...this.pending.values()],
      offers: [...this.offers.entries()],
      issued: this.issued,
      checkoutAction: [...this.checkoutAction.entries()],
      paymentSeen: [...this.paymentSeen.entries()],
      paused: this.paused,
      revoked: this.revoked,
    });
  }

  private restore(s: GuardSnapshot): void {
    if (s?.v !== 1 || s.did !== this.did) throw new Error("not this guard's snapshot");
    this.chain = s.chain;
    for (const e of s.ledger.entries) this.ledger.reserve(e.mandate, e.actionId, e.spend, e.at);
    for (const e of s.ledger.entries) if (e.refunded) this.ledger.refund(e.actionId, e.refunded);
    for (const id of s.ledger.usedApprovals) this.ledger.markApprovalUsed(id);
    for (const j of s.jobs) this.jobs.set(j.id, { ...j, maxUnits: BigInt(j.maxUnits) });
    for (const q of s.quotes) this.quotes.set(q.id, q);
    this.quoteSeq = s.quoteSeq;
    for (const p of s.pending) this.pending.set(p.request, p);
    for (const [k, v] of s.offers) this.offers.set(k, v);
    this.issued.push(...s.issued);
    for (const [k, v] of s.checkoutAction) this.checkoutAction.set(k, v);
    for (const [k, v] of s.paymentSeen) this.paymentSeen.set(k, v);
    this.paused = s.paused;
    this.revoked = s.revoked;
  }

  // ================================================================ plumbing

  private get settle(): SettlePort {
    return this.o.settle;
  }
  private get clock(): Clock {
    return this.o.clock;
  }
  private leaf(): Mandate | undefined {
    return this.chain[this.chain.length - 1];
  }
  nameOf(did: string): string {
    if (did === this.did) return this.name;
    return this.o.names?.(did) ?? this.settle.directory.names[did] ?? `${did.slice(0, 16)}…`;
  }
  private note(text: string): void {
    this.o.onNote?.(text);
  }

  /** One gated action at a time, so decisions and reservations can't interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private push(e: Omit<InboxEvent, "at">): void {
    this.events.push({ ...e, at: this.clock.iso() } as InboxEvent);
    for (const w of [...this.waiters]) w();
  }

  private log(kind: string, body: Record<string, unknown>) {
    return this.o.audit.append(kind, body);
  }

  /** Logs Settle's own notes about this agent's payments (S3). */
  onSettleEvent(e: AgentEvent): void {
    void this.log("agent/payment", { note: e.text, at: e.at }).catch(() => undefined);
  }

  /** Logs every Trust Task sent or received, except the witnesses' own traffic. */
  onTraffic(t: Traffic): void {
    const type = t.document.type;
    if (type.includes("/spec/trail/")) return;
    void this.log(t.direction === "in" ? "agent/message-received" : "agent/message-sent", { peer: t.peer, type, id: t.document.id, bytes: t.bytes }).catch(() => undefined);
  }

  private on<P>(spec: Spec, fn: (p: P, sender: string) => Promise<void> | void): void {
    // Handlers never await a TSP request: anything that needs one runs in the guard's queue, not the handler.
    this.settle.endpoint.handle<P, void>(spec, async (doc, ctx) => {
      await fn.call(this, doc.payload, ctx.sender);
    });
  }

  private mount(): void {
    this.on<JobQuote>(JOB_QUOTE, this.onQuote);
    this.on<JobDecline>(JOB_DECLINE, (p, s) => this.onJobNote("declined", p.job, s, { untrusted: { reason: String(p?.reason ?? "").slice(0, 500) } }));
    this.on<JobRefused>(JOB_REFUSED, (p, s) => this.onJobNote("refused", p.job, s, { untrusted: { reasons: (p?.reasons ?? []).slice(0, 10).map((x) => String(x).slice(0, 300)) } }));
    this.on<JobDeliver>(JOB_DELIVER, this.onDelivered);
    this.on<Control>(CONTROL, this.onControl);
    this.on<TaskMessage>(TASK, this.onTaskMessage);
    this.on<JobOffer>(JOB_OFFER, this.onOffer);
    serveMandateTasks(this.settle.endpoint as never, {
      clock: this.clock,
      engine: this.o.engine,
      onIssue: ({ mandate, chain, sender }) => this.onIssued([...chain, mandate], sender),
      onRevoked: ({ statusList, sender }) => {
        const hit = this.chain.find((m) => m.issuer === sender && isRevoked(m, statusList));
        if (!hit) return;
        this.revoked = true;
        this.noticeQueue.push(`Your mandate ${hit.id} was revoked by ${this.nameOf(sender)}. Every gated action will be refused.`);
        this.push({ type: "revoked", mandate: hit.id, by: this.nameOf(sender) });
        void this.log("agent/mandate-revoked", { mandate: hit.id, by: sender, statusList: jcsHash(statusList) });
        this.note(`learned its mandate was revoked by ${this.nameOf(sender)}`);
      },
      onApprovalGrant: ({ request, approval, sender }) => void this.serial(() => this.onGrant(request, approval, sender)).catch(() => undefined),
      onApprovalDeny: ({ request, reason, sender }) => void this.serial(() => this.onDeny(request, reason, sender)).catch(() => undefined),
      onRejected: ({ type, sender, reasons }) => void this.log("agent/message-rejected", { type, sender, reasons }),
    });
  }

  /** An operator configuring its own agent: a mandate handed over locally instead of by mandates/issue. Checked all the same. */
  async acceptMandate(chain: Mandate[]): Promise<void> {
    const reasons = await this.o.engine.checkChain({ chain, presenter: this.did, clock: this.clock, status: this.o.status });
    if (reasons.length) throw new Error(`the mandate doesn't check out: ${reasons.map((r) => r.code).join(", ")}`);
    await this.onIssued(chain, chain[chain.length - 1].issuer);
  }

  private async onIssued(chain: Mandate[], sender: string): Promise<void> {
    if (chain[0]?.issuer !== this.o.principal) return void this.log("agent/message-rejected", { type: "mandates/issue", sender, reasons: ["the chain isn't rooted at this agent's principal"] });
    this.chain = chain;
    this.revoked = false;
    await this.log("agent/mandate-accepted", { mandate: chain[chain.length - 1].id, hash: mandateHash(chain[chain.length - 1]), chain: chain.map((m) => m.id), from: sender });
    this.push({ type: "mandate", from: this.nameOf(sender), mandate: chain[chain.length - 1].id });
    this.note(`accepted a mandate from ${this.nameOf(sender)}`);
  }

  /** Who may tell this agent what to do: its principal, and the issuer of its own mandate. */
  private mayControl(sender: string): boolean {
    return sender === this.o.principal || sender === this.leaf()?.issuer;
  }

  private async onControl(c: Control, sender: string): Promise<void> {
    if (!this.mayControl(sender)) return void this.log("agent/message-rejected", { type: "agents/control", sender, reasons: ["not from the principal or the delegator"] });
    await this.log("agent/control", { op: c?.op, from: sender, ...(c?.mandate ? { mandate: c.mandate } : {}) });
    switch (c?.op) {
      case "pause":
        this.paused = true;
        this.noticeQueue.push("Your principal paused you. Gated tools are refused until you're resumed.");
        break;
      case "resume":
        this.paused = false;
        this.noticeQueue.push("Your principal resumed you.");
        break;
      case "stop":
        this.stopped = true;
        break;
      case "disclose":
        void this.discloseTo(sender);
        break;
      case "revoke":
        if (sender === this.o.principal && c.mandate) void this.serial(() => this.revokeIssued(c.mandate!, sender)).catch(() => undefined);
        break;
    }
    for (const w of [...this.waiters]) w();
  }

  private async onTaskMessage(t: TaskMessage, sender: string): Promise<void> {
    if (!this.mayControl(sender) || typeof t?.text !== "string") return;
    await this.log("agent/task", { from: sender, text: t.text.slice(0, 4000) });
    this.o.onTask?.(t.text.slice(0, 4000), sender);
  }

  /** Sends the principal a bundle of the whole trail, bodies included (trail/disclose). */
  async discloseTo(to: string): Promise<void> {
    const { disclose } = await import("@zk-toip/eventlog");
    await this.o.audit.flush();
    const bundle = await this.o.audit.bundle();
    await disclose(this.settle.endpoint as never, to, bundle).catch((e) => this.note(`couldn't disclose its trail: ${String(e?.message ?? e)}`));
  }

  /** The principal asked this agent to revoke a mandate it issued. The guard does it; the model has no say. */
  private async revokeIssued(id: string, by: string): Promise<void> {
    const it = this.issued.find((x) => x.mandate.id === id);
    const reg = this.o.statusRegistry;
    if (!it || !reg) return;
    reg.revoke(it.mandate.credentialStatus);
    const list = reg.sign();
    await this.o.hub.putStatus(list);
    const { notifyRevoked } = await import("@zk-toip/mandates");
    await notifyRevoked(this.settle.endpoint as never, it.to, { mandate: id, statusList: list });
    await this.log("agent/mandate-revoked-issued", { mandate: id, subject: it.to, at: by, statusList: jcsHash(list) });
    this.note(`revoked the mandate it gave ${this.nameOf(it.to)}, as its principal asked`);
  }

  /** Re-signs this agent's own status list and publishes it, so mandates it issued stay fresh. */
  async refreshStatus(): Promise<void> {
    if (this.o.statusRegistry && this.issued.length) await this.o.hub.putStatus(this.o.statusRegistry.sign());
  }

  // ================================================================ deciding

  private spent() {
    const leaf = this.leaf();
    return leaf ? this.ledger.spent(leaf.id, this.clock.now()) : { P1D: "0", P7D: "0", P30D: "0", total: "0" };
  }

  private action(type: string, attrs: Record<string, any>): Action {
    return { type, profile: "settle/1", id: `act-${uuid()}`, actor: this.did, at: this.clock.iso(), attrs: { spend: "0", ...attrs } };
  }

  /** Decides an action against the whole chain. A paused or chainless agent is refused without asking the engine. */
  private async decide(action: Action, approvals: Approval[] = []): Promise<Decision | DecisionView> {
    if (!this.chain.length) return guardRefusal("agent.noMandate", "This agent holds no mandate yet.");
    if (this.paused) return guardRefusal("agent.paused", "The principal has paused this agent.");
    const leaf = this.leaf()!;
    return this.o.engine.decide({
      chain: this.chain,
      presenter: this.did,
      action,
      state: { mandate: leaf.id, spent: this.spent() },
      approvals,
      usedApprovals: (id) => this.ledger.approvalUsed(id),
      status: this.o.status,
      facts: { rootCredentials: this.o.rootCredentials ?? [], passport: this.o.passport },
      clock: this.clock,
    });
  }

  private view(d: Decision | DecisionView, extra: Reason[] = [], categorySource?: DecisionView["categorySource"], noun = "this payment"): DecisionView {
    if ("sentences" in d) return d;
    return decisionView(d, { name: (x) => this.nameOf(x), extra, noun, ...(categorySource ? { categorySource } : {}) });
  }

  /** Logs a decision. Allowed actions that spend or sign are witnessed first; if no witness answers, this throws. */
  private async logDecision(action: Action, d: Decision | DecisionView, v: DecisionView, o: { witnessed: boolean; dryRun?: boolean; approvals?: Approval[] }) {
    const body = {
      action,
      actionHash: v.actionHash || jcsHash(action),
      outcome: v.outcome,
      reasons: v.reasons,
      sentences: v.sentences,
      chain: this.chain.map((m) => m.id),
      approvals: (o.approvals ?? []).map((a) => a.id),
      policy: "policy" in d ? d.policy : null,
      state: this.spent(),
      ...(v.categorySource ? { categorySource: v.categorySource } : {}),
      ...(o.dryRun ? { dryRun: true } : {}),
    };
    if (o.witnessed && v.outcome === "allow") {
      const r = await this.o.audit.appendWitnessed("agent/mandate-decision", body);
      this.lastDecision = { s: r.s, d: r.d };
      return r.ref;
    }
    const r = await this.o.audit.append("agent/mandate-decision", body);
    this.lastDecision = r;
    return null;
  }

  // ================================================================ the loop's bookkeeping

  async sessionStart(s: { model: string; systemHash: string; toolsHash: string; task: string }): Promise<void> {
    await this.log("agent/session-start", { ...s, passport: this.o.passport.id, chain: this.chain.map((m) => m.id) });
  }
  async modelTurn(t: { model: string; requestHash: string; stopReason: string | null; usage: unknown; content: unknown }): Promise<void> {
    await this.log("agent/model-turn", t as Record<string, unknown>);
  }
  async toolCall(t: { tool: string; input: unknown; id: string }): Promise<void> {
    this.lastDecision = undefined;
    await this.log("agent/tool-call", t as Record<string, unknown>);
  }
  async toolResult(t: { tool: string; id: string; result: unknown; error: boolean }): Promise<void> {
    await this.log("agent/tool-result", { ...t, ...(this.lastDecision ? { decision: this.lastDecision } : {}) });
  }
  async sessionEnd(s: { reason: string; summary?: string }): Promise<void> {
    await this.log("agent/session-end", s);
  }
  control(): "run" | "paused" | "stopped" {
    return this.stopped ? "stopped" : this.paused ? "paused" : "run";
  }
  notices(): string[] {
    return this.noticeQueue.splice(0);
  }

  // ================================================================ hirer tools

  async whoami(): Promise<WhoAmI> {
    const leaf = this.leaf();
    const spent = this.spent();
    const budgets: WhoAmI["budgets"] = [];
    for (const [dimension, c] of Object.entries(leaf?.credentialSubject.constraints ?? {})) {
      if ("budget" in c) {
        const s = spent[c.period];
        budgets.push({ dimension, period: c.period, limit: usdc(c.budget), spent: usdc(s), left: usdc(BigInt(c.budget) - BigInt(s) > 0n ? BigInt(c.budget) - BigInt(s) : 0n) });
      } else if ("max" in c && c.attr === "spend") budgets.push({ dimension, period: "per payment", limit: usdc(String(c.max)), spent: "-", left: "-" });
    }
    const p = await verifyPassport(this.o.passport, this.did, this.clock);
    return {
      name: this.name,
      did: this.did,
      principal: this.nameOf(this.o.principal),
      passport: p.ok ? { model: p.model!, operator: p.operator! } : null,
      mandate: this.chain.map((m) => `${this.nameOf(m.issuer)} → ${this.nameOf(m.credentialSubject.id)}: ${m.credentialSubject.purpose ?? ""} (until ${m.validUntil.slice(0, 16).replace("T", " ")})`),
      budgets,
      wallet: usdc(await this.settle.walletBalance().catch(() => 0n)),
      paused: this.paused,
      revoked: this.revoked,
    };
  }

  private async directory(): Promise<WorkerProfile[]> {
    const all = await this.o.hub.workers().catch(() => [] as WorkerProfile[]);
    const out: WorkerProfile[] = [];
    for (const p of all) if (p.issuer !== this.did && (await verifyProfile(p, this.clock))) out.push(p);
    return out;
  }

  async findWorkers(q: { skill: string }): Promise<WorkerCard[]> {
    const skill = String(q?.skill ?? "").toLowerCase();
    const found = (await this.directory()).filter((p) => !skill || p.skills.some((s) => s.toLowerCase().includes(skill)) || p.name.toLowerCase().includes(skill));
    const out: WorkerCard[] = [];
    for (const p of found) {
      let verified: string | null = null;
      for (const c of p.credentials ?? []) {
        if (c?.type?.includes("VerifiedBusiness") && c.credentialSubject?.id === p.issuer && (await verifyCredential(c, this.clock)).ok) verified = `${String(c.credentialSubject.name)}, verified by ${this.nameOf(c.issuer)}`;
      }
      out.push({ name: p.name, did: p.issuer, kind: p.kind, skills: p.skills, verified, ...(p.rate ? { rate: p.rate } : {}) });
    }
    return out;
  }

  private async resolveWorker(who: string): Promise<WorkerProfile | undefined> {
    const all = await this.directory();
    return all.find((p) => p.issuer === who) ?? all.find((p) => p.name.toLowerCase() === String(who).toLowerCase());
  }

  /** Whether this agent's own DID is an allowed attester at every link: only then may it offer `release: "me"`. */
  private mayAttestOwn(): boolean {
    return this.chain.length > 0 && this.chain.every((m) => {
      const c = m.credentialSubject.constraints.attesters as { anyOf?: string[] } | undefined;
      return !c || (Array.isArray(c.anyOf) && c.anyOf.includes(this.did));
    });
  }

  offerJob(j: JobDraft): Promise<ToolResult<{ job: string }>> {
    return this.serial(async () => {
      const w = await this.resolveWorker(j.worker);
      if (!w) return { ok: false, error: `no worker called ${j.worker} in the directory` };
      const maxUnits = parseUsdc(j.maxPrice);
      if (maxUnits === null || maxUnits <= 0n) return { ok: false, error: "maxPrice must be an amount of USDC, like \"30\"" };
      let attester: string | null;
      if (j.release === "ci") {
        if (!this.o.ci) return { ok: false, error: "there is no CI attester for this agent's jobs" };
        attester = this.o.ci.did;
      } else if (j.release === "principal") attester = this.o.principal;
      else if (j.release === "me") {
        if (!this.mayAttestOwn()) return { ok: false, error: "your mandate doesn't let you confirm your own jobs; use \"ci\" or \"principal\"" };
        attester = null;
      } else return { ok: false, error: "release must be ci, principal or me" };
      const window = Math.max(0, Math.min(30, Math.floor(Number(j.disputeWindowDays) || 0)));
      const action = this.action("agents/job/offer", { counterparty: w.issuer, category: String(j.category), price: maxUnits.toString(), task: taskUri("agents/job/offer") });
      const d = await this.decide(action);
      const v = this.view(d, [], undefined, "this job offer");
      await this.logDecision(action, d, v, { witnessed: false });
      if (v.outcome !== "allow") return { ok: false, refused: v };
      const job = `job-${uuid().slice(0, 8)}`;
      const release: Release = attester ? { kind: "attester", attester } : { kind: "payer" };
      const leaf = this.leaf()!;
      const presentation = present(this.o.identity, this.clock, {
        audience: w.issuer,
        action,
        actionHash: jcsHash(action),
        chain: this.chain,
        approvals: [],
        passport: this.o.passport,
        rootCredentials: this.o.rootCredentials ?? [],
        spend: { mandate: leaf.id, spent: this.spent() },
      });
      const offer: JobOffer = {
        job,
        title: String(j.title).slice(0, 140),
        description: String(j.description).slice(0, 2000),
        category: String(j.category),
        maxUnits: maxUnits.toString(),
        release,
        disputeWindowDays: window,
        deliverable: j.release === "ci" ? "git" : "note",
        ...(j.release === "ci" && this.o.ci ? { repo: this.o.ci.repo } : {}),
        deadline: new Date(this.clock.now() + 2 * 86_400_000).toISOString(),
        hirerName: this.name,
        passport: this.o.passport,
        presentation,
      };
      this.jobs.set(job, { id: job, worker: w.issuer, workerName: w.name, title: offer.title, category: offer.category, maxUnits, attester, disputeWindowDays: window, release: j.release, status: "offered" });
      await this.settle.endpoint.notify(w.issuer, JOB_OFFER, offer);
      await this.log("agent/job", { job, event: "offered", counterparty: w.issuer, title: offer.title, category: offer.category, maxUnits: offer.maxUnits, release });
      this.note(`offered "${offer.title}" to ${w.name}, up to ${usdc(maxUnits)}`);
      return { ok: true, value: { job } };
    });
  }

  private async onQuote(p: JobQuote, sender: string): Promise<void> {
    const job = this.jobs.get(p?.job);
    if (!job || job.worker !== sender || p.link?.issuer !== sender) return void this.log("agent/message-rejected", { type: "agents/job/quote", sender, reasons: ["not a quote for a job offered to the sender"] });
    if (!(await verifyLink(p.link, this.clock))) return void this.log("agent/message-rejected", { type: "agents/job/quote", sender, reasons: ["the payment link doesn't verify"] });
    const id = `q-${++this.quoteSeq}`;
    const q: Quote = { id, job: job.id, from: sender, link: p.link, ...(p.note ? { note: String(p.note).slice(0, 1000) } : {}), at: this.clock.iso() };
    this.quotes.set(id, q);
    job.status = "quoted";
    await this.log("agent/job", { job: job.id, event: "quoted", counterparty: sender, quote: id, link: jcsHash(p.link), units: p.link.units, note: q.note });
    const cred = await this.verifiedCredentials(p.link);
    this.push({
      type: "quote",
      quote: {
        id,
        job: job.id,
        price: usdc(p.link.units),
        fee: usdc(this.settle.feeFor(BigInt(p.link.units))),
        from: { name: job.workerName, did: sender, verified: cred.names.length ? cred.names[0] : null },
        attester: p.link.release === "payer-confirms" ? "you" : this.nameOf(p.link.attester!),
        disputeWindowDays: p.link.disputeWindowDays,
        untrusted: { title: p.link.title, note: q.note ?? "" },
      },
    });
    this.note(`got a quote from ${job.workerName}: ${usdc(p.link.units)}`);
  }

  private async onJobNote(type: string, jobId: string, sender: string, extra: Record<string, unknown>): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.worker !== sender) return;
    job.status = type;
    await this.log("agent/job", { job: jobId, event: type, counterparty: sender, ...extra });
    this.push({ type, job: jobId, from: job.workerName, ...extra });
  }

  private async onDelivered(p: JobDeliver, sender: string): Promise<void> {
    const job = this.jobs.get(p?.job);
    if (!job || job.worker !== sender) return;
    job.status = "delivered";
    const d = p.deliverable;
    const what = d?.kind === "git" ? { commit: String(d.commit).slice(0, 64) } : { untrusted: { note: String((d as { text?: string })?.text ?? "").slice(0, 1000) } };
    await this.log("agent/job", { job: job.id, event: "delivered", counterparty: sender, ...what });
    this.push({ type: "delivered", job: job.id, from: job.workerName, ...what });
    this.note(`${job.workerName} delivered ${job.title}`);
  }

  /** Credentials the link's issuer showed that verify (signature, subject, validity): "Type@issuer", and a verified category if one. */
  private async verifiedCredentials(link: PaymentLink): Promise<{ list: string[]; names: string[]; category?: string }> {
    const list: string[] = [];
    const names: string[] = [];
    let category: string | undefined;
    for (const c of link.credentials ?? []) {
      if (c?.credentialSubject?.id !== link.issuer || !Array.isArray(c.type)) continue;
      if (!(await verifyCredential(c, this.clock)).ok) continue;
      for (const t of c.type) if (t !== "VerifiableCredential") list.push(`${t}@${c.issuer}`);
      if (c.type.includes("VerifiedBusiness")) {
        names.push(`${String(c.credentialSubject.name ?? "")}, verified by ${this.nameOf(c.issuer)}`);
        const cat = String(c.credentialSubject.category ?? "");
        if (cat && !category) category = cat;
      }
    }
    return { list, names, ...(category ? { category } : {}) };
  }

  /** The settle/pay action for a quote, and where it doesn't match its job. */
  private async payAction(q: Quote): Promise<{ action: Action; mismatch: Reason[]; categorySource: DecisionView["categorySource"] }> {
    const l = q.link;
    const job = this.jobs.get(q.job)!;
    const price = BigInt(l.units);
    const fee = this.settle.feeFor(price);
    const cred = await this.verifiedCredentials(l);
    // Decision 5: the category comes from the worker's verified credential when there is one.
    const category = cred.category ?? job.category;
    const categorySource = cred.category ? "worker's verified credential" : "the job as declared";
    const attester = l.release === "payer-confirms" ? this.did : (l.attester ?? "");
    const action = this.action("settle/pay", {
      spend: (price + fee).toString(),
      asset: this.settle.directory.mint,
      price: l.units,
      counterparty: l.issuer,
      counterpartyCredentials: cred.list,
      category,
      attester,
      arbiter: this.settle.directory.arbiter.did,
      disputeWindowSeconds: l.disputeWindowDays * 86400,
      link: jcsHash(l),
      job: job.id,
      task: taskUri("settle/checkout/start"),
      purpose: l.title,
    });
    const mismatch: Reason[] = [];
    const bad = (detail: string) => mismatch.push({ code: "quote.mismatch", detail, approvable: false });
    if (l.issuer !== job.worker) bad("it isn't from the worker the job was offered to");
    if ((job.attester ?? this.did) !== attester) bad(`it names ${this.nameOf(attester)} to confirm the work, not ${job.attester ? this.nameOf(job.attester) : "you"}`);
    if (l.disputeWindowDays !== job.disputeWindowDays) bad(`its dispute window is ${l.disputeWindowDays} days, not ${job.disputeWindowDays}`);
    if (price > job.maxUnits) bad(`${usdc(price)} is more than the ${usdc(job.maxUnits)} offered`);
    if (!(await verifyLink(l, this.clock))) bad("its payment link doesn't verify");
    return { action, mismatch, categorySource };
  }

  checkMandate(q: { quote: string }): Promise<ToolResult<DecisionView>> {
    return this.serial(async () => {
      const quote = this.quotes.get(q?.quote);
      if (!quote) return { ok: false, error: `no quote ${q?.quote}` };
      const { action, mismatch, categorySource } = await this.payAction(quote);
      const d = await this.decide(action);
      const v = this.view(d, mismatch, categorySource);
      await this.logDecision(action, d, v, { witnessed: false, dryRun: true });
      return { ok: true, value: v };
    });
  }

  hire(q: { quote: string; justification: string }): Promise<HireResult> {
    return this.serial(async () => {
      const quote = this.quotes.get(q?.quote);
      if (!quote) return { status: "error", error: `no quote ${q?.quote}` };
      const job = this.jobs.get(quote.job)!;
      if (job.checkout) return { status: "error", error: "that job is already paid for" };
      if ([...this.pending.values()].some((p) => p.quote === quote.id && p.state === "waiting")) return { status: "error", error: "that quote is already waiting for approval" };
      const { action, mismatch, categorySource } = await this.payAction(quote);
      const d = await this.decide(action);
      const v = this.view(d, mismatch, categorySource);
      if (v.outcome === "allow") return this.carryOut(quote, action, d, v, []);
      await this.logDecision(action, d, v, { witnessed: false });
      if (v.outcome === "deny") {
        this.note(`refused to pay ${job.workerName}: ${v.sentences[0]}`);
        return { status: "refused", decision: v };
      }
      // Escalate: ask the principal to approve this exact action (§9.3). In the MVP every escalation goes to the root.
      const request = `req-${uuid().slice(0, 8)}`;
      const expiresAt = this.clock.now() + APPROVAL_REQUEST_TTL_SECONDS * 1000;
      const justification = String(q.justification ?? "").slice(0, 1000);
      this.pending.set(request, { request, quote: quote.id, action, actionHash: v.actionHash, expiresAt, state: "waiting", justification });
      await this.log("agent/approval-requested", { request, actionHash: v.actionHash, approver: this.o.principal, justification, expiresAt: new Date(expiresAt).toISOString() });
      await requestApproval(this.settle.endpoint as never, this.o.principal, {
        request,
        action,
        actionHash: v.actionHash,
        chain: this.chain,
        decision: d as Decision,
        justification,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      this.note(`asked ${this.nameOf(this.o.principal)} to approve paying ${job.workerName} ${usdc(String(action.attrs.spend))}`);
      return { status: "pending_approval", request, decision: v };
    });
  }

  /** An allowed payment: reserve, witness the decision, present, check out. Runs in the guard's queue. */
  private async carryOut(quote: Quote, action: Action, d: Decision | DecisionView, v: DecisionView, approvals: Approval[]): Promise<HireResult> {
    const job = this.jobs.get(quote.job)!;
    const leaf = this.leaf()!;
    const before = this.spent();
    const over = this.ledger.tryReserve(leaf, action.id, String(action.attrs.spend), this.clock.now(), action.type);
    if (over.length) {
      const view = this.view({ ...(d as Decision), outcome: "deny", reasons: over }, [], v.categorySource);
      await this.logDecision(action, d, view, { witnessed: false });
      return { status: "refused", decision: view };
    }
    let trailRef;
    try {
      trailRef = await this.logDecision(action, d, v, { witnessed: true, approvals });
    } catch (e) {
      this.ledger.release(action.id);
      await this.log("agent/budget", { event: "released", action: action.id, why: "no witness receipt", error: String((e as Error)?.message ?? e) });
      this.note(`didn't pay: no witness receipted the decision`);
      return { status: "error", error: "no witness receipted the decision, so the payment didn't go ahead (fail closed)" };
    }
    await this.log("agent/budget", { event: "reserved", action: action.id, spend: action.attrs.spend, spent: this.spent() });
    for (const a of approvals) this.ledger.markApprovalUsed(a.id);
    const presentation = present(this.o.identity, this.clock, {
      audience: quote.from,
      action,
      actionHash: jcsHash(action),
      chain: this.chain,
      approvals,
      passport: this.o.passport,
      rootCredentials: this.o.rootCredentials ?? [],
      spend: { mandate: leaf.id, spent: before },
      ...(trailRef ? { trailRef } : {}),
    });
    try {
      const c = await this.settle.checkout(quote.link, { attachments: { presentation } });
      job.checkout = c.id;
      job.status = "paying";
      this.checkoutAction.set(c.id, { action: action.id, job: job.id });
      await this.log("agent/payment", { event: "checkout", job: job.id, checkout: c.id, link: jcsHash(quote.link), spend: action.attrs.spend, approvals: approvals.map((a) => a.id) });
      this.note(`paying ${job.workerName} ${usdc(String(action.attrs.spend))} into escrow`);
      return { status: "hired", payment: c.id, checkout: c.id, spend: usdc(String(action.attrs.spend)) };
    } catch (e) {
      this.ledger.release(action.id);
      await this.log("agent/budget", { event: "released", action: action.id, why: "checkout failed", error: String((e as Error)?.message ?? e) });
      return { status: "error", error: `the checkout failed: ${String((e as Error)?.message ?? e)}` };
    }
  }

  private async onGrant(request: string, approval: Approval, sender: string): Promise<void> {
    const p = this.pending.get(request);
    if (!p || p.state !== "waiting") return void this.log("agent/approval-ignored", { request, approval: approval?.id, why: "no such waiting request" });
    const quote = this.quotes.get(p.quote)!;
    // Re-decide with the approval. The guard carries the approved action out itself: the model can't alter it.
    const d = await this.decide(p.action, [approval]);
    const v = this.view(d, [], undefined);
    if (v.outcome !== "allow") {
      await this.logDecision(p.action, d, v, { witnessed: false, approvals: [approval] });
      await this.log("agent/approval-ignored", { request, approval: approval.id, from: sender, why: v.sentences.join(" ") });
      this.push({ type: "approval", request, status: "not usable", decision: v });
      return;
    }
    try {
      await this.o.audit.appendWitnessed("agent/approval-granted", { request, approval, actionHash: p.actionHash, from: sender });
    } catch {
      this.push({ type: "approval", request, status: "granted, but no witness receipted it; not paying" });
      return;
    }
    p.state = "granted";
    const r = await this.carryOut(quote, p.action, d, v, [approval]);
    if (r.status !== "hired") p.state = "failed";
    this.noticeQueue.push(`${this.nameOf(sender)} approved request ${request}. The guard carried out the payment itself: ${r.status === "hired" ? `paid ${r.spend} into escrow` : r.status}.`);
    this.push({ type: "approval", request, status: "granted", result: r });
    this.note(`${this.nameOf(sender)} approved; ${r.status === "hired" ? "the guard checked out" : `but ${r.status}`}`);
  }

  private async onDeny(request: string, reason: string | undefined, sender: string): Promise<void> {
    const p = this.pending.get(request);
    if (!p || p.state !== "waiting" || sender !== this.o.principal) return;
    p.state = "denied";
    await this.log("agent/approval-denied", { request, from: sender, reason: reason ?? "" });
    this.push({ type: "approval", request, status: "denied", untrusted: { reason: reason ?? "" } });
    this.noticeQueue.push(`${this.nameOf(sender)} denied request ${request}.`);
  }

  /** Acts on time: approval requests lapse. Call it every few seconds. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const now = this.clock.now();
      for (const p of this.pending.values()) {
        if (p.state !== "waiting" || now < p.expiresAt) continue;
        p.state = "lapsed";
        await this.log("agent/approval-lapsed", { request: p.request, actionHash: p.actionHash });
        this.push({ type: "approval", request: p.request, status: "lapsed" });
      }
    });
  }

  /** Follows this agent's payments in its Settle party: escrow opened, attested, settled. Call it on every change. */
  settleChanged(): void {
    void this.serial(async () => {
      for (const [checkoutId, meta] of this.checkoutAction) {
        const c = this.settle.checkouts.get(checkoutId);
        const p = c?.paymentId ? this.settle.payments.get(c.paymentId) : undefined;
        const status = c?.status === "failed" ? `failed: ${c.error}` : p?.settled ? `settled:${p.settled.payeeUnits}` : p?.attestations.length ? `attested:${p.attestations.map((a) => a.claim).join(",")}` : p?.escrow ? "escrow" : (c?.status ?? "?");
        if (this.paymentSeen.get(checkoutId) === status) continue;
        this.paymentSeen.set(checkoutId, status);
        const job = this.jobs.get(meta.job);
        if (c?.status === "failed" && !p?.escrow) {
          this.ledger.release(meta.action);
          await this.log("agent/budget", { event: "released", action: meta.action, why: c.error });
        }
        if (p?.settled && p.terms && BigInt(p.settled.payeeUnits) < BigInt(p.terms.amount.units)) {
          // Decision 4: a refund gives budget back.
          const back = BigInt(p.terms.amount.units) - BigInt(p.settled.payeeUnits);
          try {
            this.ledger.refund(meta.action, back.toString());
            await this.log("agent/budget", { event: "refunded", action: meta.action, units: back.toString() });
          } catch {
            // already refunded
          }
        }
        if (p?.escrow && p.terms && status === "escrow" && job?.release === "ci" && this.o.ci) {
          await this.settle.endpoint.notify(this.o.ci.did, JOB_WATCH, { job: meta.job, termsHash: hex(termsHash(p.terms)), check: { kind: "ci", repo: this.o.ci.repo, command: "node --test", timeoutSeconds: 60 } });
        }
        if (job) job.status = status.split(":")[0];
        await this.log("agent/payment", { event: status, job: meta.job, checkout: checkoutId, payment: c?.paymentId, escrow: p?.escrow, termsHash: p?.terms ? hex(termsHash(p.terms)) : undefined });
        this.push({ type: "payment", job: meta.job, payment: c?.paymentId ?? checkoutId, status: describe(status), with: job?.workerName });
      }
      for (const job of this.offers.values()) {
        const p = [...this.settle.payments.values()].find((x) => x.role === "payee" && x.link === job.link?.id);
        if (!p) continue;
        const status = p.settled ? `settled:${p.settled.payeeUnits}` : p.attestations.length ? `attested:${p.attestations.map((a) => a.claim).join(",")}` : p.escrow ? "escrow" : "invoiced";
        const key = `w:${p.id}`;
        if (this.paymentSeen.get(key) === status) continue;
        this.paymentSeen.set(key, status);
        await this.log("agent/payment", { event: status, job: job.offer.job, payment: p.id, escrow: p.escrow, role: "payee" });
        this.push({ type: "payment", job: job.offer.job, payment: p.id, status: describe(status), with: this.nameOf(job.hirer) });
      }
    }).catch(() => undefined);
  }

  inbox(o: { waitSeconds: number }): Promise<InboxEvent[]> {
    const wait = Math.max(0, Math.min(Number(o?.waitSeconds) || 0, this.o.maxWaitSeconds ?? 60));
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        clearTimeout(t);
        resolve(this.events.splice(0));
      };
      if (this.events.length || wait === 0 || this.stopped) return resolve(this.events.splice(0));
      const t = setTimeout(done, wait * 1000);
      this.waiters.add(done);
    });
  }

  attest(a: { payment: string; claim: "complete" | "not-complete"; note?: string }): Promise<ToolResult<{}>> {
    return this.serial(async () => {
      const p = this.findPayment(a?.payment);
      if (!p?.terms) return { ok: false, error: `no payment ${a?.payment}` };
      if (p.terms.conditions.attester !== this.did) return { ok: false, refused: guardRefusal("attest.notAttester", "This agent isn't the one named to confirm that payment, so it can't attest.") };
      const action = this.action("settle/attest", { payment: hex(termsHash(p.terms)), claim: a.claim, counterparty: p.terms.payee.did, task: taskUri("settle/escrow/attest") });
      const d = await this.decide(action);
      const v = this.view(d, [], undefined, "this attestation");
      try {
        await this.logDecision(action, d, v, { witnessed: true });
      } catch {
        return { ok: false, error: "no witness receipted the decision (fail closed)" };
      }
      if (v.outcome !== "allow") return { ok: false, refused: v };
      await this.settle.attest(p.id, a.claim, a.note);
      return { ok: true, value: {} };
    });
  }

  dispute(dd: { payment: string; reason: string }): Promise<ToolResult<{}>> {
    return this.serial(async () => {
      const p = this.findPayment(dd?.payment);
      if (!p?.terms) return { ok: false, error: `no payment ${dd?.payment}` };
      const action = this.action("settle/dispute", { payment: hex(termsHash(p.terms)), counterparty: p.role === "payer" ? p.terms.payee.did : p.terms.payer.did, task: taskUri("settle/escrow/dispute") });
      const d = await this.decide(action);
      const v = this.view(d, [], undefined, "this dispute");
      await this.logDecision(action, d, v, { witnessed: false });
      if (v.outcome !== "allow") return { ok: false, refused: v };
      await this.settle.dispute(p.id, String(dd.reason).slice(0, 500));
      return { ok: true, value: {} };
    });
  }

  private findPayment(id: string): PaymentState | undefined {
    const byCheckout = this.settle.checkouts.get(id)?.paymentId;
    return this.settle.payments.get(byCheckout ?? id);
  }

  delegate(dd: DelegationDraft): Promise<ToolResult<{ mandate: string; funded: string }>> {
    return this.serial(async () => {
      if (!this.chain.length) return { ok: false, refused: guardRefusal("agent.noMandate", "This agent holds no mandate yet.") };
      if (this.paused) return { ok: false, refused: guardRefusal("agent.paused", "The principal has paused this agent.") };
      const reg = this.o.statusRegistry;
      if (!reg) return { ok: false, error: "this agent can't issue mandates" };
      const w = await this.resolveWorker(dd.subAgent);
      if (!w || w.kind !== "agent" || !w.wallet) return { ok: false, error: `no sub-agent called ${dd.subAgent} with a wallet in the directory` };
      if (w.issuer === this.did) return { ok: false, error: "an agent can't delegate to itself" };
      const amounts = { perPayment: parseUsdc(dd.perPayment), perDay: parseUsdc(dd.perDay), total: parseUsdc(dd.total), funding: parseUsdc(dd.funding) };
      for (const [k, v] of Object.entries(amounts)) if (v === null) return { ok: false, error: `${k} must be an amount of USDC` };
      const leaf = this.leaf()!;
      const days = Math.max(1, Math.min(30, Math.floor(Number(dd.validDays) || 1)));
      const until = new Date(Math.min(this.clock.now() + days * 86_400_000, Date.parse(leaf.validUntil))).toISOString();
      const pc = leaf.credentialSubject.constraints;
      const tighten: Record<string, any> = {};
      if (pc.spendPerTx) tighten.spendPerTx = { ...pc.spendPerTx, max: amounts.perPayment!.toString() };
      if (pc.spendPerDay) tighten.spendPerDay = { ...pc.spendPerDay, budget: amounts.perDay!.toString() };
      if (pc.spendTotal) tighten.spendTotal = { ...pc.spendTotal, budget: amounts.total!.toString() };
      if (pc.categories) tighten.categories = { ...pc.categories, within: (dd.categories ?? []).map(String) };
      // A sub-agent's work is confirmed by the principal, never by itself or this agent.
      if (pc.attesters && "anyOf" in pc.attesters && pc.attesters.anyOf.includes(this.o.principal)) tighten.attesters = { ...pc.attesters, anyOf: [this.o.principal] };
      const r = await delegateMandate(this.chain, this.o.identity, this.clock, { subject: w.issuer, validUntil: until, status: reg.allocate(), tighten, purpose: String(dd.purpose).slice(0, 300), maxDepth: 0 });
      if ("problems" in r) {
        const v = decisionView({ outcome: "deny", reasons: r.problems, approver: null, actionHash: "", chain: [], parties: [...this.chain.map((m) => ({ issuer: m.issuer, subject: m.credentialSubject.id })), { issuer: this.did, subject: w.issuer }], policy: { id: "", hash: "" }, at: this.clock.iso() } as Decision, { name: (x) => this.nameOf(x), noun: "this delegation" });
        await this.log("agent/mandate-decision", { action: { type: "mandates/delegate", counterparty: w.issuer }, outcome: "deny", reasons: r.problems, sentences: v.sentences });
        return { ok: false, refused: v };
      }
      const child = r.mandate;
      const action = this.action("mandates/delegate", { spend: amounts.funding!.toString(), counterparty: w.issuer, child: mandateHash(child), asset: this.settle.directory.mint, task: taskUri("mandates/issue") });
      const d = await this.decide(action);
      const v = this.view(d, [], undefined, "this delegation");
      if (v.outcome !== "allow") {
        await this.logDecision(action, d, v, { witnessed: false });
        return { ok: false, refused: v };
      }
      const over = this.ledger.tryReserve(leaf, action.id, action.attrs.spend, this.clock.now(), action.type);
      if (over.length) {
        const view = this.view({ ...(d as Decision), outcome: "deny", reasons: over });
        await this.logDecision(action, d, view, { witnessed: false });
        return { ok: false, refused: view };
      }
      try {
        await this.logDecision(action, d, v, { witnessed: true });
      } catch {
        this.ledger.release(action.id);
        return { ok: false, error: "no witness receipted the decision (fail closed)" };
      }
      try {
        await this.settle.sendFromWallet(w.wallet, amounts.funding!);
      } catch (e) {
        this.ledger.release(action.id);
        await this.log("agent/budget", { event: "released", action: action.id, why: String((e as Error)?.message ?? e) });
        return { ok: false, error: `couldn't fund the sub-agent: ${String((e as Error)?.message ?? e)}` };
      }
      this.issued.push({ mandate: child, to: w.issuer, funded: amounts.funding!.toString() });
      await this.o.audit.appendWitnessed("agent/mandate-issued", { mandate: child, to: w.issuer, funded: amounts.funding!.toString() }).catch(() => this.log("agent/mandate-issued", { mandate: child, to: w.issuer, funded: amounts.funding!.toString(), witnessed: false }));
      await this.o.hub.putStatus(reg.sign());
      await sendMandate(this.settle.endpoint as never, w.issuer, { mandate: child, chain: this.chain });
      if (dd.task) await this.settle.endpoint.notify(w.issuer, TASK, { text: String(dd.task).slice(0, 2000) });
      await this.settle.endpoint.notify(this.o.principal, REPORT, { text: `Delegated to ${w.name}: ${dd.purpose}`, refs: { mandate: child, chain: this.chain } });
      this.note(`delegated to ${w.name} and funded it with ${usdc(amounts.funding!)}`);
      return { ok: true, value: { mandate: child.id, funded: usdc(amounts.funding!) } };
    });
  }

  async payments(): Promise<PaymentCard[]> {
    const out: PaymentCard[] = [];
    for (const [checkoutId, meta] of this.checkoutAction) {
      const c = this.settle.checkouts.get(checkoutId);
      const p = c?.paymentId ? this.settle.payments.get(c.paymentId) : undefined;
      const job = this.jobs.get(meta.job);
      out.push({
        payment: c?.paymentId ?? checkoutId,
        job: meta.job,
        with: job?.workerName ?? "?",
        title: c?.link.title ?? "",
        amount: c ? usdc(c.link.units) : "?",
        status: p?.settled ? `settled: ${usdc(p.settled.payeeUnits)} paid` : p?.escrow ? "held in escrow" : (c?.status ?? "?"),
        ...(p?.escrow ? { escrow: p.escrow } : {}),
        attestations: (p?.attestations ?? []).map((a) => `${this.nameOf(a.issuer)}: ${a.claim}${a.note ? ` (${a.note})` : ""}`),
      });
    }
    return out;
  }

  report(r: { text: string }): Promise<ToolResult<{}>> {
    return this.serial(async () => {
      const text = String(r?.text ?? "").slice(0, 2000);
      await this.settle.endpoint.notify(this.o.principal, REPORT, { text });
      await this.log("agent/report", { to: this.o.principal, text });
      return { ok: true, value: {} };
    });
  }

  // ================================================================ worker side

  private async onOffer(o: JobOffer, sender: string): Promise<void> {
    if (!o?.job || typeof o.job !== "string" || this.offers.has(o.job)) return;
    const reasons: string[] = [];
    const pass = await verifyPassport(o.passport, sender, this.clock);
    if (!pass.ok) reasons.push(`Their passport: ${pass.problem}.`);
    let verified = false;
    if (o.presentation) {
      const p = o.presentation;
      const d = await this.o.engine.verifyPresentation(p, { sender, me: this.did, status: this.o.status, requirements: this.o.workerRequirements ?? { passport: "required" }, clock: this.clock });
      const okAction = p.action?.type === "agents/job/offer" && p.action.attrs.counterparty === this.did && p.action.attrs.price === o.maxUnits && p.action.attrs.category === o.category;
      if (!okAction) reasons.push("The presentation is for a different offer.");
      if (d.outcome !== "allow") reasons.push(...this.view(d, [], undefined, "this offer").sentences);
      verified = okAction && d.outcome === "allow" && pass.ok;
    } else reasons.push("The offer came without a mandate presentation.");
    this.offers.set(o.job, { offer: o, hirer: sender, verified, verifiedText: reasons });
    await this.log("agent/job", { job: o.job, event: "offer-received", counterparty: sender, hirerVerified: verified, reasons });
    this.push({
      type: "offer",
      job: o.job,
      from: { name: String(o.hirerName ?? "").slice(0, 80), did: sender, operator: pass.operator ?? null },
      hirerVerified: verified,
      ...(verified ? {} : { why: reasons }),
      category: o.category,
      maxPrice: usdc(o.maxUnits),
      release: o.release?.kind === "attester" ? `confirmed by ${this.nameOf(o.release.attester)}` : "confirmed by the hirer",
      deliverable: o.deliverable,
      untrusted: { title: String(o.title).slice(0, 140), description: String(o.description).slice(0, 2000) },
    });
    this.note(`got a job offer from ${o.hirerName}: "${o.title}"${verified ? " (mandate verified)" : " (NOT verified)"}`);
  }

  quote(q: { job: string; price: string; note?: string }): Promise<ToolResult<{ link: string }>> {
    return this.serial(async () => {
      const job = this.offers.get(q?.job);
      if (!job) return { ok: false, error: `no job offer ${q?.job}` };
      const price = parseUsdc(q.price);
      if (price === null || price <= 0n) return { ok: false, error: "price must be an amount of USDC, like \"20\"" };
      const attester = job.offer.release.kind === "attester" ? job.offer.release.attester : job.hirer;
      const action = this.action("settle/get-paid", { price: price.toString(), counterparty: job.hirer, category: job.offer.category, attester, task: taskUri("agents/job/quote") });
      const d = await this.decide(action);
      const v = this.view(d, [], undefined, "this quote");
      await this.logDecision(action, d, v, { witnessed: false });
      if (v.outcome !== "allow") return { ok: false, refused: v };
      if (job.offer.deliverable === "git" && job.offer.repo && this.o.workspace) {
        try {
          await this.o.workspace.open(job.offer.job, job.offer.repo);
        } catch (e) {
          return { ok: false, error: String((e as Error).message) };
        }
      }
      const link = await this.settle.createLink({
        title: job.offer.title,
        units: price,
        release: job.offer.release.kind === "attester" ? "attester-confirms" : "payer-confirms",
        ...(job.offer.release.kind === "attester" ? { attester } : {}),
        disputeWindowDays: job.offer.disputeWindowDays,
      });
      job.link = link;
      await this.settle.endpoint.notify(job.hirer, JOB_QUOTE, { job: job.offer.job, link, ...(q.note ? { note: String(q.note).slice(0, 500) } : {}) });
      await this.log("agent/job", { job: job.offer.job, event: "quoted", counterparty: job.hirer, link: jcsHash(link), units: link.units });
      this.note(`quoted ${usdc(price)} to ${this.nameOf(job.hirer)}`);
      return { ok: true, value: { link: link.id } };
    });
  }

  decline(dd: { job: string; reason: string }): Promise<ToolResult<{}>> {
    return this.serial(async () => {
      const job = this.offers.get(dd?.job);
      if (!job) return { ok: false, error: `no job offer ${dd?.job}` };
      await this.settle.endpoint.notify(job.hirer, JOB_DECLINE, { job: dd.job, reason: String(dd.reason).slice(0, 500) });
      await this.log("agent/job", { job: dd.job, event: "declined", counterparty: job.hirer });
      return { ok: true, value: {} };
    });
  }

  deliver(dd: { job: string; note?: string }): Promise<ToolResult<{ commit?: string }>> {
    return this.serial(async () => {
      const job = this.offers.get(dd?.job);
      if (!job?.link) return { ok: false, error: `no quoted job ${dd?.job}` };
      const p = [...this.settle.payments.values()].find((x) => x.role === "payee" && x.link === job.link!.id && x.escrow && x.terms);
      if (!p?.terms) return { ok: false, error: "the hirer hasn't paid into escrow yet; wait for it in the inbox" };
      const action = this.action("agents/job/deliver", { counterparty: job.hirer, job: dd.job, task: taskUri("agents/job/deliver") });
      const d = await this.decide(action);
      const v = this.view(d, [], undefined, "this delivery");
      await this.logDecision(action, d, v, { witnessed: false });
      if (v.outcome !== "allow") return { ok: false, refused: v };
      let commit: string | undefined;
      if (job.offer.deliverable === "git") {
        if (!this.o.workspace || !job.offer.repo) return { ok: false, error: "no workspace for this job" };
        commit = await this.o.workspace.commit(`${job.offer.title} (${dd.job})`);
      }
      const termsH = hex(termsHash(p.terms));
      const payload: JobDeliver = { job: dd.job, termsHash: termsH, deliverable: commit ? { kind: "git", repo: job.offer.repo!, commit } : { kind: "note", text: String(dd.note ?? "done").slice(0, 1000) } };
      await this.settle.endpoint.notify(job.hirer, JOB_DELIVER, payload);
      if (job.offer.release.kind === "attester" && job.offer.release.attester !== job.hirer) await this.settle.endpoint.notify(job.offer.release.attester, JOB_DELIVER, payload);
      job.delivered = commit ?? "note";
      await this.log("agent/job", { job: dd.job, event: "delivered", counterparty: job.hirer, ...(commit ? { commit } : {}) });
      this.note(`delivered ${commit ? `commit ${short(commit)}` : "the job"} to ${this.nameOf(job.hirer)}`);
      return { ok: true, value: commit ? { commit } : {} };
    });
  }

  async readFile(f: { path: string }): Promise<ToolResult<{ text: string }>> {
    if (!this.o.workspace) return { ok: false, error: "this agent has no files" };
    try {
      return { ok: true, value: { text: this.o.workspace.read(f?.path) } };
    } catch (e) {
      return { ok: false, error: String((e as Error).message) };
    }
  }

  async writeFile(f: { path: string; text: string }): Promise<ToolResult<{ bytes: number }>> {
    if (!this.o.workspace) return { ok: false, error: "this agent has no files" };
    if (this.paused) return { ok: false, refused: guardRefusal("agent.paused", "The principal has paused this agent.") };
    try {
      return { ok: true, value: { bytes: this.o.workspace.write(f?.path, f?.text) } };
    } catch (e) {
      return { ok: false, error: String((e as Error).message) };
    }
  }

  async runTests(): Promise<ToolResult<{ passed: boolean; output: string }>> {
    if (!this.o.workspace) return { ok: false, error: "this agent has no files" };
    try {
      return { ok: true, value: await this.o.workspace.test() };
    } catch (e) {
      return { ok: false, error: String((e as Error).message) };
    }
  }
}

function describe(status: string): string {
  if (status === "escrow") return "paid into escrow";
  if (status.startsWith("settled:")) return `settled: ${usdc(status.split(":")[1])} paid out`;
  if (status.startsWith("attested:")) return `the attester said: ${status.split(":")[1]}`;
  return status;
}
