/**
 * A Settle party: one person or business that pays, gets paid, and confirms other people's work
 * (design §3, §10, §17). It runs on the party's own device, in a browser tab or a Node process, and
 * decides everything for itself: it checks what it's told against the chain, and signs only what its
 * policy allows.
 */
import { canonicalJson, fromB64u, signDocument, toB64u, utf8, verifyDocument, type Clock, type Credential } from "@toip-tools/trust-core";
import { createNoopSigner, generateKeyPairSigner, type Address } from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { claimInstruction, escrowAddress, openInstruction, reclaimInstruction, STATE, type EscrowState } from "../chain/escrow";
import { tokenAmount, type Chain } from "../chain/chain";
import { paymentKeyFromSeed, type PaymentKey } from "../chain/keys";
import { buildForSponsor } from "../chain/tx";
import {
  accept,
  attest,
  bindPaymentKey,
  derivePaymentKey,
  dispute,
  facilitatorFee,
  receipt,
  termsHash,
  verifyAcceptance,
  verifyBinding,
  verifyCredential,
  verifySigned,
  type Acceptance,
  type Attestation,
  type Dispute,
  type Evidence,
  type Terms,
} from "../protocol/documents";
import {
  ARBITER_RULING,
  CHECKOUT_START,
  ESCROW_ATTEST,
  ESCROW_DISPUTE,
  ESCROW_OPENED,
  ESCROW_SETTLED,
  ESCROW_SIGN,
  PAYMENT_RECEIPT,
  PAYMENT_REQUEST,
  PROCESSOR_SUBMIT,
  TERMS_ACCEPT,
  TERMS_PROPOSE,
} from "../protocol/specs";
import { Agent, escrowProblems, genuineOpening, hex, verifyOutcomeSignature, type AgentOptions, type OutcomeSignature, type PaymentState } from "./base";
import type { OfferPayload, OpenedPayload, RulingPayload, SettledPayload, SubmitPayload, SubmitResult } from "./messages";

const units = (n: string | bigint) => BigInt(n);
export const usdc = (u: string | bigint) => `${(Number(units(u)) / 1e6).toFixed(2)} USDC`;
/** The least time between the end of a dispute window and the payer's reclaim deadline, for arbitration. */
const ARBITRATION_MARGIN_SECONDS = 14 * 86400;
/** How long after the dispute window a payer can take its money back if nothing happens. */
export const RECLAIM_AFTER_WINDOW_DAYS = 30;

// ---------------------------------------------------------------- payment links

/**
 * A payment link (design §17): the payee's signed offer to anyone who opens it. It travels in the URL,
 * so a checkout page can check who issued it and what it promises without asking any server.
 */
export interface PaymentLink {
  type: "settle/payment-link";
  issuer: string;
  id: string;
  /** The payee's own name for itself. */
  name: string;
  title: string;
  units: string;
  /** Who confirms the work is done: the payer itself, or a named third party. */
  release: "payer-confirms" | "attester-confirms";
  attester?: string;
  attesterName?: string;
  disputeWindowDays: number;
  credentials: Credential[];
  created: string;
  proof?: unknown;
}

export const encodeLink = (l: PaymentLink): string => toB64u(utf8(JSON.stringify(l)));
export function decodeLink(s: string): PaymentLink | null {
  try {
    const l = JSON.parse(new TextDecoder().decode(fromB64u(s)));
    return l?.type === "settle/payment-link" ? (l as PaymentLink) : null;
  } catch {
    return null;
  }
}
export async function verifyLink(l: PaymentLink, clock: Clock): Promise<boolean> {
  if (l?.type !== "settle/payment-link" || !/^\d+$/.test(l.units) || units(l.units) <= 0n) return false;
  if (l.release === "attester-confirms" && !l.attester) return false;
  if (!Number.isInteger(l.disputeWindowDays) || l.disputeWindowDays < 0 || l.disputeWindowDays > 90) return false;
  return (await verifyDocument(l, clock)).valid;
}

export interface Checkout {
  id: string;
  link: PaymentLink;
  status: "contacting" | "funding" | "proposed" | "opened" | "failed";
  paymentId?: string;
  error?: string;
  at: string;
}

/** Everything a party needs to pick up where it left off. Keys aren't in it: they're re-derived from the identity. */
export interface PartySnapshot {
  v: 1;
  did: string;
  payments: PaymentState[];
  requests: [string, { offer: OfferPayload; from: string }][];
  offers: [string, OfferPayload & { to: string }][];
  tokens: Record<string, Address>;
  receipts: Credential[];
  events: Party["events"];
  checkouts: Checkout[];
  links: { link: PaymentLink; archived: boolean }[];
  credentials: Credential[];
  names: Record<string, string>;
}

/**
 * Checks a payee runs before it invoices and before it agrees terms (agents design §11.3, S1). A party
 * without gates behaves as before. Gates must not await a TSP request: they run inside Settle's handlers.
 */
export interface PayeeGates {
  /** On settle/checkout/start, after Settle's own checks. Return null to invoice, or a reason to refuse. */
  beforeInvoice?(c: { link: PaymentLink; sender: string; attachments: unknown; checkout: string }): Promise<string | null>;
  /** On payment/terms/propose. Any problem refuses the terms. `link` and `checkout` name the invoice's origin, if any. */
  beforeAccept?(c: { terms: Terms; sender: string; link?: string; checkout?: string }): Promise<string[]>;
}

export interface PartyOptions extends AgentOptions {
  /** Called whenever the party's state changes, e.g. to save it and redraw a page. */
  onChange?: () => void;
}

/** Network fees a key keeps on hand: a few transactions' worth (5,000 lamports a signature). */
const FEE_FLOAT = 50_000n;

export class Party extends Agent {
  readonly credentials: Credential[] = [];
  /** The most this party accepts the processor charging when it's the payee (the payer pays it, but it's part of the deal). */
  maxFeeBps = 200;
  maxMinFeeUnits = 2_000_000n;
  /** Invoices this party received, as a payer. */
  readonly requests = new Map<string, { offer: OfferPayload; from: string }>();
  readonly receipts: Credential[] = [];
  /** Which credential issuers this party trusts to vouch for businesses and licenses. */
  trustedLicensers: string[] = [];
  /** Payer: refuse to agree terms unless the payee holds a trusted license (the repair-job flow). */
  requireLicense = true;
  /**
   * Act without a person clicking: as payee, ask for release as soon as the work is attested complete;
   * as payer, re-check waiting release requests on every tick and sign once the policy allows.
   */
  autoRelease = false;
  readonly checkouts = new Map<string, Checkout>();
  readonly links = new Map<string, { link: PaymentLink; archived: boolean }>();
  /** Payee-side checks added by an integration, such as a mandate check for agent payers (S1). */
  gates?: PayeeGates;
  wallet?: { key: PaymentKey; token: Address };
  private readonly keys = new Map<string, { key: PaymentKey; token: Address }>();
  private readonly offers = new Map<string, OfferPayload & { to: string }>();
  private feePayer?: Address;
  private readonly onChange?: () => void;

  constructor(opts: PartyOptions) {
    super(opts);
    this.onChange = opts.onChange;
    const on = <P>(spec: Parameters<typeof this.endpoint.handle>[0], fn: (payload: P, sender: string) => Promise<void>) =>
      this.endpoint.handle<P, void>(spec, (doc, ctx) => this.task(() => fn.call(this, doc.payload, ctx.sender)));
    on(PAYMENT_REQUEST, this.onRequest);
    on(TERMS_PROPOSE, this.onTerms);
    on(TERMS_ACCEPT, this.onAccept);
    on(ESCROW_OPENED, this.onOpened);
    on(ESCROW_ATTEST, this.onAttest);
    on(ESCROW_DISPUTE, this.onDispute);
    on(ESCROW_SIGN, this.onSign);
    on(ARBITER_RULING, this.onRuling);
    on(ESCROW_SETTLED, this.onSettled);
    on(PAYMENT_RECEIPT, this.onReceipt);
    on(CHECKOUT_START, this.onCheckout);
  }

  /** Runs `fn` in this party's queue, then reports the change. */
  protected task<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(fn).finally(() => this.onChange?.());
  }

  protected override say(text: string): void {
    super.say(text);
    this.onChange?.();
  }

  /** Says something about one payment, and keeps it in that payment's own timeline. */
  private note(p: PaymentState, text: string): void {
    (p.timeline ??= []).push({ at: this.clock.iso(), text });
    if (p.timeline.length > 100) p.timeline.shift();
    this.say(text);
  }

  private learnName(did: string, name?: string): void {
    if (name && did !== this.did && !this.directory.names[did]) this.directory.names[did] = String(name).slice(0, 80);
  }

  /** Sends to each recipient once, never to itself. */
  private async sendAll(to: Iterable<string>, spec: Parameters<typeof this.endpoint.notify>[1], payload: unknown): Promise<void> {
    for (const d of new Set(to)) if (d && d !== this.did) await this.endpoint.notify(d, spec, payload);
  }

  /** The processor's fee-payer address, as the processor publishes it. */
  setProcessorFeePayer(a: Address): void {
    this.feePayer = a;
  }
  private processorFeePayer(): Address {
    if (!this.feePayer) throw new Error("processor fee payer unknown");
    return this.feePayer;
  }

  tokenAccount(paymentId: string): Address | undefined {
    return this.keys.get(paymentId)?.token;
  }

  /** This party's payments, newest first. */
  list(): PaymentState[] {
    return [...this.payments.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }

  // ================================================================ wallet

  /**
   * The party's wallet: a Solana key and a USDC account, both derived from its identity, so a device that
   * holds the identity always finds the same wallet. Creates the token account on first use.
   */
  async openWallet(): Promise<{ key: PaymentKey; token: Address }> {
    if (this.wallet) return this.wallet;
    const seed = (label: string) => sha256(new Uint8Array([...this.identity.signingSecret, ...utf8(label)]));
    const key = await paymentKeyFromSeed(seed("settle/wallet/v1"));
    const tokenKey = await paymentKeyFromSeed(seed("settle/wallet-token/v1"));
    if (!(await this.chain.exists(tokenKey.address))) {
      await this.ensureSol(key.address, (await this.chain.rent(165)) + FEE_FLOAT * 2n);
      await this.chain.createTokenAccount(this.directory.mint, key.address, key.signer, tokenKey.signer);
    }
    this.wallet = { key, token: tokenKey.address };
    return this.wallet;
  }

  /** A token account for a payment key, with SOL for its rent and the fee to move its money on later. */
  private async tokenAccountFor(key: PaymentKey): Promise<Address> {
    await this.ensureSol(key.address, (await this.chain.rent(165)) + FEE_FLOAT);
    return this.chain.createTokenAccount(this.directory.mint, key.address, key.signer, await generateKeyPairSigner());
  }

  async walletBalance(): Promise<bigint> {
    return this.wallet ? this.chain.balance(this.wallet.token) : 0n;
  }

  /** Moves money that has finished moving (paid out, refunded, never escrowed) from payment accounts to the wallet. */
  collectToWallet(): Promise<bigint> {
    return this.task(async () => {
      const w = await this.openWallet();
      let total = 0n;
      for (const [id, k] of this.keys) {
        const p = this.payments.get(id);
        if (!p || (p.role === "payer" && !p.escrow && !p.cancelled)) continue;
        const bal = await this.chain.balance(k.token);
        if (bal === 0n) continue;
        await this.ensureSol(k.key.address, FEE_FLOAT / 5n);
        const r = await this.chain.transfer(k.token, w.token, k.key.signer, bal);
        if (!r.ok) continue;
        total += bal;
        p.balance = "0";
        this.note(p, `moved ${usdc(bal)} to the wallet`);
      }
      return total;
    });
  }

  /**
   * Sends USDC from this party's wallet to a token account (S2): a principal funding an agent, or an agent
   * funding a sub-agent. Runs in the party's queue and notes it.
   */
  sendFromWallet(to: Address, amount: bigint): Promise<void> {
    return this.task(async () => {
      if (amount <= 0n) throw new Error("the amount must be more than zero");
      const w = await this.openWallet();
      if (to === w.token) throw new Error("that is this party's own wallet");
      const have = await this.chain.balance(w.token);
      if (have < amount) throw new Error(`not enough in the wallet: ${usdc(have)} of ${usdc(amount)}`);
      await this.ensureSol(w.key.address, FEE_FLOAT / 5n);
      const r = await this.chain.transfer(w.token, to, w.key.signer, amount);
      if (!r.ok) throw new Error(`couldn't send ${usdc(amount)}: ${r.error.split("\n")[0]}`);
      this.say(`sent ${usdc(amount)} from the wallet to ${to.slice(0, 8)}…`);
    });
  }

  // ================================================================ payee

  /** Creates a payment link anyone can open to pay this party. */
  createLink(o: { title: string; units: bigint; release: PaymentLink["release"]; attester?: string; disputeWindowDays?: number }): Promise<PaymentLink> {
    return this.task(async () => {
      if (o.units <= 0n) throw new Error("the amount must be more than zero");
      if (o.release === "attester-confirms" && (!o.attester || o.attester === this.did)) throw new Error("name someone else to confirm the work");
      const link = signDocument(
        {
          type: "settle/payment-link" as const,
          issuer: this.did,
          id: `link-${crypto.randomUUID()}`,
          name: this.name,
          title: o.title.trim().slice(0, 140),
          units: o.units.toString(),
          release: o.release,
          ...(o.release === "attester-confirms" ? { attester: o.attester, attesterName: this.nameOf(o.attester!) } : {}),
          disputeWindowDays: o.disputeWindowDays ?? 0,
          credentials: this.credentials,
          created: this.clock.iso(),
        },
        this.identity,
        this.clock,
      ) as PaymentLink;
      this.links.set(link.id, { link, archived: false });
      this.say(`created a payment link: "${link.title}", ${usdc(link.units)}`);
      return link;
    });
  }

  archiveLink(id: string): void {
    const l = this.links.get(id);
    if (l) l.archived = true;
    this.onChange?.();
  }

  /** Sends an invoice with this party's credentials and a fresh payment key for it. */
  request(payerDid: string, purpose: string, amountUnits: bigint): Promise<string> {
    return this.task(() => this.invoice(payerDid, purpose, amountUnits));
  }

  private async invoice(payerDid: string, purpose: string, amountUnits: bigint, extra: Pick<OfferPayload, "link" | "checkout" | "conditions"> = {}): Promise<string> {
    const id = `pay-${crypto.randomUUID()}`;
    const key = await derivePaymentKey(this.identity, id);
    const token = await this.tokenAccountFor(key);
    this.keys.set(id, { key, token });
    const offer: OfferPayload = {
      payment: id,
      purpose,
      units: amountUnits.toString(),
      payee: { did: this.did, paymentKey: key.address, tokenAccount: token, binding: bindPaymentKey(this.identity, key, id, this.clock) },
      credentials: this.credentials,
      name: this.name,
      ...extra,
    };
    this.offers.set(id, { ...offer, to: payerDid });
    const p = this.payment(id);
    Object.assign(p, { role: "payee", counterparty: payerDid, purpose, units: offer.units, createdAt: this.clock.iso(), link: extra.link, checkout: extra.checkout });
    await this.endpoint.notify(payerDid, PAYMENT_REQUEST, offer);
    this.note(p, `sent an invoice to ${this.nameOf(payerDid)}: "${purpose}", ${usdc(amountUnits)}, with ${this.credentials.length} credential(s)`);
    return id;
  }

  /** Someone opened one of this party's payment links and wants to pay: invoice them under the link's conditions. */
  private async onCheckout(m: { link: PaymentLink; checkout: string; name?: string; attachments?: unknown }, sender: string): Promise<void> {
    const l = m?.link;
    const mine = l && this.links.get(l.id);
    if (!mine || l.issuer !== this.did || typeof m.checkout !== "string" || canonicalJson(mine.link) !== canonicalJson(l)) return;
    if (mine.archived) return this.say(`${this.nameOf(sender)} tried to pay an archived link`);
    if ([...this.offers.values()].some((o) => o.checkout === m.checkout && o.to === sender)) return;
    this.learnName(sender, m.name);
    if (this.gates?.beforeInvoice) {
      let refusal: string | null;
      try {
        refusal = await this.gates.beforeInvoice({ link: l, sender, attachments: m.attachments, checkout: m.checkout });
      } catch (e) {
        refusal = `the check failed: ${String((e as Error)?.message ?? e)}`;
      }
      if (refusal) return this.say(`didn't invoice ${this.nameOf(sender)} for "${l.title}": ${refusal}`);
    }
    await this.invoice(sender, l.title, units(l.units), {
      link: l.id,
      checkout: m.checkout,
      conditions: { attester: l.release === "payer-confirms" ? sender : l.attester!, disputeWindowDays: l.disputeWindowDays },
    });
  }

  /** Checks proposed terms against this party's own invoice and limits before agreeing (review C5). */
  private async onTerms(m: { terms: Terms; acceptance: Acceptance }, sender: string): Promise<void> {
    const t = m?.terms;
    const mine = this.keys.get(t?.payment);
    const offer = this.offers.get(t?.payment);
    const problems: string[] = [];
    if (!mine || !offer) problems.push("not a payment I asked for");
    else {
      if (sender !== offer.to || t.payer.did !== sender) problems.push("not from the payer I invoiced");
      if (t.payee.did !== this.did || t.payee.paymentKey !== mine.key.address || t.payee.tokenAccount !== mine.token) problems.push("my payment details were changed");
      if (t.amount.units !== offer.units) problems.push("not the price I invoiced");
      if (t.purpose !== offer.purpose) problems.push("not what I invoiced");
      if (t.amount.mint !== this.directory.mint) problems.push("a token I don't accept");
      if (t.arbiter.did !== this.directory.arbiter.did || t.arbiter.key !== this.directory.arbiter.key) problems.push("an arbiter I didn't agree to");
      if (t.fee.bps > this.maxFeeBps || units(t.fee.minUnits) > this.maxMinFeeUnits) problems.push("fee too high");
      else if (units(t.fee.units) !== facilitatorFee(units(t.amount.units), t.fee.bps, units(t.fee.minUnits))) problems.push("the fee doesn't add up");
      if (this.directory.processorFeeAccount && t.fee.account !== this.directory.processorFeeAccount) problems.push("the fee goes somewhere other than the processor");
      if (t.threshold !== 2) problems.push("unexpected threshold");
      if (offer.conditions && (t.conditions.attester !== offer.conditions.attester || t.conditions.disputeWindowSeconds !== offer.conditions.disputeWindowDays * 86400)) {
        problems.push("not the conditions of my payment link");
      }
      const now = Number(await this.chain.now());
      if (t.refundAfter < now + t.conditions.disputeWindowSeconds + ARBITRATION_MARGIN_SECONDS) problems.push("the payer's reclaim deadline too close");
      if (!(await verifyAcceptance(m.acceptance, t, sender, this.clock))) problems.push("not signed by the payer");
      if (!(await verifyBinding(t.payer.binding, { did: t.payer.did, payment: t.payment, key: t.payer.paymentKey }, this.clock))) problems.push("payer's payment key isn't bound to them");
      if (this.gates?.beforeAccept) {
        try {
          problems.push(...(await this.gates.beforeAccept({ terms: t, sender, ...(offer.link ? { link: offer.link } : {}), ...(offer.checkout ? { checkout: offer.checkout } : {}) })));
        } catch (e) {
          problems.push(`the check failed: ${String((e as Error)?.message ?? e)}`);
        }
      }
    }
    if (problems.length) {
      const p = this.payments.get(t?.payment);
      const text = `refused terms from ${this.nameOf(sender)}: ${problems.join("; ")}`;
      return p?.role === "payee" ? this.note(p, text) : this.say(text);
    }
    const p = this.payment(t.payment);
    p.terms = t;
    p.acceptances = [m.acceptance, accept(t, this.identity, this.clock)];
    await this.endpoint.notify(sender, TERMS_ACCEPT, { terms: t, acceptance: p.acceptances[1] });
    this.note(
      p,
      `accepted terms: ${t.amount.display} to me on completion, attester ${this.nameOf(t.conditions.attester)}, ` +
        `${t.conditions.disputeWindowSeconds / 86400}-day dispute window, arbiter ${this.nameOf(t.arbiter.did)}, processor fee ${usdc(t.fee.units)} paid by the payer`,
    );
  }

  /** Payee: checks every field of the escrow on-chain against the agreed terms (review C4). Attester: learns it was named. */
  private async onOpened(m: OpenedPayload, sender: string): Promise<void> {
    const p = this.payments.get(m?.terms?.payment);
    if (p?.role === "payee") {
      if (!p.terms || p.escrow || sender !== p.terms.payer.did) return;
      if (hex(termsHash(m.terms)) !== hex(termsHash(p.terms))) return this.note(p, `${this.nameOf(sender)} announced an escrow for different terms`);
      const problems = await escrowProblems(this.chain, m.escrow, p.terms);
      if (problems.length) return this.note(p, `escrow ${m.escrow.slice(0, 8)}… doesn't match our terms: ${problems.join("; ")}`);
      p.escrow = m.escrow;
      return this.note(p, `checked the escrow on the chain: ${p.terms.amount.display} is locked for this job, exactly as agreed`);
    }
    if (p || m?.terms?.conditions?.attester !== this.did) return;
    if (!(await genuineOpening(this, m, sender))) return this.say(`ignored an escrow announcement that doesn't check out`);
    const q = this.payment(m.terms.payment);
    Object.assign(q, { role: "attester", terms: m.terms, escrow: m.escrow, purpose: m.terms.purpose, units: m.terms.amount.units, counterparty: m.terms.payee.did, createdAt: this.clock.iso() });
    this.note(q, `was asked by ${this.nameOf(m.terms.payer.did)} to confirm "${m.terms.purpose}" by ${this.nameOf(m.terms.payee.did)}`);
  }

  private async onAttest(a: Attestation): Promise<void> {
    const p = this.byTermsHash(a?.termsHash);
    if (!p?.terms || p.role === "attester" || a.issuer !== p.terms.conditions.attester || !(await verifySigned(a, p.terms, a.issuer, this.clock))) return;
    await this.noteAttestation(p, a);
    this.note(p, `${this.nameOf(a.issuer)} ${a.claim === "complete" ? "confirmed the work is done" : "said the work isn't done"}${a.note ? `: "${a.note}"` : ""}`);
  }

  private async onDispute(d: Dispute): Promise<void> {
    const p = this.byTermsHash(d?.termsHash);
    if (!p?.terms || (p.role !== "payer" && p.role !== "payee")) return;
    const other = p.role === "payee" ? p.terms.payer.did : p.terms.payee.did;
    if (d.issuer !== other || !(await verifySigned(d, p.terms, d.issuer, this.clock))) return;
    p.disputes.push(d);
    this.note(p, `${this.nameOf(d.issuer)} opened a dispute: "${d.reason}"`);
  }

  /** Payee: proposes the full release, with the evidence this party holds, and signs it. */
  requestRelease(paymentId: string): Promise<void> {
    return this.task(async () => {
      const p = this.payments.get(paymentId);
      if (!p?.terms || !p.escrow) throw new Error("no open escrow for that payment");
      await this.release(p);
    });
  }

  private async release(p: PaymentState): Promise<boolean> {
    const t = p.terms!;
    const evidence: Evidence = { type: "settle/evidence", termsHash: hex(termsHash(t)), payeeUnits: t.amount.units, attestations: p.attestations, disputes: p.disputes };
    const d = await this.evaluate("payee", p, evidence);
    if (!d.sign) {
      this.note(p, `won't sign: ${d.reasons.join("; ")}`);
      return false;
    }
    const before = p.signed.length;
    await this.signOutcome(p, this.keys.get(p.id)!.key, evidence, [t.payer.did]);
    if (p.signed.length > before) this.note(p, `signed a full release of ${t.amount.display} and asked for the payer's signature`);
    return true;
  }

  /** Payee: gives the payer all its money back. The payer's policy signs a refund the payee offered. */
  refund(paymentId: string): Promise<void> {
    return this.task(async () => {
      const p = this.payments.get(paymentId);
      if (p?.role !== "payee" || !p.terms || !p.escrow || p.settled) throw new Error("no open escrow to refund");
      const evidence: Evidence = { type: "settle/evidence", termsHash: hex(termsHash(p.terms)), payeeUnits: "0", attestations: p.attestations, disputes: p.disputes };
      const d = await this.evaluate("payee", p, evidence, true);
      if (!d.sign) return this.note(p, `won't sign the refund: ${d.reasons.join("; ")}`);
      await this.signOutcome(p, this.keys.get(p.id)!.key, evidence, [p.terms.payer.did]);
      this.note(p, `offered ${this.nameOf(p.terms.payer.did)} a full refund and signed it`);
    });
  }

  // ================================================================ payer

  /**
   * Opens a payment link: asks the payee for an invoice, then agrees terms, funds and opens the escrow, all without further clicks.
   * `attachments` travel with settle/checkout/start for the payee's gates (S1), e.g. a mandate presentation. Settle ignores them.
   */
  checkout(link: PaymentLink, opts: { attachments?: unknown } = {}): Promise<Checkout> {
    return this.task(async () => {
      if (!(await verifyLink(link, this.clock))) throw new Error("this payment link isn't valid");
      if (link.issuer === this.did) throw new Error("this is your own payment link");
      const w = await this.openWallet();
      const need = units(link.units) + this.feeFor(units(link.units));
      if ((await this.chain.balance(w.token)) < need) throw new Error(`not enough in your wallet: this payment needs ${usdc(need)}`);
      this.learnName(link.issuer, link.name);
      const c: Checkout = { id: `checkout-${crypto.randomUUID()}`, link, status: "contacting", at: this.clock.iso() };
      this.checkouts.set(c.id, c);
      await this.endpoint.notify(link.issuer, CHECKOUT_START, { link, checkout: c.id, name: this.name, ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}) });
      this.say(`asked ${this.nameOf(link.issuer)} for an invoice for "${link.title}"`);
      return c;
    });
  }

  /** The processor's fee for a price, from its published schedule. */
  feeFor(price: bigint): bigint {
    const f = this.directory.fee ?? { bps: 100, minUnits: "500000" };
    return facilitatorFee(price, f.bps, units(f.minUnits));
  }

  private async onRequest(offer: OfferPayload, from: string): Promise<void> {
    if (offer?.payee?.did !== from || this.requests.has(offer.payment)) return;
    const bound = await verifyBinding(offer.payee.binding, { did: from, payment: offer.payment, key: offer.payee.paymentKey }, this.clock);
    const licensed = await this.checkLicense(offer.credentials, from);
    this.learnName(from, offer.name);
    this.requests.set(offer.payment, { offer, from });
    const p = this.payment(offer.payment);
    Object.assign(p, { role: "payer", counterparty: from, purpose: offer.purpose, units: offer.units, createdAt: this.clock.iso(), link: offer.link, checkout: offer.checkout });
    this.note(
      p,
      `got an invoice from ${this.nameOf(from)}: "${offer.purpose}", ${usdc(offer.units)}. ` +
        `${licensed ? "Their verification checks out" : "They aren't verified by anyone this party trusts"}; ${bound ? "their payment key is signed by them" : "their payment key is NOT signed by them"}`,
    );
    const c = offer.checkout ? this.checkouts.get(offer.checkout) : undefined;
    // Only the link's own issuer can answer its checkout.
    if (!c || c.status !== "contacting" || from !== c.link.issuer) return;
    c.paymentId = offer.payment;
    const l = c.link;
    const fail = (error: string) => {
      c.status = "failed";
      c.error = error;
      this.note(p, `checkout stopped: ${error}`);
    };
    if (!bound) return fail("the invoice's payment key isn't bound to the payee");
    if (offer.units !== l.units || offer.purpose !== l.title || offer.link !== l.id) return fail("the invoice doesn't match the payment link");
    const attester = l.release === "payer-confirms" ? this.did : l.attester!;
    if (offer.conditions && (offer.conditions.attester !== attester || offer.conditions.disputeWindowDays !== l.disputeWindowDays)) return fail("the invoice's conditions don't match the payment link");
    c.status = "funding";
    try {
      const f = this.directory.fee ?? { bps: 100, minUnits: "500000" };
      await this.makeTerms(
        offer.payment,
        {
          attester,
          disputeWindowDays: l.disputeWindowDays,
          feeBps: f.bps,
          minFeeUnits: units(f.minUnits),
          feeAccount: this.directory.processorFeeAccount!,
          refundAfterDays: l.disputeWindowDays + RECLAIM_AFTER_WINDOW_DAYS,
        },
        { requireLicense: false, fundFromWallet: true },
      );
      c.status = "proposed";
    } catch (e) {
      fail(String((e as Error)?.message ?? e));
    }
  }

  private async checkLicense(creds: Credential[], subject: string): Promise<boolean> {
    return (await this.verifiedBusiness(creds, subject)) !== null;
  }

  /** The business name a trusted issuer vouches for, if `creds` hold a valid license or business verification for `subject`. */
  async verifiedBusiness(creds: Credential[] | undefined, subject: string): Promise<string | null> {
    for (const c of creds ?? []) {
      const kind = c?.type?.includes("ContractorLicense") || c?.type?.includes("VerifiedBusiness");
      if (!kind || !this.trustedLicensers.includes(c.issuer) || c.credentialSubject?.id !== subject) continue;
      if ((await verifyCredential(c, this.clock)).ok) return String(c.credentialSubject.name ?? c.credentialSubject.license ?? "licensed");
    }
    return null;
  }

  /** Agrees terms for an invoice: the attester, the window and the arbiter, and sets up this payment's key. */
  proposeTerms(
    paymentId: string,
    conditions: { attester: string; disputeWindowDays: number; feeBps: number; minFeeUnits: bigint; feeAccount: Address; refundAfterDays: number },
  ): Promise<void> {
    return this.task(() => this.makeTerms(paymentId, conditions, { requireLicense: this.requireLicense, fundFromWallet: false }));
  }

  private async makeTerms(
    paymentId: string,
    conditions: { attester: string; disputeWindowDays: number; feeBps: number; minFeeUnits: bigint; feeAccount: Address; refundAfterDays: number },
    opts: { requireLicense: boolean; fundFromWallet: boolean },
  ): Promise<void> {
    const r = this.requests.get(paymentId);
    if (!r) throw new Error("no such invoice");
    if (opts.requireLicense && !(await this.checkLicense(r.offer.credentials, r.from))) throw new Error("the payee's license doesn't check out");
    let k = this.keys.get(paymentId);
    if (!k) {
      const key = await derivePaymentKey(this.identity, paymentId);
      k = { key, token: await this.tokenAccountFor(key) };
      this.keys.set(paymentId, k);
    }
    const fee = facilitatorFee(units(r.offer.units), conditions.feeBps, conditions.minFeeUnits);
    const terms: Terms = {
      type: "settle/terms",
      version: 1,
      payment: paymentId,
      purpose: r.offer.purpose,
      payer: { did: this.did, paymentKey: k.key.address, tokenAccount: k.token, binding: bindPaymentKey(this.identity, k.key, paymentId, this.clock) },
      payee: { did: r.offer.payee.did, paymentKey: r.offer.payee.paymentKey, tokenAccount: r.offer.payee.tokenAccount, binding: r.offer.payee.binding, credentials: r.offer.credentials },
      arbiter: this.directory.arbiter,
      amount: { mint: this.directory.mint, units: r.offer.units, display: usdc(r.offer.units) },
      conditions: { policy: "settle/policies/attested-completion/1", attester: conditions.attester, disputeWindowSeconds: conditions.disputeWindowDays * 86400 },
      fee: { bps: conditions.feeBps, minUnits: conditions.minFeeUnits.toString(), units: fee.toString(), account: conditions.feeAccount, to: this.directory.processor },
      threshold: 2,
      refundAfter: Number(await this.chain.now()) + conditions.refundAfterDays * 86400,
    };
    const p = this.payment(paymentId);
    if (opts.fundFromWallet) {
      const w = await this.openWallet();
      const need = units(r.offer.units) + fee - (await this.chain.balance(k.token));
      if (need > 0n) {
        await this.ensureSol(w.key.address, FEE_FLOAT / 5n);
        const t = await this.chain.transfer(w.token, k.token, w.key.signer, need);
        if (!t.ok) throw new Error(`couldn't move ${usdc(need)} from the wallet: ${t.error.split("\n")[0]}`);
        this.note(p, `moved ${usdc(need)} from the wallet into this payment's account`);
      }
    }
    p.terms = terms;
    p.acceptances = [accept(terms, this.identity, this.clock)];
    await this.endpoint.notify(r.from, TERMS_PROPOSE, { terms, acceptance: p.acceptances[0] });
    this.note(p, `proposed terms to ${this.nameOf(r.from)}`);
  }

  /** Moves the price plus the processor's fee into this payment's account, as the payer's wallet would. */
  async fund(paymentId: string, fromWallet: (to: Address, units: bigint) => Promise<void>): Promise<void> {
    const k = this.keys.get(paymentId);
    const p = this.payments.get(paymentId);
    if (!k || !p?.terms) throw new Error("no terms yet");
    await fromWallet(k.token, units(p.terms.amount.units) + units(p.terms.fee.units));
  }

  /** Payer: gives up on a payment whose escrow never opened, so its account can go back to the wallet. */
  cancel(paymentId: string): void {
    const p = this.payments.get(paymentId);
    if (p?.role === "payer" && !p.escrow) {
      p.cancelled = true;
      this.note(p, `cancelled the payment before its escrow opened`);
    }
  }

  private async onAccept(m: { terms: Terms; acceptance: Acceptance }, sender: string): Promise<void> {
    const p = this.payments.get(m?.terms?.payment);
    if (!p?.terms || p.escrow || p.cancelled || hex(termsHash(p.terms)) !== hex(termsHash(m.terms))) return this.say(`${this.nameOf(sender)} accepted terms I didn't propose`);
    if (sender !== p.terms.payee.did || !(await verifyAcceptance(m.acceptance, p.terms, sender, this.clock))) return;
    p.acceptances = [p.acceptances[0], m.acceptance];
    this.note(p, `${this.nameOf(sender)} accepted the terms; opening the escrow`);
    // Not awaited: opening waits for the processor's reply, and the relay delivers messages in order,
    // so a handler that waited on a request would block the very reply it waits for.
    void this.open(p).catch((e) => this.task(async () => this.failOpen(p, String(e?.message ?? e))));
  }

  private failOpen(p: PaymentState, error: string): void {
    this.note(p, `couldn't open the escrow: ${error}`);
    for (const c of this.checkouts.values()) if (c.paymentId === p.id) Object.assign(c, { status: "failed", error });
  }

  /** Builds the open under the queue, waits for the processor outside it, and records the result under it again. */
  private async open(p: PaymentState): Promise<void> {
    const t = p.terms!;
    const k = this.keys.get(p.id)!;
    const th = termsHash(t);
    const wire = await this.serial(async () =>
      buildForSponsor(this.chain, this.processorFeePayer(), [
        await openInstruction({
          programId: this.chain.programId,
          payer: k.key.signer,
          // The processor pays rent and fees; it signs when it co-signs as fee payer.
          rentPayer: createNoopSigner(this.processorFeePayer()),
          payerToken: k.token,
          mint: t.amount.mint,
          feeAccount: t.fee.account,
          termsHash: th,
          amount: units(t.amount.units),
          fee: units(t.fee.units),
          payee: t.payee.paymentKey,
          arbiter: t.arbiter.key,
          threshold: t.threshold,
          feeBps: t.fee.bps,
          refundAfter: BigInt(t.refundAfter),
        }),
      ]),
    );
    let res = await this.submit({ transaction: wire, terms: t, acceptances: p.acceptances });
    const escrow = await escrowAddress(this.chain.programId, k.key.address, th);
    // No answer isn't a refusal: the processor may have submitted it anyway. The chain says what happened.
    if (!res.ok && (await escrowProblems(this.chain, escrow, t)).length === 0) res = { ok: true, signature: "" };
    await this.task(async () => {
      if (!res.ok) return this.failOpen(p, res.error ?? "the processor refused");
      p.escrow = escrow;
      this.note(p, `opened escrow ${p.escrow.slice(0, 8)}… with ${t.amount.display} plus a ${usdc(t.fee.units)} processor fee; the processor paid the network fees`);
      for (const c of this.checkouts.values()) if (c.paymentId === p.id) c.status = "opened";
      const opened: OpenedPayload = { terms: t, acceptances: p.acceptances, escrow: p.escrow, transaction: res.signature! };
      await this.sendAll([t.payee.did, t.conditions.attester, t.arbiter.did, this.directory.processor], ESCROW_OPENED, opened);
    });
  }

  private async submit(m: SubmitPayload): Promise<SubmitResult> {
    try {
      return (await this.endpoint.request<SubmitPayload, SubmitResult>(this.directory.processor, PROCESSOR_SUBMIT, m)).payload;
    } catch (e) {
      return { ok: false, error: `the processor didn't answer (${String((e as Error)?.message ?? e)})` };
    }
  }

  /** Each release request gets checked against this payer's policy, over everything it knows, before it signs. */
  private async onSign(s: OutcomeSignature, sender: string): Promise<void> {
    const p = this.byTermsHash(s?.termsHash);
    if (p?.role !== "payer" || !p.terms || !p.escrow || p.settled || s.escrow !== p.escrow || sender !== p.terms.payee.did) return;
    if (s.signer !== p.terms.payee.paymentKey || !verifyOutcomeSignature(this.chain.programId, s)) return;
    const refund = s.payeeUnits === "0";
    const d = await this.evaluate("payer", p, s.evidence, refund);
    if (!d.sign) {
      p.pending = s;
      return this.note(p, `${this.nameOf(sender)} asked for ${usdc(s.payeeUnits)}; not signing yet: ${d.reasons.join("; ")}`);
    }
    p.pending = undefined;
    await this.signOutcome(p, this.keys.get(p.id)!.key, s.evidence, []);
    this.note(p, refund ? `signed the refund ${this.nameOf(sender)} offered` : `signed the release: the work was confirmed, the dispute window passed, and nobody disputed`);
  }

  /** Reports a problem to the arbiter. Either party can; the arbiter then holds the escrow against reclaim. */
  dispute(paymentId: string, reason: string): Promise<void> {
    return this.task(async () => {
      const p = this.payments.get(paymentId);
      if (!p?.terms || (p.role !== "payer" && p.role !== "payee")) throw new Error("no such payment");
      const d = dispute(this.identity, p.terms, reason, this.clock);
      p.disputes.push(d);
      const other = p.role === "payer" ? p.terms.payee.did : p.terms.payer.did;
      await this.sendAll([p.terms.arbiter.did, other, this.directory.processor], ESCROW_DISPUTE, d);
      this.note(p, `opened a dispute: "${reason}"`);
    });
  }

  private async onRuling(m: RulingPayload): Promise<void> {
    const p = this.byTermsHash(m?.ruling?.termsHash);
    if (!p?.terms || !p.escrow || (p.role !== "payer" && p.role !== "payee") || !(await verifySigned(m.ruling, p.terms, p.terms.arbiter.did, this.clock))) return;
    p.ruling = m.ruling;
    const who = p.role === "payee" ? "me" : this.nameOf(p.terms.payee.did);
    this.note(p, `the arbiter ruled ${usdc(m.ruling.payeeUnits)} to ${who}: "${m.ruling.reasons}"`);
    const d = await this.evaluate(p.role, p, m.evidence);
    if (d.sign) {
      await this.signOutcome(p, this.keys.get(p.id)!.key, m.evidence, []);
      this.note(p, `signed the arbiter's outcome`);
    }
  }

  /** Payer: after the deadline, takes everything but the fee back without anyone else. */
  async reclaim(paymentId: string): Promise<boolean> {
    const p = this.payments.get(paymentId);
    const k = this.keys.get(paymentId);
    if (!p?.escrow || !p.terms || !k) throw new Error("no escrow");
    const wire = await this.serial(async () =>
      buildForSponsor(this.chain, this.processorFeePayer(), [
        await reclaimInstruction({ programId: this.chain.programId, payer: k.key.signer, escrow: p.escrow!, payerToken: k.token, feeToken: p.terms!.fee.account, rentPayer: this.processorFeePayer() }),
      ]),
    );
    const res = await this.submit({ transaction: wire });
    await this.task(async () => this.note(p, res.ok ? `reclaimed the escrow after its deadline` : `couldn't reclaim: ${res.error?.split("\n")[0]}`));
    return res.ok;
  }

  /** Collects a share the escrow couldn't pay out (the account was closed or frozen), into a new account. */
  async claim(paymentId: string): Promise<boolean> {
    const p = this.payments.get(paymentId);
    const k = this.keys.get(paymentId);
    if (!p?.escrow || !k) throw new Error("no escrow");
    const s = await this.chain.escrow(p.escrow);
    const owed = !s ? 0n : p.role === "payee" ? s.payeeOwed : s.payerOwed;
    if (owed === 0n && !(p.role === "payer" && s)) throw new Error("nothing is owed");
    const wire = await this.serial(async () => {
      const to = await this.tokenAccountFor(k.key);
      this.keys.set(paymentId, { key: k.key, token: to });
      return buildForSponsor(this.chain, this.processorFeePayer(), [await claimInstruction({ programId: this.chain.programId, claimant: k.key.signer, escrow: p.escrow!, to, rentPayer: this.processorFeePayer() })]);
    });
    const res = await this.submit({ transaction: wire });
    await this.task(async () => this.note(p, res.ok ? `claimed what the escrow owed` : `couldn't claim: ${res.error?.split("\n")[0]}`));
    return res.ok;
  }

  private async onSettled(m: SettledPayload): Promise<void> {
    const p = this.byTermsHash(m?.termsHash);
    // A tick may have seen the escrow resolve first, without the transaction: that still needs the receipt and the notes.
    if (!p?.terms || !p.escrow || p.settled?.transaction || m.escrow !== p.escrow || typeof m.transaction !== "string" || !m.transaction) return;
    const s = await this.chain.escrow(p.escrow);
    if (!s || s.state !== STATE.resolved) return;
    p.settled = { transaction: m.transaction, payeeUnits: s.payeePaid.toString() };
    p.pending = undefined;
    if (p.role === "payee") {
      const mine = this.keys.get(p.id)!;
      this.note(p, `paid: ${usdc(await this.chain.balance(mine.token))} arrived in my payment account`);
      await this.endpoint.notify(p.terms.payer.did, PAYMENT_RECEIPT, receipt(this.identity, p.terms, p.escrow, m.transaction, s.payeePaid, this.clock));
      this.note(p, `sent ${this.nameOf(p.terms.payer.did)} a signed receipt`);
    } else if (p.role === "payer") {
      this.note(p, `settled on-chain: ${usdc(s.payeePaid)} to ${this.nameOf(p.terms.payee.did)}, ${usdc(s.amount - s.payeePaid)} back to me, ${usdc(s.fee)} to the processor`);
    } else {
      this.note(p, `the payment settled: ${usdc(s.payeePaid)} to ${this.nameOf(p.terms.payee.did)}`);
    }
  }

  private async onReceipt(c: Credential): Promise<void> {
    if (!(await verifyCredential(c, this.clock)).ok) return;
    this.receipts.push(c);
    const p = this.byTermsHash(String(c.credentialSubject?.termsHash ?? ""));
    if (p) this.note(p, `got a signed receipt from ${this.nameOf(c.issuer)}`);
    else this.say(`got a signed receipt from ${this.nameOf(c.issuer)}`);
  }

  // ================================================================ attester

  /** Confirms (or denies) that the work is done, for a payment that names this party as its attester. */
  attest(paymentId: string, claim: "complete" | "not-complete", noteText?: string): Promise<void> {
    return this.task(async () => {
      const p = this.payments.get(paymentId);
      if (!p?.terms || p.terms.conditions.attester !== this.did) throw new Error("not the attester for that payment");
      const a = attest(this.identity, p.terms, claim, this.clock, noteText);
      if (p.role === "payer" || p.role === "payee") await this.noteAttestation(p, a);
      else p.attestations.push(a);
      await this.sendAll([p.terms.payer.did, p.terms.payee.did, p.terms.arbiter.did], ESCROW_ATTEST, a);
      this.note(p, `${claim === "complete" ? "confirmed the work is done" : "said the work isn't done"}${noteText ? `: "${noteText}"` : ""}`);
    });
  }

  // ================================================================ time

  /**
   * Re-reads each open escrow from the chain and acts on what time has made possible: as payer, signs a waiting
   * release once the dispute window has passed; as payee with `autoRelease`, asks for release once the work is
   * attested complete. Call it every few seconds.
   */
  tick(): Promise<void> {
    return this.task(async () => {
      const now = Number(await this.chain.now());
      // Every escrow and payment account that may still change, read in one request: a public RPC endpoint rate-limits.
      const stale = [...this.payments.values()].filter(
        (p) => p.terms && p.escrow && (!p.chain || p.chain.state === STATE.funded || p.chain.payeeOwed !== "0" || p.chain.payerOwed !== "0" || p.balance !== "0"),
      );
      const tokens = stale.map((p) => (p.role !== "attester" ? this.keys.get(p.id)?.token : undefined));
      const read = stale.length ? await this.chain.accounts([...stale.map((p) => p.escrow!), ...tokens.filter((t): t is Address => !!t)]) : [];
      let ti = stale.length;
      stale.forEach((p, i) => this.record(p, this.chain.asEscrow(read[i]), tokens[i] ? read[ti++] : undefined));
      for (const p of this.payments.values()) {
        if (!p.terms || !p.escrow) continue;
        if (p.settled || p.chain?.state !== STATE.funded) continue;
        if (p.role === "payer" && p.pending) {
          const refund = p.pending.payeeUnits === "0";
          const d = await this.evaluate("payer", p, p.pending.evidence, refund);
          if (d.sign) {
            const s = p.pending;
            p.pending = undefined;
            await this.signOutcome(p, this.keys.get(p.id)!.key, s.evidence, []);
            this.note(p, refund ? `signed the refund` : `the dispute window passed with no dispute: signed the release`);
          }
        }
        if (p.role === "payee" && this.autoRelease && !p.disputes.length && !p.ruling) {
          const latest = await this.latestCompletion(p, [], now);
          if (latest?.a.claim === "complete" && !p.signed.some((s) => s.payeeUnits === p.terms!.amount.units)) await this.release(p);
        }
      }
    });
  }

  private async refresh(p: PaymentState): Promise<void> {
    const k = p.role !== "attester" ? this.keys.get(p.id) : undefined;
    const [escrow, token] = await this.chain.accounts(k ? [p.escrow!, k.token] : [p.escrow!]);
    this.record(p, this.chain.asEscrow(escrow), k ? token : undefined);
  }

  /** Notes what the chain says about a payment's escrow and, unless `token` is undefined, its payment account. */
  private record(p: PaymentState, s: EscrowState | null, token: { data: Uint8Array } | null | undefined): void {
    if (s) {
      p.chain = { state: s.state, payeePaid: s.payeePaid.toString(), refundAfter: Number(s.refundAfter), payeeOwed: s.payeeOwed.toString(), payerOwed: s.payerOwed.toString(), amount: s.amount.toString(), fee: s.fee.toString() };
      if (s.state === STATE.resolved && !p.settled) p.settled = { transaction: "", payeeUnits: s.payeePaid.toString() };
    }
    if (token !== undefined) p.balance = (token ? tokenAmount(token.data) : 0n).toString();
  }

  // ================================================================ saving

  snapshot(): PartySnapshot {
    return structuredClone({
      v: 1 as const,
      did: this.did,
      payments: [...this.payments.values()],
      requests: [...this.requests],
      offers: [...this.offers],
      tokens: Object.fromEntries([...this.keys].map(([id, k]) => [id, k.token])),
      receipts: this.receipts,
      events: this.events.slice(-300),
      checkouts: [...this.checkouts.values()],
      links: [...this.links.values()],
      credentials: this.credentials,
      names: this.directory.names,
    });
  }

  /** Restores a snapshot taken by `snapshot()`, re-deriving each payment's key from the identity. Call before `start()`. */
  async restore(s: PartySnapshot): Promise<void> {
    if (s?.v !== 1 || s.did !== this.did) throw new Error("not this party's snapshot");
    for (const p of s.payments) this.payments.set(p.id, p);
    for (const [k, v] of s.requests) this.requests.set(k, v);
    for (const [k, v] of s.offers) this.offers.set(k, v);
    for (const [id, token] of Object.entries(s.tokens)) this.keys.set(id, { key: await derivePaymentKey(this.identity, id), token });
    this.receipts.push(...s.receipts);
    this.events.push(...s.events);
    for (const c of s.checkouts) this.checkouts.set(c.id, c);
    for (const l of s.links) this.links.set(l.link.id, l);
    this.credentials.push(...s.credentials.filter((c) => !this.credentials.some((x) => x.id === c.id)));
    this.directory.names = { ...s.names, ...this.directory.names };
  }
}

/** The repair-job cast's names for the same thing, kept so the demo and tests read naturally. */
export class Payer extends Party {}
export class Payee extends Party {}
export class Attester extends Party {}
