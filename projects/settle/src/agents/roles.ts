/**
 * The services of a Settle network (design §3, §10): the arbiter and the processor. The people who pay,
 * get paid and confirm work are Parties (party.ts). Each decides for itself and checks what it's told
 * against the chain; none of them, the processor included, can move the funds alone.
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
import { Agent, genuineOpening, hex, termsAgreed, verifyOutcomeSignature, type AgentEvent, type AgentOptions, type OutcomeSignature, type PaymentState } from "./base";
import type { HoldPayload, OpenedPayload, RulingPayload, SettledPayload, SubmitPayload } from "./messages";

export { Party, Payer, Payee, Attester, encodeLink, decodeLink, verifyLink, type PaymentLink, type Checkout, type PartySnapshot } from "./party";
export type { OfferPayload, OpenedPayload, RulingPayload, SettledPayload, SubmitPayload, HoldPayload } from "./messages";

const units = (n: string | bigint) => BigInt(n);
const usdc = (u: string | bigint) => `${(Number(units(u)) / 1e6).toFixed(2)} USDC`;
/** The least time between the end of a dispute window and the payer's reclaim deadline, for arbitration. */
const ARBITRATION_MARGIN_SECONDS = 14 * 86400;
/** How long the arbiter holds a disputed escrow (the program caps a hold at 180 days). */
const HOLD_SECONDS = 60 * 86400;

// ====================================================================== arbiter

export interface ArbiterSnapshot {
  v: 1;
  payments: PaymentState[];
  rulings: Ruling[];
  events: AgentEvent[];
}

export interface ProcessorSnapshot {
  v: 1;
  terms: [Address, Terms][];
  sigs: [string, OutcomeSignature[]][];
  log: LogEntry[];
  events: AgentEvent[];
}

export class Arbiter extends Agent {
  readonly rulings: Ruling[] = [];
  private key!: PaymentKey;

  constructor(opts: AgentOptions) {
    super(opts);
    this.endpoint.handle<OpenedPayload, void>(ESCROW_OPENED, (doc, ctx) => this.serial(() => this.onOpened(doc.payload, ctx.sender)));
    this.endpoint.handle<Attestation, void>(ESCROW_ATTEST, (doc) => this.serial(() => this.onAttest(doc.payload)));
    this.endpoint.handle<Dispute, void>(ESCROW_DISPUTE, (doc) => this.serial(() => this.onDispute(doc.payload)));
  }

  /** What the arbiter knows, to pick up after a restart. */
  snapshot(): ArbiterSnapshot {
    return structuredClone({ v: 1 as const, payments: [...this.payments.values()], rulings: this.rulings, events: this.events.slice(-300) });
  }

  restore(s: ArbiterSnapshot): void {
    if (s?.v !== 1) throw new Error("not an arbiter snapshot");
    for (const p of s.payments) this.payments.set(p.id, p);
    this.rulings.push(...s.rulings);
    this.events.push(...s.events);
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

  /**
   * Sets up the processor's fee-payer key and its fee account, owned by a separate key. A platform that keeps
   * its keys across restarts passes them in (and funds the fee payer itself); otherwise they're fresh, with SOL
   * from the cluster's faucet.
   */
  async setup(mint: Address, keys?: { feePayer: KeyPairSigner; feeOwner: KeyPairSigner; feeAccount: KeyPairSigner }): Promise<void> {
    this.feePayer = keys?.feePayer ?? (await generateKeyPairSigner());
    this.feeOwner = keys?.feeOwner ?? (await generateKeyPairSigner());
    if (!keys) await this.chain.airdrop(this.feePayer.address, 100n);
    const account = keys?.feeAccount ?? (await generateKeyPairSigner());
    this.feeAccount = (await this.chain.exists(account.address)) ? account.address : await this.chain.createTokenAccount(mint, this.feeOwner.address, this.feePayer, account);
  }

  /** What the processor knows (escrows it checked, signatures it holds, its log), to pick up after a restart. */
  snapshot(): ProcessorSnapshot {
    return structuredClone({
      v: 1 as const,
      terms: [...this.terms],
      sigs: [...this.sigs].map(([k, m]) => [k, [...m.values()]] as [string, OutcomeSignature[]]),
      log: this.log.snapshot().entries,
      events: this.events.slice(-300),
    });
  }

  restore(s: ProcessorSnapshot): void {
    if (s?.v !== 1) throw new Error("not a processor snapshot");
    this.log.load(s.log);
    for (const [k, t] of s.terms) this.terms.set(k, t);
    for (const [k, list] of s.sigs) this.sigs.set(k, new Map(list.map((x) => [x.signer, x])));
    this.events.push(...s.events);
  }

  /** How many escrows this processor has seen opened and checked. */
  get escrows(): number {
    return this.terms.size;
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
