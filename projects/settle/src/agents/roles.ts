/**
 * The parties of a Settle payment (design §3, §10): payer, payee, attester, arbiter, processor.
 * Each decides for itself and checks what it's told against the chain; none of them, the processor
 * included, can move the funds alone.
 */
import { fromB64u, toB64u, utf8, type Credential } from "@zk-toip/trust-core";
import {
  createNoopSigner,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  addressBytes,
  bytesAddress,
  ed25519Instruction,
  escrowAddress,
  holdInstruction,
  holdMessage,
  openInstruction,
  outcomeMessage,
  reclaimInstruction,
  resolveInstruction,
  STATE,
} from "../chain/escrow";
import type { Chain } from "../chain/chain";
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
  facilitatorFee,
  hexHash,
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
  ESCROW_HOLD,
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
import { Agent, escrowProblems, hex, termsAgreed, verifyOutcomeSignature, type AgentOptions, type OutcomeSignature, type PaymentState } from "./base";

const units = (n: string | bigint) => BigInt(n);
const usdc = (u: string | bigint) => `${(Number(units(u)) / 1e6).toFixed(2)} USDC`;
/** The least time between the end of a dispute window and the payer's reclaim deadline, for arbitration. */
const ARBITRATION_MARGIN_SECONDS = 14 * 86400;
/** How long the arbiter holds a disputed escrow (the program caps a hold at 180 days). */
const HOLD_SECONDS = 60 * 86400;

export interface OfferPayload {
  payment: string;
  purpose: string;
  units: string;
  payee: Party;
  credentials: Credential[];
}
export interface OpenedPayload {
  terms: Terms;
  acceptances: Acceptance[];
  escrow: Address;
  transaction: string;
}
export interface RulingPayload {
  ruling: Ruling;
  evidence: Evidence;
  signature: OutcomeSignature;
}
export interface SettledPayload {
  termsHash: string;
  escrow: Address;
  transaction: string;
  payeeUnits: string;
  evidenceHash: string;
}
export interface SubmitPayload {
  transaction: string;
  /** For an open: the terms and both acceptances, which the processor checks before paying for anything. */
  terms?: Terms;
  acceptances?: Acceptance[];
}
export interface HoldPayload {
  escrow: Address;
  until: string;
  signature: string;
}

/** A token account for a payment key, with a little SOL for its rent from the faucet (devnet-style). */
async function tokenAccountFor(chain: Chain, key: PaymentKey, mint: Address): Promise<Address> {
  await chain.airdrop(key.address, 1n);
  return chain.createTokenAccount(mint, key.address, key.signer, await generateKeyPairSigner());
}

// ====================================================================== payee

export class Payee extends Agent {
  readonly credentials: Credential[] = [];
  /** The most this payee accepts the processor charging (the payer pays it, but it's part of the deal). */
  maxFeeBps = 200;
  maxMinFeeUnits = 2_000_000n;
  private readonly keys = new Map<string, { key: PaymentKey; token: Address }>();
  private readonly offers = new Map<string, OfferPayload & { to: string }>();

  constructor(opts: AgentOptions) {
    super(opts);
    this.endpoint.handle<{ terms: Terms; acceptance: Acceptance }, void>(TERMS_PROPOSE, (doc, ctx) => this.serial(() => this.onTerms(doc.payload, ctx.sender)));
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc, ctx) => this.serial(() => this.onOpened(doc.payload, ctx.sender)));
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
      const token = await tokenAccountFor(this.chain, key, this.directory.mint);
      this.keys.set(id, { key, token });
      const offer: OfferPayload = {
        payment: id,
        purpose,
        units: amountUnits.toString(),
        payee: { did: this.did, paymentKey: key.address, tokenAccount: token, binding: bindPaymentKey(this.identity, key, id, this.clock) },
        credentials: this.credentials,
      };
      this.offers.set(id, { ...offer, to: payerDid });
      this.payment(id);
      await this.endpoint.notify(payerDid, PAYMENT_REQUEST, offer);
      this.say(`sent an invoice to ${this.nameOf(payerDid)}: "${purpose}", ${usdc(amountUnits)}, with ${this.credentials.length} credential(s)`);
      return id;
    });
  }

  /** Checks proposed terms against this payee's own invoice and limits before agreeing (review C5). */
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
      const now = Number(await this.chain.now());
      if (t.refundAfter < now + t.conditions.disputeWindowSeconds + ARBITRATION_MARGIN_SECONDS) problems.push("the payer's reclaim deadline too close");
      if (!(await verifyAcceptance(m.acceptance, t, sender, this.clock))) problems.push("not signed by the payer");
      if (!(await verifyBinding(t.payer.binding, { did: t.payer.did, payment: t.payment, key: t.payer.paymentKey }, this.clock))) problems.push("payer's payment key isn't bound to them");
    }
    if (problems.length) return this.say(`refused terms from ${this.nameOf(sender)}: ${problems.join("; ")}`);
    const p = this.payment(t.payment);
    p.terms = t;
    p.acceptances = [m.acceptance, accept(t, this.identity, this.clock)];
    await this.endpoint.notify(sender, TERMS_ACCEPT, { terms: t, acceptance: p.acceptances[1] });
    this.say(
      `accepted terms: ${t.amount.display} to me on completion, attester ${this.nameOf(t.conditions.attester)}, ` +
        `${t.conditions.disputeWindowSeconds / 86400}-day dispute window, arbiter ${this.nameOf(t.arbiter.did)}, processor fee ${usdc(t.fee.units)} paid by the payer`,
    );
  }

  /** Checks every field of the escrow on-chain against the agreed terms (review C4). */
  private async onOpened(m: OpenedPayload, sender: string): Promise<void> {
    const p = this.payments.get(m?.terms?.payment);
    if (!p?.terms || p.escrow || sender !== p.terms.payer.did) return;
    if (hex(termsHash(m.terms)) !== hex(termsHash(p.terms))) return this.say(`${this.nameOf(sender)} announced an escrow for different terms`);
    const problems = await escrowProblems(this.chain, m.escrow, p.terms);
    if (problems.length) return this.say(`escrow ${m.escrow.slice(0, 8)}… doesn't match our terms: ${problems.join("; ")}`);
    p.escrow = m.escrow;
    this.say(`checked the escrow on-chain: ${p.terms.amount.display} locked for this job, every field as agreed`);
  }

  private async onAttest(a: Attestation): Promise<void> {
    const p = this.byTermsHash(a?.termsHash);
    if (!p?.terms || a.issuer !== p.terms.conditions.attester || !(await verifySigned(a, p.terms, a.issuer, this.clock))) return;
    await this.noteAttestation(p, a);
    this.say(`${this.nameOf(a.issuer)} attested the work is ${a.claim}`);
  }

  private async onDispute(d: Dispute): Promise<void> {
    const p = this.byTermsHash(d?.termsHash);
    if (!p?.terms || d.issuer !== p.terms.payer.did || !(await verifySigned(d, p.terms, d.issuer, this.clock))) return;
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
    if (!p?.terms || !p.escrow || !(await verifySigned(m.ruling, p.terms, p.terms.arbiter.did, this.clock))) return;
    p.ruling = m.ruling;
    this.say(`the arbiter ruled ${usdc(m.ruling.payeeUnits)} to me: "${m.ruling.reasons}"`);
    const d = await this.evaluate("payee", p, m.evidence);
    if (d.sign) {
      await this.signOutcome(p, this.keys.get(p.id)!.key, m.evidence, []);
      this.say(`signed the arbiter's outcome`);
    }
  }

  private async onSettled(m: SettledPayload): Promise<void> {
    const p = this.byTermsHash(m?.termsHash);
    if (!p?.terms || !p.escrow || p.settled || m.escrow !== p.escrow) return;
    const s = await this.chain.escrow(p.escrow);
    if (!s || s.state !== STATE.resolved) return;
    p.settled = { transaction: m.transaction, payeeUnits: s.payeePaid.toString() };
    const mine = this.keys.get(p.id)!;
    this.say(`paid: ${usdc(await this.chain.balance(mine.token))} arrived in my payment account`);
    await this.endpoint.notify(p.terms.payer.did, PAYMENT_RECEIPT, receipt(this.identity, p.terms, p.escrow, m.transaction, s.payeePaid, this.clock));
    this.say(`sent ${this.nameOf(p.terms.payer.did)} a signed receipt`);
  }

  tokenAccount(paymentId: string): Address | undefined {
    return this.keys.get(paymentId)?.token;
  }
}

// ====================================================================== payer

export class Payer extends Agent {
  readonly requests = new Map<string, { offer: OfferPayload; from: string }>();
  readonly receipts: Credential[] = [];
  private readonly keys = new Map<string, { key: PaymentKey; token: Address }>();
  /** Which credential issuers this payer trusts for contractor licenses. */
  trustedLicensers: string[] = [];
  private feePayer?: Address;

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

  /** The processor's fee-payer address, as the processor publishes it. */
  setProcessorFeePayer(a: Address): void {
    this.feePayer = a;
  }
  private processorFeePayer(): Address {
    if (!this.feePayer) throw new Error("processor fee payer unknown");
    return this.feePayer;
  }

  private async onRequest(offer: OfferPayload, from: string): Promise<void> {
    if (offer?.payee?.did !== from || this.requests.has(offer.payment)) return;
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

  /** Agrees terms for an invoice: the attester, the window and the arbiter, and sets up this payment's key. */
  proposeTerms(
    paymentId: string,
    conditions: { attester: string; disputeWindowDays: number; feeBps: number; minFeeUnits: bigint; feeAccount: Address; refundAfterDays: number },
  ): Promise<void> {
    return this.serial(async () => {
      const r = this.requests.get(paymentId);
      if (!r) throw new Error("no such invoice");
      if (!(await this.checkLicense(r.offer.credentials, r.from))) throw new Error("the payee's license doesn't check out");
      let k = this.keys.get(paymentId);
      if (!k) {
        const key = await derivePaymentKey(this.identity, paymentId);
        k = { key, token: await tokenAccountFor(this.chain, key, this.directory.mint) };
        this.keys.set(paymentId, k);
      }
      const terms: Terms = {
        type: "settle/terms",
        version: 1,
        payment: paymentId,
        purpose: r.offer.purpose,
        payer: { did: this.did, paymentKey: k.key.address, tokenAccount: k.token, binding: bindPaymentKey(this.identity, k.key, paymentId, this.clock) },
        payee: { ...r.offer.payee, credentials: r.offer.credentials },
        arbiter: this.directory.arbiter,
        amount: { mint: this.directory.mint, units: r.offer.units, display: usdc(r.offer.units) },
        conditions: { policy: "settle/policies/attested-completion/1", attester: conditions.attester, disputeWindowSeconds: conditions.disputeWindowDays * 86400 },
        fee: {
          bps: conditions.feeBps,
          minUnits: conditions.minFeeUnits.toString(),
          units: facilitatorFee(units(r.offer.units), conditions.feeBps, conditions.minFeeUnits).toString(),
          account: conditions.feeAccount,
          to: this.directory.processor,
        },
        threshold: 2,
        refundAfter: Number(await this.chain.now()) + conditions.refundAfterDays * 86400,
      };
      const p = this.payment(paymentId);
      p.terms = terms;
      p.acceptances = [accept(terms, this.identity, this.clock)];
      await this.endpoint.notify(r.from, TERMS_PROPOSE, { terms, acceptance: p.acceptances[0] });
      this.say(`proposed terms to ${this.nameOf(r.from)}`);
    });
  }

  /** Moves the price plus the processor's fee into this payment's account, as the payer's wallet would. */
  async fund(paymentId: string, fromWallet: (to: Address, units: bigint) => Promise<void>): Promise<void> {
    const k = this.keys.get(paymentId);
    const p = this.payments.get(paymentId);
    if (!k || !p?.terms) throw new Error("no terms yet");
    await fromWallet(k.token, units(p.terms.amount.units) + units(p.terms.fee.units));
  }

  private async onAccept(m: { terms: Terms; acceptance: Acceptance }, sender: string): Promise<void> {
    const p = this.payments.get(m?.terms?.payment);
    if (!p?.terms || p.escrow || hex(termsHash(p.terms)) !== hex(termsHash(m.terms))) return this.say(`${this.nameOf(sender)} accepted terms I didn't propose`);
    if (sender !== p.terms.payee.did || !(await verifyAcceptance(m.acceptance, p.terms, sender, this.clock))) return;
    p.acceptances = [p.acceptances[0], m.acceptance];
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
    });
    const wire = await buildForSponsor(this.chain, this.processorFeePayer(), [ix]);
    const res = await this.endpoint.request<SubmitPayload, { ok: boolean; signature?: string; error?: string }>(this.directory.processor, PROCESSOR_SUBMIT, {
      transaction: wire,
      terms: t,
      acceptances: p.acceptances,
    });
    if (!res.payload.ok) return this.say(`couldn't open the escrow: ${res.payload.error}`);
    p.escrow = await escrowAddress(this.chain.programId, k.key.address, th);
    this.say(`opened escrow ${p.escrow.slice(0, 8)}… with ${t.amount.display} plus a ${usdc(t.fee.units)} processor fee; the processor paid the network fees`);
    const opened: OpenedPayload = { terms: t, acceptances: p.acceptances, escrow: p.escrow, transaction: res.payload.signature! };
    for (const to of new Set([t.payee.did, t.conditions.attester, t.arbiter.did, this.directory.processor])) await this.endpoint.notify(to, ESCROW_OPENED, opened);
  }

  private async onAttest(a: Attestation): Promise<void> {
    const p = this.byTermsHash(a?.termsHash);
    if (!p?.terms || a.issuer !== p.terms.conditions.attester || !(await verifySigned(a, p.terms, a.issuer, this.clock))) return;
    await this.noteAttestation(p, a);
    this.say(`${this.nameOf(a.issuer)} attested the work is ${a.claim}${a.note ? `: "${a.note}"` : ""}`);
  }

  /** Each release proposal gets checked against the payer's policy, over everything the payer knows, before it signs. */
  private async onSign(s: OutcomeSignature, sender: string): Promise<void> {
    const p = this.byTermsHash(s?.termsHash);
    if (!p?.terms || !p.escrow || s.escrow !== p.escrow || sender !== p.terms.payee.did || !verifyOutcomeSignature(this.chain.programId, s)) return;
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
    if (!p?.terms || !p.escrow || !(await verifySigned(m.ruling, p.terms, p.terms.arbiter.did, this.clock))) return;
    p.ruling = m.ruling;
    this.say(`the arbiter ruled ${usdc(m.ruling.payeeUnits)} to ${this.nameOf(p.terms.payee.did)}: "${m.ruling.reasons}"`);
    const d = await this.evaluate("payer", p, m.evidence);
    if (d.sign) {
      await this.signOutcome(p, this.keys.get(p.id)!.key, m.evidence, []);
      this.say(`signed the arbiter's outcome`);
    }
  }

  /** After the deadline, takes everything but the fee back without anyone else. */
  reclaim(paymentId: string): Promise<boolean> {
    return this.serial(async () => {
      const p = this.payments.get(paymentId);
      const k = this.keys.get(paymentId);
      if (!p?.escrow || !p.terms || !k) throw new Error("no escrow");
      const ix = await reclaimInstruction({
        programId: this.chain.programId,
        payer: k.key.signer,
        escrow: p.escrow,
        payerToken: k.token,
        feeToken: p.terms.fee.account,
        rentPayer: this.processorFeePayer(),
      });
      const wire = await buildForSponsor(this.chain, this.processorFeePayer(), [ix]);
      const res = await this.endpoint.request<SubmitPayload, { ok: boolean; error?: string }>(this.directory.processor, PROCESSOR_SUBMIT, { transaction: wire });
      this.say(res.payload.ok ? `reclaimed the escrow after its deadline` : `couldn't reclaim: ${res.payload.error?.split("\n")[0]}`);
      return res.payload.ok;
    });
  }

  private async onSettled(m: SettledPayload): Promise<void> {
    const p = this.byTermsHash(m?.termsHash);
    if (!p?.terms || !p.escrow || p.settled || m.escrow !== p.escrow) return;
    const s = await this.chain.escrow(p.escrow);
    if (!s || s.state !== STATE.resolved) return;
    p.settled = { transaction: m.transaction, payeeUnits: s.payeePaid.toString() };
    this.say(`settled on-chain: ${usdc(s.payeePaid)} to ${this.nameOf(p.terms.payee.did)}, ${usdc(s.amount - s.payeePaid)} back to me, ${usdc(s.fee)} to the processor`);
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

// ====================================================================== shared check for observers

/** Whether an announced escrow is real and matches terms both parties signed, sent by the payer (review C6). */
async function genuineOpening(agent: { chain: Chain; clock: AgentOptions["clock"] }, m: OpenedPayload, sender: string): Promise<boolean> {
  if (!m?.terms || sender !== m.terms.payer?.did) return false;
  if (!(await termsAgreed(m.terms, m.acceptances, agent.clock))) return false;
  return (await escrowProblems(agent.chain, m.escrow, m.terms)).length === 0;
}

// ====================================================================== attester

export class Attester extends Agent {
  constructor(opts: AgentOptions) {
    super(opts);
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc, ctx) => this.serial(() => this.onOpened(doc.payload, ctx.sender)));
  }

  private async onOpened(m: OpenedPayload, sender: string): Promise<void> {
    if (m?.terms?.conditions?.attester !== this.did || this.payments.get(m.terms.payment)?.terms) return;
    if (!(await genuineOpening(this, m, sender))) return this.say(`ignored an escrow announcement that doesn't check out`);
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
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc, ctx) => this.serial(() => this.onOpened(doc.payload, ctx.sender)));
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

  private async onOpened(m: OpenedPayload, sender: string): Promise<void> {
    if (m?.terms?.arbiter?.did !== this.did || m.terms.arbiter.key !== this.key.address || this.payments.get(m.terms.payment)?.terms) return;
    if (!(await genuineOpening(this, m, sender))) return this.say(`ignored an escrow announcement that doesn't check out`);
    const p = this.payment(m.terms.payment);
    p.terms = m.terms;
    p.escrow = m.escrow;
  }

  private async onAttest(a: Attestation): Promise<void> {
    const p = this.byTermsHash(a?.termsHash);
    if (p?.terms && a.issuer === p.terms.conditions.attester && (await verifySigned(a, p.terms, a.issuer, this.clock))) await this.noteAttestation(p, a);
  }

  /** A dispute from a party: record it, and hold the escrow so the payer can't reclaim before a ruling (review I6). */
  private async onDispute(d: Dispute): Promise<void> {
    const p = this.byTermsHash(d?.termsHash);
    if (!p?.terms || !p.escrow || !(await verifySigned(d, p.terms, d.issuer, this.clock))) return;
    if (d.issuer !== p.terms.payer.did && d.issuer !== p.terms.payee.did) return;
    p.disputes.push(d);
    this.say(`received a dispute from ${this.nameOf(d.issuer)}: "${d.reason}"`);
    const until = (await this.chain.now()) + BigInt(HOLD_SECONDS);
    const signature = toB64u(this.key.sign(holdMessage(this.chain.programId, p.escrow, until)));
    await this.endpoint.notify(this.directory.processor, ESCROW_HOLD, { escrow: p.escrow, until: until.toString(), signature } satisfies HoldPayload);
  }

  /** Decides a disputed payment, signs the outcome it rules, and publishes the ruling. */
  rule(paymentId: string, payeeUnits: bigint, reasons: string): Promise<Ruling> {
    return this.serial(async () => {
      const p = this.payments.get(paymentId);
      if (!p?.terms || !p.escrow) throw new Error("not arbitrating that payment");
      // The escrow comes from the terms themselves, never from what someone announced.
      const escrow = await escrowAddress(this.chain.programId, p.terms.payer.paymentKey, termsHash(p.terms));
      const r = rule(this.identity, p.terms, payeeUnits, reasons, [...p.attestations, ...p.disputes], this.clock);
      p.ruling = r;
      this.rulings.push(r);
      const evidence: Evidence = { type: "settle/evidence", termsHash: r.termsHash, payeeUnits: r.payeeUnits, attestations: p.attestations, disputes: p.disputes, ruling: r };
      const message = outcomeMessage(this.chain.programId, escrow, payeeUnits, evidenceHash(evidence));
      const signature: OutcomeSignature = { termsHash: r.termsHash, escrow, payeeUnits: r.payeeUnits, evidence, signer: this.key.address, signature: toB64u(this.key.sign(message)) };
      for (const to of [p.terms.payer.did, p.terms.payee.did, this.directory.processor]) await this.endpoint.notify(to, ARBITER_RULING, { ruling: r, evidence, signature });
      this.say(`ruled ${usdc(payeeUnits)} to ${this.nameOf(p.terms.payee.did)}, ${usdc(units(p.terms.amount.units) - payeeUnits)} back to ${this.nameOf(p.terms.payer.did)}: "${reasons}"`);
      return r;
    });
  }
}

// ====================================================================== processor

/** Which account slot of each sponsored Settle instruction the processor fills, as rent payer: open, reclaim, claim. */
const PROCESSOR_SLOT: Record<number, number> = { 0: 1, 2: 5, 3: 4 };

export class Processor extends Agent {
  readonly log: TransparencyLog;
  /** The processor's published fee schedule; it sponsors only opens that charge exactly this. */
  feeBps = 100;
  minFeeUnits = 500_000n;
  private readonly terms = new Map<Address, Terms>();
  private readonly sigs = new Map<string, Map<Address, OutcomeSignature>>();
  feePayer!: KeyPairSigner;
  /** A separate key owns the fee account, so the fee payer's signature can never move fees (review C3). */
  private feeOwner!: KeyPairSigner;
  feeAccount!: Address;

  constructor(opts: AgentOptions) {
    super(opts);
    this.log = new TransparencyLog(opts.identity, opts.clock);
    this.endpoint.handle<SubmitPayload, { ok: boolean; signature?: string; error?: string }>(PROCESSOR_SUBMIT, (doc) => this.serial(() => this.onSubmit(doc.payload)));
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc, ctx) => this.serial(() => this.onOpened(doc.payload, ctx.sender)));
    this.endpoint.handle<OutcomeSignature, void>(ESCROW_SIGN, (doc) => this.serial(() => this.collect(doc.payload)));
    this.endpoint.handle<RulingPayload, void>(ARBITER_RULING, (doc) => this.serial(() => this.onRuling(doc.payload)));
    this.endpoint.handle<Dispute, void>(ESCROW_DISPUTE, (doc) => this.serial(() => this.onDispute(doc.payload)));
    this.endpoint.handle<HoldPayload, void>(ESCROW_HOLD, (doc) => this.serial(() => this.onHold(doc.payload)));
    this.endpoint.handle<Record<string, never>, { entries: LogEntry[]; head: LogHead }>(PROCESSOR_LOG, () => this.log.snapshot());
  }

  /** Sets up the processor's fee-payer key (with SOL) and its fee account, owned by a separate key. */
  async setup(mint: Address): Promise<void> {
    this.feePayer = await generateKeyPairSigner();
    this.feeOwner = await generateKeyPairSigner();
    await this.chain.airdrop(this.feePayer.address, 100n);
    this.feeAccount = await this.chain.createTokenAccount(mint, this.feeOwner.address, this.feePayer, await generateKeyPairSigner());
  }

  private knownByHash(h: string): [Address, Terms] | undefined {
    for (const e of this.terms) if (hex(termsHash(e[1])) === h) return e;
    return undefined;
  }

  /** Decides whether to pay for a party's transaction, then co-signs and submits it (review C3). */
  private async onSubmit(m: SubmitPayload): Promise<{ ok: boolean; signature?: string; error?: string }> {
    const refuse = (error: string) => {
      this.say(`refused to sponsor a transaction: ${error}`);
      return { ok: false, error };
    };
    let tx: Transaction;
    let msg: { staticAccounts: Address[]; instructions?: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[] };
    try {
      tx = getTransactionDecoder().decode(getBase64Encoder().encode(m?.transaction ?? "")) as Transaction;
      msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as typeof msg;
    } catch {
      return refuse("not a transaction");
    }
    const ixs = msg.instructions ?? [];
    if (ixs.length !== 1 || msg.staticAccounts[ixs[0].programAddressIndex] !== this.chain.programId) return refuse("only a single Settle instruction is sponsored");
    const ix = ixs[0];
    const data = ix.data ?? new Uint8Array();
    const slots = (ix.accountIndices ?? []).map((i) => msg.staticAccounts[i]);
    const slot = PROCESSOR_SLOT[data[0]];
    if (slot === undefined) return refuse("that Settle instruction isn't sponsored");
    if (msg.staticAccounts[0] !== this.feePayer.address) return refuse("the processor isn't the fee payer");
    if (slots[slot] !== this.feePayer.address || slots.some((a, i) => i !== slot && (a === this.feePayer.address || a === this.feeOwner.address))) {
      return refuse("the processor's keys may only pay fees and rent");
    }
    if (data[0] === 0) {
      const t = m.terms;
      if (!t || !(await termsAgreed(t, m.acceptances, this.clock))) return refuse("an open needs terms both parties signed");
      if (data.length < 124) return refuse("malformed open");
      const th = termsHash(t);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const problems: string[] = [];
      if (hex(data.slice(1, 33)) !== hex(th)) problems.push("terms hash");
      if (view.getBigUint64(33, true) !== units(t.amount.units) || view.getBigUint64(108, true) !== units(t.fee.units)) problems.push("amounts");
      if (bytesAddress(data.slice(41, 73)) !== t.payee.paymentKey || bytesAddress(data.slice(73, 105)) !== t.arbiter.key) problems.push("keys");
      if (data[105] !== t.threshold || view.getBigInt64(116, true) !== BigInt(t.refundAfter) || slots[0] !== t.payer.paymentKey) problems.push("parties or deadline");
      if (slots[2] !== (await escrowAddress(this.chain.programId, t.payer.paymentKey, th))) problems.push("escrow address");
      if (t.fee.account !== this.feeAccount || slots[6] !== this.feeAccount || t.fee.to !== this.did) problems.push("not this processor's fee account");
      if (t.fee.bps !== this.feeBps || units(t.fee.minUnits) !== this.minFeeUnits || units(t.fee.units) !== facilitatorFee(units(t.amount.units), this.feeBps, this.minFeeUnits)) problems.push("not this processor's fee");
      if (problems.length) return refuse(`the open doesn't match the terms (${problems.join(", ")})`);
    } else if (!this.terms.has(slots[1])) {
      return refuse("not an escrow this processor knows");
    }
    const r = await cosignAndSubmit(this.chain, this.feePayer, m.transaction);
    if (r.ok) this.say(`co-signed and submitted a transaction as fee payer`);
    else this.say(`a sponsored transaction failed: ${r.error.split("\n")[0]}`);
    return r;
  }

  private async onOpened(m: OpenedPayload, sender: string): Promise<void> {
    if (this.terms.has(m?.escrow)) return;
    if (!(await genuineOpening(this, m, sender))) return;
    this.terms.set(m.escrow, m.terms);
    this.log.append("opened", hex(termsHash(m.terms)), { escrow: m.escrow, units: m.terms.amount.units });
  }

  /** Logs only what checks out, as roles and hashes: no DIDs, names or reasons (review I1, I2). */
  private async onDispute(d: Dispute): Promise<void> {
    const known = this.knownByHash(d?.termsHash);
    if (!known || !(await verifySigned(d, known[1], d.issuer, this.clock))) return;
    const role = d.issuer === known[1].payer.did ? "payer" : d.issuer === known[1].payee.did ? "payee" : null;
    if (role) this.log.append("dispute", d.termsHash, { by: role, document: hexHash(d) });
  }

  private async onRuling(m: RulingPayload): Promise<void> {
    const known = this.knownByHash(m?.ruling?.termsHash);
    if (!known || !(await verifySigned(m.ruling, known[1], known[1].arbiter.did, this.clock))) return;
    this.log.append("ruling", m.ruling.termsHash, { payeeUnits: m.ruling.payeeUnits, document: hexHash(m.ruling) });
    await this.collect(m.signature);
  }

  /** Submits the arbiter's hold, so a disputed escrow can't be reclaimed before a ruling. */
  private async onHold(h: HoldPayload): Promise<void> {
    const terms = this.terms.get(h?.escrow);
    const chain = terms ? await this.chain.escrow(h.escrow) : null;
    if (!terms || !chain || chain.state !== STATE.funded) return;
    let until: bigint;
    let sig: Uint8Array;
    try {
      until = BigInt(h.until);
      sig = fromB64u(h.signature);
      if (!ed25519.verify(sig, holdMessage(this.chain.programId, h.escrow, until), addressBytes(chain.arbiter))) return;
    } catch {
      return;
    }
    const message = holdMessage(this.chain.programId, h.escrow, until);
    const r = await this.chain.send(this.feePayer, [ed25519Instruction(addressBytes(chain.arbiter), sig, message), await holdInstruction({ programId: this.chain.programId, escrow: h.escrow, until })]);
    if (!r.ok) return this.say(`hold failed: ${r.name ?? r.error.split("\n")[0]}`);
    this.log.append("hold", hex(chain.termsHash), { escrow: h.escrow, until: h.until });
    this.say(`held the disputed escrow until ${new Date(Number(until) * 1000).toISOString().slice(0, 10)} on the arbiter's signature`);
  }

  /** Collects outcome signatures; submits as soon as enough distinct allowed keys signed the same outcome. */
  private async collect(s: OutcomeSignature): Promise<void> {
    const terms = this.terms.get(s?.escrow);
    const chain = terms ? await this.chain.escrow(s.escrow) : null;
    if (!terms || !chain || chain.state !== STATE.funded || !verifyOutcomeSignature(this.chain.programId, s)) return;
    const role = s.signer === chain.payer ? "payer" : s.signer === chain.payee ? "payee" : s.signer === chain.arbiter ? "arbiter" : null;
    if (!role) return;
    const eh = hex(evidenceHash(s.evidence));
    const key = `${s.escrow}|${s.payeeUnits}|${eh}`;
    const got = this.sigs.get(key) ?? new Map<Address, OutcomeSignature>();
    if (got.has(s.signer)) return;
    got.set(s.signer, s);
    this.sigs.set(key, got);
    this.log.append("signature", hex(chain.termsHash), { escrow: s.escrow, by: role, payeeUnits: s.payeeUnits, evidence: eh });
    if (got.size < chain.threshold) return;
    const message = outcomeMessage(this.chain.programId, s.escrow, BigInt(s.payeeUnits), evidenceHash(s.evidence));
    const ixs = [
      ...[...got.values()].map((x) => ed25519Instruction(addressBytes(x.signer), fromB64u(x.signature), message)),
      await resolveInstruction({
        programId: this.chain.programId,
        escrow: s.escrow,
        payeeToken: terms.payee.tokenAccount,
        payerToken: terms.payer.tokenAccount,
        feeToken: terms.fee.account,
        rentPayer: this.feePayer.address,
        payeeAmount: BigInt(s.payeeUnits),
        evidenceHash: evidenceHash(s.evidence),
      }),
    ];
    const r = await this.chain.send(this.feePayer, ixs);
    if (!r.ok) return this.say(`resolve failed: ${r.name ?? r.error.split("\n")[0]}`);
    const roleOf = (a: Address) => (a === chain.payer ? "payer" : a === chain.payee ? "payee" : "arbiter");
    this.log.append("settled", hex(chain.termsHash), { escrow: s.escrow, payeeUnits: s.payeeUnits, evidence: eh, signers: [...got.keys()].map(roleOf) });
    this.say(`had ${got.size} of ${chain.threshold} signatures for ${usdc(s.payeeUnits)} to the payee: submitted it`);
    this.say(`earned its ${usdc(chain.fee)} facilitator fee`);
    const settled: SettledPayload = { termsHash: hex(chain.termsHash), escrow: s.escrow, transaction: r.signature, payeeUnits: s.payeeUnits, evidenceHash: eh };
    for (const to of new Set([terms.payer.did, terms.payee.did, terms.arbiter.did])) await this.endpoint.notify(to, ESCROW_SETTLED, settled);
  }
}
