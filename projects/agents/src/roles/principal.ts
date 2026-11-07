/**
 * The principal's device (design §2, §9, §10.4, §13.2): issues and revokes mandates, keeps a status list,
 * approves or denies exact actions, confirms physical work, witnesses its agents' trails, and reviews them.
 * In the MVP it runs in Node; the console web page is its screen.
 */
import { ed25519Signer, httpWitnessClient, localWitnessClient, MemoryStore, onDisclose, serveWitnessTasks, verifyBundle, Witness, type Bundle } from "@zk-toip/eventlog";
import {
  approve,
  denyApproval,
  grantApproval,
  issueMandate,
  jcsHash,
  notifyRevoked,
  serveMandateTasks,
  StatusRegistry,
  type Action,
  type ApprovalRequestPayload,
  type Constraint,
  type Decision,
  type Mandate,
  type MandateEngine,
} from "@zk-toip/mandates";
import type { Clock, Identity } from "@zk-toip/trust-core";
import type { Party } from "@zk-toip/settle/src/agents/party";
import { CONTROL, REPORT, TASK, type ControlOp, type Report } from "../protocol/tasks";
import { decisionView } from "../guard/explain";
import type { DecisionView } from "../guard/api";
import type { HubClient } from "../hub/client";
import { usdc } from "../config";

export interface ApprovalItem {
  request: string;
  from: string;
  fromName: string;
  action: Action;
  actionHash: string;
  chain: Mandate[];
  decision: Decision;
  view: DecisionView;
  justification: string;
  expiresAt: string;
  receivedAt: string;
  state: "waiting" | "approved" | "denied";
}

export interface MandateItem {
  mandate: Mandate;
  chain: Mandate[];
  issuer: string;
  subject: string;
  revoked: boolean;
  funded?: string;
}

export interface AuditEntry {
  s: number;
  kind: string;
  dt: string;
  status: string;
  receipts: string[];
  body?: Record<string, unknown>;
}

export interface AuditView {
  agent: string;
  at: string;
  ok: boolean;
  entries: AuditEntry[];
  banner: string;
  problems: string[];
  duplicity: number;
  spent: { reserved: string; byAction: Record<string, string> };
  head?: { s: number; d: string };
  bundle: Bundle;
}

export class PrincipalDevice {
  readonly did: string;
  readonly witness: Witness;
  readonly registry: StatusRegistry;
  readonly mandates = new Map<string, MandateItem>();
  readonly approvals = new Map<string, ApprovalItem>();
  readonly reports: { from: string; name: string; text: string; at: string }[] = [];
  readonly audits = new Map<string, AuditView>();
  private readonly auditWaiters = new Map<string, (() => void)[]>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly party: Party,
    readonly identity: Identity,
    private readonly o: { clock: Clock; hub: HubClient; hubWitness: { url: string; aid: string }; engine: MandateEngine; names: (did: string) => string; onNote?: (t: string) => void },
  ) {
    this.did = identity.did;
    this.registry = new StatusRegistry(identity, o.clock);
    // The console's witness signs with the principal's own key, so its did:key is the principal's.
    this.witness = new Witness({ signer: ed25519Signer(identity.signingSecret), store: new MemoryStore(), clock: o.clock });
  }

  private note(t: string) {
    this.o.onNote?.(t);
  }

  async start(): Promise<void> {
    serveWitnessTasks(this.party.endpoint, this.witness);
    serveMandateTasks(this.party.endpoint, {
      clock: this.o.clock,
      engine: this.o.engine,
      onApprovalRequest: (r) => this.onApprovalRequest(r),
    });
    this.party.endpoint.handle<Report, void>(REPORT, async (doc, { sender }) => this.onReport(doc.payload, sender));
    onDisclose(this.party.endpoint, (bundle, from) => this.onDisclosed(bundle, from));
    await this.publishStatus();
    // Re-sign often: verifiers refuse a list older than an hour (decision 3).
    this.timer = setInterval(() => void this.publishStatus().catch(() => undefined), 10 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  publishStatus(): Promise<void> {
    return this.o.hub.putStatus(this.registry.sign());
  }

  /** The demo's root mandate (design §7.1), or one built from the console's form. */
  issueRoot(o: {
    agent: string;
    purpose: string;
    perPayment: bigint;
    perDay: bigint;
    total: bigint;
    categories: string[];
    attesters: string[];
    arbiter: string;
    mint: string;
    validDays: number;
    maxDepth: number;
  }): Mandate {
    const constraints: Record<string, Constraint> = {
      actions: { attr: "type", anyOf: ["settle/pay", "settle/attest", "settle/dispute", "agents/job/offer", "mandates/delegate"] },
      asset: { attr: "asset", anyOf: [o.mint], when: ["settle/pay", "mandates/delegate"] },
      spendPerTx: { attr: "spend", max: o.perPayment.toString(), when: ["settle/pay"] },
      spendPerDay: { attr: "spend", budget: o.perDay.toString(), period: "P1D" },
      spendTotal: { attr: "spend", budget: o.total.toString(), period: "total" },
      categories: { attr: "category", within: o.categories, when: ["settle/pay", "agents/job/offer"] },
      attesters: { attr: "attester", anyOf: o.attesters, when: ["settle/pay"] },
      arbiters: { attr: "arbiter", anyOf: [o.arbiter], when: ["settle/pay"] },
      minWindow: { attr: "disputeWindowSeconds", min: 0, when: ["settle/pay"] },
      tasks: { attr: "task", within: ["https://zk-toip.example/spec/settle/*", "https://zk-toip.example/spec/agents/*", "https://zk-toip.example/spec/mandates/*"] },
    };
    const m = issueMandate(this.identity, this.o.clock, {
      subject: o.agent,
      validUntil: new Date(this.o.clock.now() + o.validDays * 86_400_000).toISOString(),
      status: this.registry.allocate(),
      profile: "settle/1",
      purpose: o.purpose,
      constraints,
      delegation: { maxDepth: o.maxDepth },
      escalation: { approvable: ["spendPerTx", "spendPerDay", "categories"], approvalTtlSeconds: 3600 },
      revocation: { maxAgeSeconds: 3600 },
    });
    this.mandates.set(m.id, { mandate: m, chain: [m], issuer: this.did, subject: o.agent, revoked: false });
    return m;
  }

  async sendMandate(m: Mandate): Promise<void> {
    const { sendMandate } = await import("@zk-toip/mandates");
    await this.publishStatus();
    await sendMandate(this.party.endpoint, m.credentialSubject.id, { mandate: m, chain: [] });
    this.note(`issued a mandate to ${this.o.names(m.credentialSubject.id)}`);
  }

  async fund(wallet: string, units: bigint, agent: string): Promise<void> {
    await this.party.sendFromWallet(wallet as never, units);
    for (const it of this.mandates.values()) if (it.subject === agent && it.issuer === this.did) it.funded = usdc(units);
    this.note(`moved ${usdc(units)} into ${this.o.names(agent)}'s wallet`);
  }

  async sendTask(agent: string, text: string): Promise<void> {
    await this.party.endpoint.notify(agent, TASK, { text });
  }

  async control(agent: string, op: ControlOp, mandate?: string): Promise<void> {
    await this.party.endpoint.notify(agent, CONTROL, { op, ...(mandate ? { mandate } : {}) });
  }

  private async onApprovalRequest(r: ApprovalRequestPayload & { sender: string }): Promise<void> {
    if (this.approvals.has(r.request)) return;
    // C7: the screen renders the action itself; the agent's justification is shown as its words.
    const view = decisionView(r.decision, { name: this.o.names });
    this.approvals.set(r.request, {
      request: r.request,
      from: r.sender,
      fromName: this.o.names(r.sender),
      action: r.action,
      actionHash: r.actionHash,
      chain: r.chain,
      decision: r.decision,
      view,
      justification: String(r.justification ?? "").slice(0, 1000),
      expiresAt: r.expiresAt,
      receivedAt: this.o.clock.iso(),
      state: "waiting",
    });
    this.note(`was asked by ${this.o.names(r.sender)} to approve ${usdc(String(r.action.attrs.spend))} to ${this.o.names(String(r.action.attrs.counterparty))}`);
  }

  /** Signs an approval of the exact action requested, bound to its hash, for at most the leaf's approval TTL. */
  async approve(request: string): Promise<void> {
    const a = this.approvals.get(request);
    if (!a || a.state !== "waiting") throw new Error("no such waiting request");
    if (jcsHash(a.action) !== a.actionHash) throw new Error("the request's action doesn't match its hash");
    const ttl = Math.min(a.chain[a.chain.length - 1]?.credentialSubject.escalation?.approvalTtlSeconds ?? 3600, 3600);
    const approval = approve(this.identity, this.o.clock, { chain: a.chain, action: a.action, ttlSeconds: ttl });
    a.state = "approved";
    await grantApproval(this.party.endpoint, a.from, { request, approval });
    this.note(`approved request ${request}`);
  }

  async deny(request: string, reason?: string): Promise<void> {
    const a = this.approvals.get(request);
    if (!a || a.state !== "waiting") throw new Error("no such waiting request");
    a.state = "denied";
    await denyApproval(this.party.endpoint, a.from, { request, ...(reason ? { reason } : {}) });
  }

  private async onReport(r: Report, sender: string): Promise<void> {
    const text = String(r?.text ?? "").slice(0, 2000);
    this.reports.push({ from: sender, name: this.o.names(sender), text, at: this.o.clock.iso() });
    // A delegation report carries the child mandate: keep it if its chain is rooted here and verifies.
    const m = r?.refs?.mandate as Mandate | undefined;
    const chain = r?.refs?.chain as Mandate[] | undefined;
    if (m && Array.isArray(chain) && chain[0]?.issuer === this.did && m.issuer === sender) {
      const reasons = await this.o.engine.checkChain({ chain: [...chain, m], presenter: m.credentialSubject.id, clock: this.o.clock });
      if (!reasons.length) this.mandates.set(m.id, { mandate: m, chain: [...chain, m], issuer: sender, subject: m.credentialSubject.id, revoked: false });
    }
  }

  /**
   * Revokes a mandate. One this device issued: set the bit, publish, tell the agent. One its agent issued to a
   * sub-agent: ask that agent's guard to revoke it (agents/control), since only its issuer can sign its list.
   */
  async revoke(id: string): Promise<void> {
    const it = this.mandates.get(id);
    if (!it) throw new Error("no such mandate");
    if (it.issuer === this.did) {
      this.registry.revoke(it.mandate.credentialStatus);
      const list = this.registry.sign();
      await this.o.hub.putStatus(list);
      await notifyRevoked(this.party.endpoint, it.subject, { mandate: id, statusList: list });
    } else {
      await this.control(it.issuer, "revoke", id);
    }
    it.revoked = true;
    for (const other of this.mandates.values()) if (other.chain.some((m) => m.id === id)) other.revoked = true;
    this.note(`revoked the mandate to ${this.o.names(it.subject)}`);
  }

  /** Payments that name this principal to confirm the work. */
  toConfirm() {
    return this.party.list().filter((p) => p.role === "attester" && p.terms && !p.settled);
  }

  async attest(paymentId: string, note: string): Promise<void> {
    await this.party.attest(paymentId, "complete", note);
  }

  /** Asks an agent for its whole trail with bodies, and waits for it (up to `ms`). */
  async review(agent: string, ms = 15_000): Promise<AuditView | undefined> {
    const got = new Promise<void>((resolve) => {
      const list = this.auditWaiters.get(agent) ?? [];
      list.push(resolve);
      this.auditWaiters.set(agent, list);
      setTimeout(resolve, ms).unref?.();
    });
    await this.control(agent, "disclose");
    await got;
    return this.audits.get(agent);
  }

  private async onDisclosed(bundle: Bundle, from: string): Promise<void> {
    const witnesses = [localWitnessClient(this.witness), httpWitnessClient(this.o.hubWitness.url, this.o.hubWitness.aid)];
    const r = await verifyBundle(bundle, { expectDid: from, witnesses, clock: this.o.clock });
    const trail = r.trails[0];
    const bodies = new Map<string, Record<string, unknown>>();
    for (const t of bundle.trails) for (const b of t.bodies ?? []) bodies.set(String(b.d), b as Record<string, unknown>);
    const mine = this.witness.aid;
    const hubAid = this.o.hubWitness.aid;
    const entries: AuditEntry[] = (trail?.entries ?? []).map((e) => ({
      s: e.s,
      kind: e.t === "tin" ? "trail/opened" : e.kind,
      dt: e.dt,
      status: e.status,
      receipts: e.receipts.map((x) => (x.witness === mine ? "you" : x.witness === hubAid ? "the hub" : x.witness.slice(0, 8))),
      ...(e.a && bodies.get(e.a) ? { body: bodies.get(e.a) } : {}),
    }));
    const duplicity = (await this.witness.evidence()).length + (trail?.evidence.length ?? 0);
    const byYou = entries.filter((e) => e.receipts.includes("you")).length;
    const byHub = entries.filter((e) => e.receipts.includes("the hub")).length;
    let reserved = 0n;
    const byAction: Record<string, string> = {};
    for (const e of entries) {
      const b = e.body as { event?: string; action?: string; spend?: string; units?: string } | undefined;
      if (e.kind !== "agent/budget" || !b?.action) continue;
      if (b.event === "reserved" && b.spend) byAction[b.action] = b.spend;
      if (b.event === "released") delete byAction[b.action];
      if (b.event === "refunded" && b.units && byAction[b.action]) byAction[b.action] = String(BigInt(byAction[b.action]) - BigInt(b.units));
    }
    for (const v of Object.values(byAction)) reserved += BigInt(v);
    const ok = r.ok && duplicity === 0;
    const banner = ok
      ? `${entries.length} entries, chain intact, receipted by you (${byYou}) and the hub (${byHub}), no duplicity`
      : `${entries.length} entries; ${r.problems.length} problem(s)${duplicity ? `, ${duplicity} duplicity report(s)` : ""}`;
    this.audits.set(from, {
      agent: from,
      at: this.o.clock.iso(),
      ok,
      entries,
      banner,
      problems: r.problems.map((p) => `${p.code}: ${p.message}`),
      duplicity,
      spent: { reserved: reserved.toString(), byAction },
      ...(trail?.head ? { head: trail.head } : {}),
      bundle,
    });
    for (const w of this.auditWaiters.get(from) ?? []) w();
    this.auditWaiters.delete(from);
  }
}
