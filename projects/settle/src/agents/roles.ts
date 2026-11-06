/**
 * The parties of a Settle payment (design §3, §10): payer, payee, attester, arbiter, processor.
 * Each decides for itself; none of them, the processor included, can move the funds alone.
 */
import { fromB64u, toB64u, utf8, type Credential } from "@zk-toip/trust-core";
import { createNoopSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { addressBytes, ed25519Instruction, escrowAddress, openInstruction, outcomeMessage, reclaimInstruction, resolveInstruction, STATE } from "../chain/escrow";
import type { Simnet } from "../chain/simnet";
import type { PaymentKey } from "../chain/keys";
import { paymentKeyFromSeed } from "../chain/keys";
import { buildForSponsor, cosignAndSubmit } from "../chain/tx";
import {
  accept,
  attest,
  bindPaymentKey,
  derivePaymentKey,
  dispute,
  evidenceHash,
  receipt,
  rule,
  termsHash,
  verifyAcceptance,
  verifyBinding,
  verifyCredential,
  verifySigned,
  type Acceptance,
  type Attestation,
  type Dispute,
  type Evidence,
  type Party,
  type Ruling,
  type Terms,
} from "../protocol/documents";
import {
  ARBITER_RULING,
  ESCROW_ATTEST,
  ESCROW_DISPUTE,
  ESCROW_OPENED,
  ESCROW_SETTLED,
  ESCROW_SIGN,
  PAYMENT_RECEIPT,
  PAYMENT_REQUEST,
  PROCESSOR_LOG,
  PROCESSOR_SUBMIT,
  TERMS_ACCEPT,
  TERMS_PROPOSE,
} from "../protocol/specs";
import { TransparencyLog, type LogEntry, type LogHead } from "../protocol/log";
import { Agent, hex, verifyOutcomeSignature, type AgentOptions, type OutcomeSignature, type PaymentState } from "./base";

const units = (n: string | bigint) => BigInt(n);
const usdc = (u: string | bigint) => `${(Number(units(u)) / 1e6).toFixed(2)} USDC`;

interface OfferPayload {
  payment: string;
  purpose: string;
  units: string;
  payee: Party;
  credentials: Credential[];
}
interface OpenedPayload {
  terms: Terms;
  acceptances: Acceptance[];
  escrow: Address;
  transaction: string;
}
interface RulingPayload {
  ruling: Ruling;
  evidence: Evidence;
  signature: OutcomeSignature;
}
interface SettledPayload {
  termsHash: string;
  escrow: Address;
  transaction: string;
  payeeUnits: string;
  evidenceHash: string;
}

/** Sets up a token account for a payment key, with a little SOL for its rent, as a devnet faucet would. */
async function tokenAccountFor(net: Simnet, key: PaymentKey, mint: Address): Promise<Address> {
  net.airdrop(key.address, 1n);
  return net.createTokenAccount(mint, key.address, key.signer);
}

// ====================================================================== payee

export class Payee extends Agent {
  readonly credentials: Credential[] = [];
  private readonly keys = new Map<string, { key: PaymentKey; token: Address }>();

  constructor(opts: AgentOptions) {
    super(opts);
    this.endpoint.handle<{ terms: Terms; acceptance: Acceptance }, void>(TERMS_PROPOSE, (doc, ctx) => this.serial(() => this.onTerms(doc.payload, ctx.sender)));
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc) => this.serial(() => this.onOpened(doc.payload)));
    this.endpoint.handle<Attestation, void>(ESCROW_ATTEST, (doc) => this.serial(() => this.onAttest(doc.payload)));
    this.endpoint.handle<Dispute, void>(ESCROW_DISPUTE, (doc) => this.serial(() => this.onDispute(doc.payload)));
    this.endpoint.handle<RulingPayload, void>(ARBITER_RULING, (doc) => this.serial(() => this.onRuling(doc.payload)));
    this.endpoint.handle<OutcomeSignature, void>(ESCROW_SIGN, () => undefined);
    this.endpoint.handle<SettledPayload, void>(ESCROW_SETTLED, (doc) => this.serial(() => this.onSettled(doc.payload)));
  }

  /** Sends an invoice with this payee's credentials and a fresh payment key for it. */
  request(payerDid: string, purpose: string, amountUnits: bigint): Promise<string> {
    return this.serial(async () => {
      const id = `pay-${crypto.randomUUID()}`;
      const key = await derivePaymentKey(this.identity, id);
      const token = await tokenAccountFor(this.net, key, this.directory.mint);
      this.keys.set(id, { key, token });
      const p = this.payment(id);
      void p;
      const offer: OfferPayload = {
        payment: id,
        purpose,
        units: amountUnits.toString(),
        payee: { did: this.did, paymentKey: key.address, tokenAccount: token, binding: bindPaymentKey(this.identity, key, id, this.clock) },
        credentials: this.credentials,
      };
      await this.endpoint.notify(payerDid, PAYMENT_REQUEST, offer);
      this.say(`sent an invoice to ${this.nameOf(payerDid)}: "${purpose}", ${usdc(amountUnits)}, with ${this.credentials.length} credential(s)`);
      return id;
    });
  }

  private async onTerms(m: { terms: Terms; acceptance: Acceptance }, sender: string): Promise<void> {
    const t = m.terms;
    const mine = this.keys.get(t?.payment);
    const problems: string[] = [];
    if (!mine) problems.push("not a payment I asked for");
    else {
      if (t.payee.did !== this.did || t.payee.paymentKey !== mine.key.address || t.payee.tokenAccount !== mine.token) problems.push("my payment details were changed");
      if (t.arbiter.did !== this.directory.arbiter.did || t.arbiter.key !== this.directory.arbiter.key) problems.push("an arbiter I didn't agree to");
      if (t.fee.bps > 200) problems.push("fee too high");
      if (t.threshold !== 2) problems.push("unexpected threshold");
      if (t.payer.did !== sender || !(await verifyAcceptance(m.acceptance, t, sender, this.clock))) problems.push("not signed by the payer");
      if (!(await verifyBinding(t.payer.binding, { did: t.payer.did, payment: t.payment, key: t.payer.paymentKey }, this.clock))) problems.push("payer's payment key isn't bound to them");
    }
    if (problems.length) return this.say(`refused terms from ${this.nameOf(sender)}: ${problems.join("; ")}`);
    const p = this.payment(t.payment);
    p.terms = t;
    p.acceptances = [m.acceptance, accept(t, this.identity, this.clock)];
    await this.endpoint.notify(sender, TERMS_ACCEPT, { terms: t, acceptance: p.acceptances[1] });
    this.say(`accepted terms: ${t.amount.display}, attester ${this.nameOf(t.conditions.attester)}, ${t.conditions.disputeWindowSeconds / 86400}-day dispute window, arbiter ${this.nameOf(t.arbiter.did)}`);
  }

  private async onOpened(m: OpenedPayload): Promise<void> {
    const p = this.payments.get(m.terms?.payment);
    if (!p?.terms) return;
    const s = this.net.escrow(m.escrow);
    if (!s || s.state !== STATE.funded || hex(s.termsHash) !== hex(termsHash(p.terms)) || s.amount !== units(p.terms.amount.units) || s.payee !== p.terms.payee.paymentKey) {
      return this.say(`escrow ${m.escrow} doesn't match our terms`);
    }
    p.escrow = m.escrow;
    this.say(`checked the escrow on-chain: ${usdc(s.amount)} locked for this job`);
  }

  private async onAttest(a: Attestation): Promise<void> {
    const p = this.byTermsHash(a?.termsHash);
    if (!p?.terms || !(await verifySigned(a, p.terms, a.issuer, this.clock))) return;
    p.attestations.push(a);
    this.say(`${this.nameOf(a.issuer)} attested the work is ${a.claim}`);
  }

  private async onDispute(d: Dispute): Promise<void> {
    const p = this.byTermsHash(d?.termsHash);
    if (!p?.terms || !(await verifySigned(d, p.terms, d.issuer, this.clock))) return;
    p.disputes.push(d);
    this.say(`${this.nameOf(d.issuer)} opened a dispute: "${d.reason}"`);
  }

  /** Proposes the full release, with the evidence this payee holds, and signs it. */
  requestRelease(paymentId: string): Promise<void> {
    return this.serial(async () => {
      const p = this.payments.get(paymentId);
      if (!p?.terms || !p.escrow) throw new Error("no open escrow for that payment");
      const evidence: Evidence = { type: "settle/evidence", termsHash: hex(termsHash(p.terms)), payeeUnits: p.terms.amount.units, attestations: p.attestations, disputes: p.disputes };
      const d = await this.evaluate("payee", p, evidence);
      if (!d.sign) return this.say(`won't sign: ${d.reasons.join("; ")}`);
      await this.signOutcome(p, this.keys.get(paymentId)!.key, evidence, [p.terms.payer.did]);
      this.say(`signed a full release of ${p.terms.amount.display} and asked for the payer's signature`);
    });
  }

  private async onRuling(m: RulingPayload): Promise<void> {
    const p = this.byTermsHash(m?.ruling?.termsHash);
    if (!p?.terms || !p.escrow) return;
    p.ruling = m.ruling;
    const d = await this.evaluate("payee", p, m.evidence);
    this.say(`the arbiter ruled ${usdc(m.ruling.payeeUnits)} to me: "${m.ruling.reasons}"`);
    if (d.sign) {
      await this.signOutcome(p, this.keys.get(p.id)!.key, m.evidence, []);
      this.say(`signed the arbiter's outcome`);
    }
  }

  private async onSettled(m: SettledPayload): Promise<void> {
    const p = this.byTermsHash(m?.termsHash);
    if (!p?.terms || p.settled) return;
    const s = this.net.escrow(m.escrow);
    if (!s || s.state !== STATE.resolved) return;
    p.settled = { transaction: m.transaction, payeeUnits: s.payeePaid.toString() };
    const mine = this.keys.get(p.id)!;
    this.say(`paid: ${usdc(this.net.balance(mine.token))} arrived in my payment account`);
    await this.endpoint.notify(p.terms.payer.did, PAYMENT_RECEIPT, receipt(this.identity, p.terms, m.escrow, m.transaction, s.payeePaid, this.clock));
    this.say(`sent ${this.nameOf(p.terms.payer.did)} a signed receipt`);
  }
}

// ====================================================================== payer

export class Payer extends Agent {
  readonly requests = new Map<string, { offer: OfferPayload; from: string }>();
  readonly receipts: Credential[] = [];
  private readonly keys = new Map<string, { key: PaymentKey; token: Address }>();
  /** Which credential issuers this payer trusts for contractor licenses. */
  trustedLicensers: string[] = [];

  constructor(opts: AgentOptions) {
    super(opts);
    this.endpoint.handle<OfferPayload, void>(PAYMENT_REQUEST, (doc, ctx) => this.serial(() => this.onRequest(doc.payload, ctx.sender)));
    this.endpoint.handle<{ terms: Terms; acceptance: Acceptance }, void>(TERMS_ACCEPT, (doc, ctx) => this.serial(() => this.onAccept(doc.payload, ctx.sender)));
    this.endpoint.handle<Attestation, void>(ESCROW_ATTEST, (doc) => this.serial(() => this.onAttest(doc.payload)));
    this.endpoint.handle<OutcomeSignature, void>(ESCROW_SIGN, (doc, ctx) => this.serial(() => this.onSign(doc.payload, ctx.sender)));
    this.endpoint.handle<RulingPayload, void>(ARBITER_RULING, (doc) => this.serial(() => this.onRuling(doc.payload)));
    this.endpoint.handle<SettledPayload, void>(ESCROW_SETTLED, (doc) => this.serial(() => this.onSettled(doc.payload)));
    this.endpoint.handle<Credential, void>(PAYMENT_RECEIPT, (doc) => this.serial(() => this.onReceipt(doc.payload)));
  }

  private async onRequest(offer: OfferPayload, from: string): Promise<void> {
    if (offer?.payee?.did !== from) return;
    const bound = await verifyBinding(offer.payee.binding, { did: from, payment: offer.payment, key: offer.payee.paymentKey }, this.clock);
    const licensed = await this.checkLicense(offer.credentials, from);
    this.requests.set(offer.payment, { offer, from });
    this.say(
      `got an invoice from ${this.nameOf(from)}: "${offer.purpose}", ${usdc(offer.units)}. ` +
        `License: ${licensed ? "verified" : "missing or untrusted"}. Payment key: ${bound ? "bound to them" : "NOT bound"}`,
    );
  }

  private async checkLicense(creds: Credential[], subject: string): Promise<boolean> {
    for (const c of creds ?? []) {
      if (!c?.type?.includes("ContractorLicense") || !this.trustedLicensers.includes(c.issuer) || c.credentialSubject?.id !== subject) continue;
      if ((await verifyCredential(c, this.clock)).ok) return true;
    }
    return false;
  }

  /** Agrees terms for an invoice: the attester, the window and the arbiter, and funds this payment's key. */
  proposeTerms(paymentId: string, conditions: { attester: string; disputeWindowDays: number; feeBps: number; feeAccount: Address; refundAfterDays: number }): Promise<void> {
    return this.serial(async () => {
      const r = this.requests.get(paymentId);
      if (!r) throw new Error("no such invoice");
      if (!(await this.checkLicense(r.offer.credentials, r.from))) throw new Error("the payee's license doesn't check out");
      const key = await derivePaymentKey(this.identity, paymentId);
      const token = await tokenAccountFor(this.net, key, this.directory.mint);
      this.keys.set(paymentId, { key, token });
      const terms: Terms = {
        type: "settle/terms",
        version: 1,
        payment: paymentId,
        purpose: r.offer.purpose,
        payer: { did: this.did, paymentKey: key.address, tokenAccount: token, binding: bindPaymentKey(this.identity, key, paymentId, this.clock) },
        payee: { ...r.offer.payee, credentials: r.offer.credentials },
        arbiter: this.directory.arbiter,
        amount: { mint: this.directory.mint, units: r.offer.units, display: usdc(r.offer.units) },
        conditions: { policy: "settle/policies/attested-completion/1", attester: conditions.attester, disputeWindowSeconds: conditions.disputeWindowDays * 86400 },
        fee: { bps: conditions.feeBps, account: conditions.feeAccount, to: this.directory.processor },
        threshold: 2,
        refundAfter: Math.floor(this.clock.now() / 1000) + conditions.refundAfterDays * 86400,
      };
      const p = this.payment(paymentId);
      p.terms = terms;
      p.acceptances = [accept(terms, this.identity, this.clock)];
      await this.endpoint.notify(r.from, TERMS_PROPOSE, { terms, acceptance: p.acceptances[0] });
      this.say(`proposed terms to ${this.nameOf(r.from)}`);
    });
  }

  /** Moves USDC into this payment's account, as the payer's wallet would. */
  async fund(paymentId: string, fromWallet: (to: Address, units: bigint) => Promise<void>): Promise<void> {
    const k = this.keys.get(paymentId);
    const p = this.payments.get(paymentId);
    if (!k || !p?.terms) throw new Error("no terms yet");
    await fromWallet(k.token, units(p.terms.amount.units));
  }

  private async onAccept(m: { terms: Terms; acceptance: Acceptance }, sender: string): Promise<void> {
    const p = this.payments.get(m?.terms?.payment);
    if (!p?.terms || hex(termsHash(p.terms)) !== hex(termsHash(m.terms))) return this.say(`${this.nameOf(sender)} accepted terms I didn't propose`);
    if (sender !== p.terms.payee.did || !(await verifyAcceptance(m.acceptance, p.terms, sender, this.clock))) return;
    p.acceptances.push(m.acceptance);
    this.say(`${this.nameOf(sender)} accepted the terms; opening the escrow`);
    // Not awaited: opening waits for the processor's reply, and the relay delivers messages in order,
    // so a handler that waited on a request would block the very reply it waits for.
    void this.serial(() => this.open(p)).catch((e) => this.say(`couldn't open the escrow: ${String(e?.message ?? e)}`));
  }

  private async open(p: PaymentState): Promise<void> {
    const t = p.terms!;
    const k = this.keys.get(p.id)!;
    const th = termsHash(t);
    const ix = await openInstruction({
      programId: this.net.programId,
      payer: k.key.signer,
      // The processor pays rent and fees; it signs when it co-signs as fee payer.
      rentPayer: createNoopSigner(await this.processorFeePayer()),
      payerToken: k.token,
      mint: t.amount.mint,
      feeAccount: t.fee.account,
      termsHash: th,
      amount: units(t.amount.units),
      payee: t.payee.paymentKey,
      arbiter: t.arbiter.key,
      threshold: t.threshold,
      feeBps: t.fee.bps,
      refundAfter: BigInt(t.refundAfter),
    });
    const wire = await buildForSponsor(this.net, await this.processorFeePayer(), [ix]);
    const res = await this.endpoint.request<{ transaction: string }, { ok: boolean; signature?: string; error?: string }>(this.directory.processor, PROCESSOR_SUBMIT, { transaction: wire });
    if (!res.payload.ok) return this.say(`couldn't open the escrow: ${res.payload.error}`);
    p.escrow = await escrowAddress(this.net.programId, th);
    this.say(`opened escrow ${p.escrow.slice(0, 8)}… with ${t.amount.display}; the processor paid the fees`);
    const opened: OpenedPayload = { terms: t, acceptances: p.acceptances, escrow: p.escrow, transaction: res.payload.signature! };
    for (const to of new Set([t.payee.did, t.conditions.attester, t.arbiter.did, this.directory.processor])) await this.endpoint.notify(to, ESCROW_OPENED, opened);
  }

  private feePayer?: Address;
  /** The processor's fee-payer address, as published by the processor (here: from its log). */
  setProcessorFeePayer(a: Address): void {
    this.feePayer = a;
  }
  private async processorFeePayer(): Promise<Address> {
    if (!this.feePayer) throw new Error("processor fee payer unknown");
    return this.feePayer;
  }

  private async onAttest(a: Attestation): Promise<void> {
    const p = this.byTermsHash(a?.termsHash);
    if (!p?.terms || !(await verifySigned(a, p.terms, a.issuer, this.clock))) return;
    p.attestations.push(a);
    this.say(`${this.nameOf(a.issuer)} attested the work is ${a.claim}${a.note ? `: "${a.note}"` : ""}`);
  }

  /** Each release proposal gets checked against the payer's policy before the payer signs anything. */
  private async onSign(s: OutcomeSignature, sender: string): Promise<void> {
    const p = this.byTermsHash(s?.termsHash);
    if (!p?.terms || !p.escrow || s.escrow !== p.escrow || !verifyOutcomeSignature(this.net.programId, s)) return;
    if (sender !== p.terms.payee.did) return;
    const d = await this.evaluate("payer", p, s.evidence);
    if (!d.sign) return this.say(`${this.nameOf(sender)} asked for ${usdc(s.payeeUnits)}; not signing: ${d.reasons.join("; ")}`);
    await this.signOutcome(p, this.keys.get(p.id)!.key, s.evidence, []);
    this.say(`policy passed (attested complete, window over, no dispute): signed the release`);
  }

  /** Raises a dispute with the arbiter, e.g. when the attester reports the work isn't done. */
  dispute(paymentId: string, reason: string): Promise<void> {
    return this.serial(async () => {
      const p = this.payments.get(paymentId);
      if (!p?.terms) throw new Error("no such payment");
      const d = dispute(this.identity, p.terms, reason, this.clock);
      p.disputes.push(d);
      for (const to of [p.terms.arbiter.did, p.terms.payee.did, this.directory.processor]) await this.endpoint.notify(to, ESCROW_DISPUTE, d);
      this.say(`opened a dispute: "${reason}"`);
    });
  }

  private async onRuling(m: RulingPayload): Promise<void> {
    const p = this.byTermsHash(m?.ruling?.termsHash);
    if (!p?.terms || !p.escrow) return;
    p.ruling = m.ruling;
    this.say(`the arbiter ruled ${usdc(m.ruling.payeeUnits)} to ${this.nameOf(p.terms.payee.did)}: "${m.ruling.reasons}"`);
    const d = await this.evaluate("payer", p, m.evidence);
    if (d.sign) {
      await this.signOutcome(p, this.keys.get(p.id)!.key, m.evidence, []);
      this.say(`signed the arbiter's outcome`);
    }
  }

  /** After the deadline, takes everything back without anyone else. */
  reclaim(paymentId: string): Promise<boolean> {
    return this.serial(async () => {
      const p = this.payments.get(paymentId);
      const k = this.keys.get(paymentId);
      if (!p?.escrow || !k) throw new Error("no escrow");
      const ix = await reclaimInstruction({ programId: this.net.programId, payer: k.key.signer, escrow: p.escrow, payerToken: k.token, rentPayer: await this.processorFeePayer() });
      const wire = await buildForSponsor(this.net, await this.processorFeePayer(), [ix]);
      const res = await this.endpoint.request<{ transaction: string }, { ok: boolean; error?: string }>(this.directory.processor, PROCESSOR_SUBMIT, { transaction: wire });
      this.say(res.payload.ok ? `reclaimed the escrow after its deadline` : `couldn't reclaim: ${res.payload.error?.split("\n")[0]}`);
      return res.payload.ok;
    });
  }

  private async onSettled(m: SettledPayload): Promise<void> {
    const p = this.byTermsHash(m?.termsHash);
    if (!p?.terms || p.settled) return;
    const s = this.net.escrow(m.escrow);
    if (!s || s.state !== STATE.resolved) return;
    p.settled = { transaction: m.transaction, payeeUnits: s.payeePaid.toString() };
    this.say(`settled on-chain: ${usdc(s.payeePaid)} to ${this.nameOf(p.terms.payee.did)}, ${usdc(s.amount - s.payeePaid)} back to me`);
  }

  private async onReceipt(c: Credential): Promise<void> {
    if (!(await verifyCredential(c, this.clock)).ok) return;
    this.receipts.push(c);
    this.say(`got a signed receipt from ${this.nameOf(c.issuer)}`);
  }

  tokenAccount(paymentId: string): Address | undefined {
    return this.keys.get(paymentId)?.token;
  }
}

// ====================================================================== attester

export class Attester extends Agent {
  constructor(opts: AgentOptions) {
    super(opts);
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc) => this.serial(() => this.onOpened(doc.payload)));
  }

  private async onOpened(m: OpenedPayload): Promise<void> {
    if (m?.terms?.conditions?.attester !== this.did) return;
    const p = this.payment(m.terms.payment);
    p.terms = m.terms;
    p.escrow = m.escrow;
    this.say(`was named the attester for "${m.terms.purpose}"`);
  }

  attest(paymentId: string, claim: "complete" | "not-complete", note?: string): Promise<void> {
    return this.serial(async () => {
      const p = this.payments.get(paymentId);
      if (!p?.terms) throw new Error("not an attester for that payment");
      const a = attest(this.identity, p.terms, claim, this.clock, note);
      for (const to of [p.terms.payer.did, p.terms.payee.did, p.terms.arbiter.did]) await this.endpoint.notify(to, ESCROW_ATTEST, a);
      this.say(`attested: ${claim}${note ? ` ("${note}")` : ""}`);
    });
  }
}

// ====================================================================== arbiter

export class Arbiter extends Agent {
  readonly rulings: Ruling[] = [];
  private key!: PaymentKey;

  constructor(opts: AgentOptions) {
    super(opts);
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc) => this.serial(() => this.onOpened(doc.payload)));
    this.endpoint.handle<Attestation, void>(ESCROW_ATTEST, (doc) => this.serial(() => this.onAttest(doc.payload)));
    this.endpoint.handle<Dispute, void>(ESCROW_DISPUTE, (doc) => this.serial(() => this.onDispute(doc.payload)));
  }

  /** The arbiter's published key, the same for every payment it serves. */
  static async keyFor(identity: AgentOptions["identity"]): Promise<PaymentKey> {
    return paymentKeyFromSeed(sha256(new Uint8Array([...identity.signingSecret, ...utf8("settle/arbiter-key/v1")])));
  }

  override async start(): Promise<void> {
    this.key = await Arbiter.keyFor(this.identity);
    await super.start();
  }

  private async onOpened(m: OpenedPayload): Promise<void> {
    if (m?.terms?.arbiter?.did !== this.did) return;
    const p = this.payment(m.terms.payment);
    p.terms = m.terms;
    p.escrow = m.escrow;
  }

  private async onAttest(a: Attestation): Promise<void> {
    const p = this.byTermsHash(a?.termsHash);
    if (p?.terms && (await verifySigned(a, p.terms, a.issuer, this.clock))) p.attestations.push(a);
  }

  private async onDispute(d: Dispute): Promise<void> {
    const p = this.byTermsHash(d?.termsHash);
    if (!p?.terms || !(await verifySigned(d, p.terms, d.issuer, this.clock))) return;
    if (d.issuer !== p.terms.payer.did && d.issuer !== p.terms.payee.did) return;
    p.disputes.push(d);
    this.say(`received a dispute from ${this.nameOf(d.issuer)}: "${d.reason}"`);
  }

  /** Decides a disputed payment, signs the outcome it rules, and publishes the ruling. */
  rule(paymentId: string, payeeUnits: bigint, reasons: string): Promise<Ruling> {
    return this.serial(async () => {
      const p = this.payments.get(paymentId);
      if (!p?.terms || !p.escrow) throw new Error("not arbitrating that payment");
      const r = rule(this.identity, p.terms, payeeUnits, reasons, [...p.attestations, ...p.disputes], this.clock);
      p.ruling = r;
      this.rulings.push(r);
      const evidence: Evidence = { type: "settle/evidence", termsHash: r.termsHash, payeeUnits: r.payeeUnits, attestations: p.attestations, disputes: p.disputes, ruling: r };
      const message = outcomeMessage(this.net.programId, p.escrow, payeeUnits, evidenceHash(evidence));
      const signature: OutcomeSignature = { termsHash: r.termsHash, escrow: p.escrow, payeeUnits: r.payeeUnits, evidence, signer: this.key.address, signature: toB64u(this.key.sign(message)) };
      for (const to of [p.terms.payer.did, p.terms.payee.did, this.directory.processor]) await this.endpoint.notify(to, ARBITER_RULING, { ruling: r, evidence, signature });
      this.say(`ruled ${usdc(payeeUnits)} to ${this.nameOf(p.terms.payee.did)}, ${usdc(units(p.terms.amount.units) - payeeUnits)} back to ${this.nameOf(p.terms.payer.did)}: "${reasons}"`);
      return r;
    });
  }
}

// ====================================================================== processor

export class Processor extends Agent {
  readonly log: TransparencyLog;
  private readonly terms = new Map<Address, Terms>();
  private readonly sigs = new Map<string, Map<Address, OutcomeSignature>>();
  feePayer!: KeyPairSigner;
  feeAccount!: Address;

  constructor(opts: AgentOptions) {
    super(opts);
    this.log = new TransparencyLog(opts.identity, opts.clock);
    this.endpoint.handle<{ transaction: string }, { ok: boolean; signature?: string; error?: string }>(PROCESSOR_SUBMIT, (doc) => this.serial(() => this.onSubmit(doc.payload.transaction)));
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc) => this.serial(() => this.onOpened(doc.payload)));
    this.endpoint.handle<OutcomeSignature, void>(ESCROW_SIGN, (doc) => this.serial(() => this.collect(doc.payload)));
    this.endpoint.handle<RulingPayload, void>(ARBITER_RULING, (doc) => this.serial(() => this.onRuling(doc.payload)));
    this.endpoint.handle<Dispute, void>(ESCROW_DISPUTE, (doc) =>
      this.serial(async () => {
        this.log.append("dispute", doc.payload.termsHash, { issuer: doc.payload.issuer });
      }),
    );
    this.endpoint.handle<Record<string, never>, { entries: LogEntry[]; head: LogHead }>(PROCESSOR_LOG, () => this.log.snapshot());
  }

  /** Sets up the processor's fee-payer key (with SOL) and its fee account. */
  async setup(mint: Address): Promise<void> {
    this.feePayer = await this.net.funded(100n);
    this.feeAccount = await this.net.createTokenAccount(mint, this.feePayer.address, this.feePayer);
  }

  private async onSubmit(wire: string): Promise<{ ok: boolean; signature?: string; error?: string }> {
    const r = await cosignAndSubmit(this.net, this.feePayer, wire);
    if (r.ok) this.say(`co-signed and submitted a transaction as fee payer`);
    else this.say(`refused or failed a submission: ${r.error.split("\n")[0]}`);
    return r;
  }

  private async onOpened(m: OpenedPayload): Promise<void> {
    const s = this.net.escrow(m?.escrow);
    if (!s || hex(s.termsHash) !== hex(termsHash(m.terms))) return;
    this.terms.set(m.escrow, m.terms);
    this.log.append("opened", hex(s.termsHash), { escrow: m.escrow, units: s.amount.toString(), transaction: m.transaction });
  }

  private async onRuling(m: RulingPayload): Promise<void> {
    this.log.append("ruling", m.ruling.termsHash, { issuer: m.ruling.issuer, payeeUnits: m.ruling.payeeUnits, reasons: m.ruling.reasons });
    await this.collect(m.signature);
  }

  /** Collects outcome signatures; submits as soon as enough distinct allowed keys signed the same outcome. */
  private async collect(s: OutcomeSignature): Promise<void> {
    const chain = this.net.escrow(s?.escrow);
    if (!chain || chain.state !== STATE.funded || !verifyOutcomeSignature(this.net.programId, s)) return;
    if (![chain.payer, chain.payee, chain.arbiter].includes(s.signer)) return;
    const eh = hex(evidenceHash(s.evidence));
    const key = `${s.escrow}|${s.payeeUnits}|${eh}`;
    const got = this.sigs.get(key) ?? new Map<Address, OutcomeSignature>();
    got.set(s.signer, s);
    this.sigs.set(key, got);
    this.log.append("signature", hex(chain.termsHash), { escrow: s.escrow, signer: s.signer, payeeUnits: s.payeeUnits, evidence: eh });
    if (got.size < chain.threshold) return;
    const terms = this.terms.get(s.escrow);
    if (!terms) return this.say(`have a quorum for ${s.escrow} but not its terms`);
    const message = outcomeMessage(this.net.programId, s.escrow, BigInt(s.payeeUnits), evidenceHash(s.evidence));
    const ixs = [
      ...[...got.values()].map((x) => ed25519Instruction(addressBytes(x.signer), fromB64u(x.signature), message)),
      await resolveInstruction({
        programId: this.net.programId,
        escrow: s.escrow,
        payeeToken: terms.payee.tokenAccount,
        payerToken: terms.payer.tokenAccount,
        feeToken: terms.fee.account,
        rentPayer: this.feePayer.address,
        payeeAmount: BigInt(s.payeeUnits),
        evidenceHash: evidenceHash(s.evidence),
      }),
    ];
    const r = await this.net.send(this.feePayer, ixs);
    if (!r.ok) return this.say(`resolve failed: ${r.name ?? r.error.split("\n")[0]}`);
    const transaction = r.signature;
    this.log.append("settled", hex(chain.termsHash), { escrow: s.escrow, payeeUnits: s.payeeUnits, evidence: eh, signers: [...got.keys()] });
    this.say(`had ${got.size} of ${chain.threshold} signatures for ${usdc(s.payeeUnits)} to the payee: submitted it`);
    const settled: SettledPayload = { termsHash: hex(chain.termsHash), escrow: s.escrow, transaction, payeeUnits: s.payeeUnits, evidenceHash: eh };
    for (const to of new Set([terms.payer.did, terms.payee.did, terms.arbiter.did])) await this.endpoint.notify(to, ESCROW_SETTLED, settled);
  }
}
