/**
 * What every Settle party has: a ToIP identity, a TSP endpoint on the relay, a view of the chain,
 * the payment policy, and what it has learned about each payment.
 */
import { Endpoint, RelayTransport, fromB64u, toB64u, type Clock, type Identity, type OutboxStore, type Traffic } from "@toip-tools/trust-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Address } from "@solana/kit";
import { addressBytes, escrowAddress, outcomeMessage, STATE } from "../chain/escrow";
import type { PaymentKey } from "../chain/keys";
import type { Chain } from "../chain/chain";
import {
  evidenceHash,
  hexHash,
  termsHash,
  verifyAcceptance,
  verifySigned,
  type Acceptance,
  type Attestation,
  type Dispute,
  type Evidence,
  type Ruling,
  type Terms,
} from "../protocol/documents";
import type { PolicyDecision, SettlePolicy } from "../protocol/policy";
import { ESCROW_SIGN } from "../protocol/specs";

/** Who's who, as each agent is configured to know it. */
export interface Directory {
  names: Record<string, string>;
  processor: string;
  /** The processor's published fee account; terms must pay the fee there. */
  processorFeeAccount?: Address;
  arbiter: { did: string; key: Address };
  licensingBoard: string;
  mint: Address;
  /** The processor's published fee schedule. */
  fee?: { bps: number; minUnits: string };
}

export interface PaymentState {
  id: string;
  terms?: Terms;
  acceptances: Acceptance[];
  escrow?: Address;
  attestations: Attestation[];
  disputes: Dispute[];
  ruling?: Ruling;
  settled?: { transaction: string; payeeUnits: string };
  signed: { payeeUnits: string; evidenceHash: string }[];
  /** When this party received each attestation (chain time), keyed by the attestation's hash. */
  received: Record<string, number>;
  /** This party's part in the payment. */
  role?: "payer" | "payee" | "attester";
  /** The other party (for a payer, the payee; for a payee, the payer). */
  counterparty?: string;
  purpose?: string;
  units?: string;
  createdAt?: string;
  link?: string;
  checkout?: string;
  /** A release request this payer refused for now, re-checked as time passes. */
  pending?: OutcomeSignature;
  /** The payer gave up on a payment before its escrow opened, so its funds can go back to the wallet. */
  cancelled?: boolean;
  /** What happened, for people: this party's own account of the payment. */
  timeline?: { at: string; text: string }[];
  /** The escrow as last read from the chain. */
  chain?: { state: number; payeePaid: string; refundAfter: number; payeeOwed: string; payerOwed: string; amount: string; fee: string };
  /** This party's payment account balance, as last read. */
  balance?: string;
}

export interface AgentEvent {
  at: string;
  who: string;
  text: string;
}

/** The signed outcome a party sends the processor (design §7, escrow/sign). */
export interface OutcomeSignature {
  termsHash: string;
  escrow: Address;
  payeeUnits: string;
  evidence: Evidence;
  signer: Address;
  signature: string;
}

export interface AgentOptions {
  name: string;
  identity: Identity;
  relayUrl: string;
  clock: Clock;
  chain: Chain;
  policy: SettlePolicy;
  directory: Directory;
  onEvent?: (e: AgentEvent) => void;
  onTraffic?: (who: string, t: Traffic) => void;
  /** Where unsent messages wait across restarts (a browser's storage, say). Defaults to memory. */
  outbox?: OutboxStore;
  /**
   * Tops up an address with SOL for rent and network fees (the platform's gas station). Without it the
   * agent asks the cluster's faucet, which only a local cluster gives freely.
   */
  gas?: (address: Address, lamports: bigint) => Promise<void>;
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export abstract class Agent {
  readonly name: string;
  readonly did: string;
  readonly identity: Identity;
  readonly endpoint: Endpoint;
  readonly transport: RelayTransport;
  readonly payments = new Map<string, PaymentState>();
  readonly events: AgentEvent[] = [];
  readonly clock: Clock;
  readonly chain: Chain;
  protected readonly policy: SettlePolicy;
  readonly directory: Directory;
  private readonly onEvent?: (e: AgentEvent) => void;
  private readonly gas?: (address: Address, lamports: bigint) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.identity = opts.identity;
    this.did = opts.identity.did;
    this.clock = opts.clock;
    this.chain = opts.chain;
    this.policy = opts.policy;
    this.directory = opts.directory;
    this.onEvent = opts.onEvent;
    this.gas = opts.gas;
    this.transport = new RelayTransport({ url: opts.relayUrl, identity: opts.identity, outbox: opts.outbox });
    this.endpoint = new Endpoint({
      identity: opts.identity,
      transport: this.transport,
      clock: opts.clock,
      // The processor answers once the cluster confirms what it submitted: seconds on a busy real cluster, not milliseconds.
      timeoutMs: 120_000,
      freshness: { skewMs: 5 * 60_000, maxAgeMs: 60 * 24 * 3600_000 },
      onTraffic: opts.onTraffic ? (t) => opts.onTraffic!(this.name, t) : undefined,
    });
  }

  async start(): Promise<void> {
    this.transport.start();
    const end = Date.now() + 15000;
    while (this.transport.status !== "connected") {
      if (Date.now() > end) throw new Error(`${this.name} couldn't reach the relay`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  stop(): void {
    this.transport.stop();
    this.endpoint.close();
  }

  /**
   * Makes sure `addr` holds `min` lamports to spend on rent and network fees, on top of the minimum a key
   * itself must keep (an account may not drop below rent exemption).
   */
  protected async ensureSol(addr: Address, spend: bigint): Promise<void> {
    const min = spend + (await this.chain.rent(0));
    const have = await this.chain.lamports(addr);
    if (have >= min) return;
    if (this.gas) await this.gas(addr, min - have);
    else await this.chain.airdropLamports(addr, min - have);
  }

  nameOf(did: string): string {
    return did === this.did ? this.name : (this.directory.names[did] ?? `${did.slice(0, 16)}…`);
  }

  protected say(text: string): void {
    const e = { at: this.clock.iso(), who: this.name, text };
    this.events.push(e);
    this.onEvent?.(e);
  }

  protected payment(id: string): PaymentState {
    let p = this.payments.get(id);
    if (!p) {
      p = { id, acceptances: [], attestations: [], disputes: [], signed: [], received: {} };
      this.payments.set(id, p);
    }
    return p;
  }

  protected byTermsHash(h: string): PaymentState | undefined {
    for (const p of this.payments.values()) if (p.terms && hex(termsHash(p.terms)) === h) return p;
    return undefined;
  }

  /**
   * Inbound handling and local actions run one at a time. A handler must never await a request/response:
   * the relay delivers messages in order, so the response would queue behind the handler waiting for it.
   */
  protected serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Records an attestation this party received, and when (chain time), so the dispute window runs from receipt. */
  protected async noteAttestation(p: PaymentState, a: Attestation): Promise<void> {
    const h = hexHash(a);
    if (p.received[h] !== undefined) return;
    p.received[h] = Number(await this.chain.now());
    p.attestations.push(a);
  }

  /** The attester's latest verified word, from what this party holds plus `extra`, timed from when this party first saw it. */
  protected async latestCompletion(p: PaymentState, extra: Attestation[] = [], now?: number): Promise<{ a: Attestation; at: number } | undefined> {
    const t = p.terms!;
    const at = now ?? Number(await this.chain.now());
    const seen = new Map<string, { a: Attestation; at: number }>();
    for (const a of [...p.attestations, ...extra]) {
      const h = hexHash(a);
      if (seen.has(h) || a?.issuer !== t.conditions.attester || !(await verifySigned(a, t, a.issuer, this.clock))) continue;
      seen.set(h, { a, at: p.received[h] ?? at });
    }
    return [...seen.values()].sort((x, y) => x.at - y.at || Date.parse(x.a.at) - Date.parse(y.a.at)).at(-1);
  }

  /**
   * Builds the policy input from an evidence bundle plus everything this agent knows itself (design §8).
   * The attester's latest verified word counts, whoever sent it, timed from when this party first saw it.
   */
  protected async evaluate(role: "payer" | "payee" | "arbiter", p: PaymentState, evidence: Evidence, payeeCancels = false): Promise<PolicyDecision> {
    const t = p.terms!;
    const now = Number(await this.chain.now());
    const latest = await this.latestCompletion(p, evidence.attestations ?? [], now);
    const disputes = [...evidence.disputes, ...p.disputes.filter((d) => !evidence.disputes.some((e) => e.at === d.at && e.issuer === d.issuer))];
    const ruling = evidence.ruling && (await verifySigned(evidence.ruling, t, t.arbiter.did, this.clock)) ? { payeeUnits: evidence.ruling.payeeUnits } : null;
    return this.policy.decide({
      role,
      // Chain time, so every party agrees on when a window has passed.
      now,
      proposal: { payeeUnits: evidence.payeeUnits },
      terms: { amountUnits: t.amount.units, attester: t.conditions.attester, disputeWindowSeconds: t.conditions.disputeWindowSeconds },
      completion: latest ? { claim: latest.a.claim, atSeconds: latest.at } : null,
      disputes: disputes.map((d) => ({ issuer: d.issuer })),
      ruling,
      payeeCancels,
    });
  }

  /** Signs an outcome with this party's key for the payment, and sends it to the processor and the other parties. */
  protected async signOutcome(p: PaymentState, key: PaymentKey, evidence: Evidence, alsoTo: string[]): Promise<void> {
    const eh = evidenceHash(evidence);
    if (p.signed.some((s) => s.payeeUnits === evidence.payeeUnits && s.evidenceHash === hex(eh))) return;
    const message = outcomeMessage(this.chain.programId, p.escrow!, BigInt(evidence.payeeUnits), eh);
    const sig: OutcomeSignature = {
      termsHash: evidence.termsHash,
      escrow: p.escrow!,
      payeeUnits: evidence.payeeUnits,
      evidence,
      signer: key.address,
      signature: toB64u(key.sign(message)),
    };
    p.signed.push({ payeeUnits: evidence.payeeUnits, evidenceHash: hex(eh) });
    for (const to of [this.directory.processor, ...alsoTo]) await this.endpoint.notify(to, ESCROW_SIGN, sig);
  }
}


/** Whether an announced escrow is real and matches terms both parties signed, sent by the payer (review C6). */
export async function genuineOpening(agent: { chain: Chain; clock: Clock }, m: { terms: Terms; acceptances: unknown; escrow: Address }, sender: string): Promise<boolean> {
  if (!m?.terms || sender !== m.terms.payer?.did) return false;
  if (!(await termsAgreed(m.terms, m.acceptances, agent.clock))) return false;
  return (await escrowProblems(agent.chain, m.escrow, m.terms)).length === 0;
}

/** Both parties' acceptances of the terms, checked. */
export async function termsAgreed(t: Terms, acceptances: unknown, clock: AgentOptions["clock"]): Promise<boolean> {
  if (!Array.isArray(acceptances)) return false;
  const ok = async (did: string) => {
    for (const a of acceptances) if (await verifyAcceptance(a as Acceptance, t, did, clock)) return true;
    return false;
  };
  return (await ok(t.payer.did)) && (await ok(t.payee.did));
}

/**
 * Everything about an on-chain escrow that must match the terms (review C4): the account belongs to the Settle
 * program at the address the payer's key and the terms hash give, and every field is what was agreed.
 */
export async function escrowProblems(chain: Chain, escrow: Address, t: Terms): Promise<string[]> {
  if (escrow !== (await escrowAddress(chain.programId, t.payer.paymentKey, termsHash(t)))) return ["not the escrow address for these terms"];
  const s = await chain.escrow(escrow);
  if (!s) return ["no Settle escrow at that address"];
  const problems: string[] = [];
  const want: [string, unknown, unknown][] = [
    ["state", s.state, STATE.funded],
    ["terms hash", hex(s.termsHash), hex(termsHash(t))],
    ["amount", s.amount, BigInt(t.amount.units)],
    ["fee", s.fee, BigInt(t.fee.units)],
    ["token", s.mint, t.amount.mint],
    ["payer key", s.payer, t.payer.paymentKey],
    ["payee key", s.payee, t.payee.paymentKey],
    ["arbiter key", s.arbiter, t.arbiter.key],
    ["threshold", s.threshold, t.threshold],
    ["fee account", s.feeAccount, t.fee.account],
    ["deadline", s.refundAfter, BigInt(t.refundAfter)],
  ];
  for (const [name, got, expected] of want) if (got !== expected) problems.push(`${name} doesn't match`);
  return problems;
}

/** Checks an outcome signature against the message it claims to sign. */
export function verifyOutcomeSignature(programId: Address, s: OutcomeSignature): boolean {
  try {
    const message = outcomeMessage(programId, s.escrow, BigInt(s.payeeUnits), evidenceHash(s.evidence));
    return ed25519.verify(fromB64u(s.signature), message, addressBytes(s.signer));
  } catch {
    return false;
  }
}
