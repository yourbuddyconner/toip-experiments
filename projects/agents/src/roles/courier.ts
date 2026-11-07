/**
 * A human worker's device (design §2, §11.3): Dana the courier. Her Settle party checks every agent's mandate
 * before it invoices and before it agrees terms. Her view shows each offer with the verified chain behind it,
 * lets her quote and deliver, and shows who stands behind each payment. In the MVP it runs in Node; the
 * courier web page is her screen.
 */
import type { WitnessClient } from "@zk-toip/eventlog";
import type { MandateEngine, Presentation, StatusResolver } from "@zk-toip/mandates";
import type { Clock, Identity } from "@zk-toip/trust-core";
import type { Party, PaymentLink } from "@zk-toip/settle/src/agents/party";
import { JOB_DELIVER, JOB_OFFER, JOB_QUOTE, JOB_REFUSED, type JobOffer } from "../protocol/tasks";
import { mandateGates, type MandateGates } from "../guard/gates";
import { decisionView } from "../guard/explain";
import { verifyPassport } from "../passport";
import { usdc } from "../config";
import { hex } from "@zk-toip/settle/src/agents/base";
import { termsHash } from "@zk-toip/settle/src/protocol/documents";

export interface OfferItem {
  job: string;
  from: string;
  fromName: string;
  title: string;
  description: string;
  category: string;
  maxPrice: string;
  confirmedBy: string;
  /** Who the offer named to confirm the work; null when the hirer confirms itself. */
  attester: string | null;
  verified: boolean;
  chain: string[];
  sentences: string[];
  receivedAt: string;
  link?: PaymentLink;
  delivered?: string;
}

export class Courier {
  readonly offers = new Map<string, OfferItem>();
  readonly gates: MandateGates;
  readonly refusals: { from: string; title: string; reasons: string[]; at: string }[] = [];

  constructor(
    readonly party: Party,
    readonly identity: Identity,
    private readonly o: {
      engine: MandateEngine;
      status: StatusResolver;
      clock: Clock;
      names: (did: string) => string;
      verifier: string;
      witness?: WitnessClient;
      /** Quote and deliver without a person, for headless runs. */
      auto?: { price: bigint; note: string; deliverNote: string };
      onNote?: (t: string) => void;
    },
  ) {
    this.gates = mandateGates({
      me: identity,
      engine: o.engine,
      status: o.status,
      requirements: { rootMustHold: [`VerifiedBusiness@${o.verifier}`], passport: "required", maxLinks: 3 },
      clock: o.clock,
      mint: party.directory.mint,
      arbiter: party.directory.arbiter.did,
      feeFor: (p) => party.feeFor(p),
      name: o.names,
      ...(o.witness ? { witness: o.witness } : {}),
      onRefused: ({ sender, link, reasons }) => {
        this.refusals.push({ from: sender, title: link.title, reasons, at: o.clock.iso() });
        const job = [...this.offers.values()].find((x) => x.link?.id === link.id)?.job;
        void party.endpoint.notify(sender, JOB_REFUSED, { job: job ?? "", link: link.id, reasons }).catch(() => undefined);
        o.onNote?.(`Dana's device refused to invoice ${o.names(sender)}: ${reasons[0]}`);
      },
      onAllowed: (r) => o.onNote?.(`Dana's device checked ${o.names(r.sender)}'s mandate: ${this.chainText(r.presentation)}`),
    });
  }

  start(): void {
    this.party.gates = this.gates;
    this.party.endpoint.handle<JobOffer, void>(JOB_OFFER, async (doc, { sender }) => this.onOffer(doc.payload, sender));
    if (this.o.auto) {
      const t = setInterval(() => void this.autoDeliver().catch(() => undefined), 500);
      t.unref?.();
      this.stopAuto = () => clearInterval(t);
    }
  }
  stopAuto = () => {};

  /** "Errands agent, for Ops agent, for Conner Swann. Chain of 2 verified, approval by Conner Swann, root verified." */
  chainText(p: Presentation): string {
    const names = [...p.chain].reverse().map((m) => this.o.names(m.credentialSubject.id));
    names.push(this.o.names(p.chain[0]?.issuer ?? ""));
    const approvals = (p.approvals ?? []).map((a) => this.o.names(a.issuer));
    const root = (p.rootCredentials ?? []).some((c) => c.type?.includes("VerifiedBusiness") && c.issuer === this.o.verifier);
    return `${names[0]}, ${names.slice(1).map((n) => `for ${n}`).join(", ")}. Chain of ${p.chain.length} verified${approvals.length ? `, approval by ${approvals.join(", ")}` : ""}${root ? ", root verified" : ""}.`;
  }

  private async onOffer(o: JobOffer, sender: string): Promise<void> {
    if (!o?.job || this.offers.has(o.job)) return;
    const pass = await verifyPassport(o.passport, sender, this.o.clock);
    let verified = false;
    let sentences: string[] = [];
    let chain: string[] = [];
    if (o.presentation) {
      const d = await this.o.engine.verifyPresentation(o.presentation, { sender, me: this.identity.did, status: this.o.status, requirements: { rootMustHold: [`VerifiedBusiness@${this.o.verifier}`], passport: "required" }, clock: this.o.clock });
      const v = decisionView(d, { name: this.o.names, noun: "this offer" });
      const matches = o.presentation.action?.type === "agents/job/offer" && o.presentation.action.attrs.counterparty === this.identity.did && o.presentation.action.attrs.price === o.maxUnits;
      verified = d.outcome === "allow" && matches && pass.ok;
      sentences = matches ? v.sentences : ["The presentation is for a different offer.", ...v.sentences];
      chain = o.presentation.chain.map((m) => `${this.o.names(m.issuer)} → ${this.o.names(m.credentialSubject.id)}`);
    } else sentences = ["The offer came without a mandate presentation."];
    if (!pass.ok) sentences.push(`Passport: ${pass.problem}.`);
    this.offers.set(o.job, {
      job: o.job,
      from: sender,
      fromName: this.o.names(sender),
      title: String(o.title).slice(0, 140),
      description: String(o.description).slice(0, 2000),
      category: String(o.category),
      maxPrice: usdc(o.maxUnits),
      confirmedBy: o.release?.kind === "attester" ? this.o.names(o.release.attester) : this.o.names(sender),
      attester: o.release?.kind === "attester" ? o.release.attester : null,
      verified,
      chain,
      sentences,
      receivedAt: this.o.clock.iso(),
    });
    this.o.onNote?.(`Dana got an offer from ${this.o.names(sender)}: "${o.title}"`);
    if (this.o.auto && verified) setTimeout(() => void this.quote(o.job, this.o.auto!.price, this.o.auto!.note).catch(() => undefined), 300);
  }

  /** Quotes a price for an offer: a signed payment link, confirmed by whoever the offer named. */
  async quote(job: string, price: bigint, note: string): Promise<PaymentLink> {
    const it = this.offers.get(job);
    if (!it) throw new Error("no such offer");
    if (it.link) throw new Error("already quoted");
    const link = await this.party.createLink({
      title: it.title,
      units: price,
      release: it.attester ? "attester-confirms" : "payer-confirms",
      ...(it.attester ? { attester: it.attester } : {}),
      disputeWindowDays: 0,
    });
    it.link = link;
    await this.party.endpoint.notify(it.from, JOB_QUOTE, { job, link, note });
    this.o.onNote?.(`Dana quoted ${usdc(price)}`);
    return link;
  }

  /** The payment for an offer, once the agent has paid into escrow. */
  paymentFor(job: string) {
    const it = this.offers.get(job);
    return it?.link ? this.party.list().find((p) => p.role === "payee" && p.link === it.link!.id) : undefined;
  }

  async deliver(job: string, text: string): Promise<void> {
    const it = this.offers.get(job);
    const p = this.paymentFor(job);
    if (!it || !p?.terms || !p.escrow) throw new Error("not paid into escrow yet");
    await this.party.endpoint.notify(it.from, JOB_DELIVER, { job, termsHash: hex(termsHash(p.terms)), deliverable: { kind: "note", text } });
    it.delivered = text;
    this.o.onNote?.(`Dana delivered: "${text}"`);
  }

  private async autoDeliver(): Promise<void> {
    for (const it of this.offers.values()) {
      if (it.delivered || !it.link) continue;
      const p = this.paymentFor(it.job);
      if (p?.escrow) await this.deliver(it.job, this.o.auto!.deliverNote);
    }
  }

  /** Who stands behind a payment, from the presentation Dana's device checked. */
  behind(paymentId: string): string | null {
    const p = this.party.payments.get(paymentId);
    const rec = p?.terms ? this.gates.byTerms(hex(termsHash(p.terms))) : undefined;
    return rec ? `Paid by ${this.chainText(rec.presentation)}${rec.trailChecked ? " The agent's decision is witnessed." : ""}` : null;
  }
}
