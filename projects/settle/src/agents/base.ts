/**
 * What every Settle party has: a ToIP identity, a TSP endpoint on the relay, a view of the chain,
 * the payment policy, and what it has learned about each payment.
 */
import { Endpoint, RelayTransport, fromB64u, toB64u, type Clock, type Identity, type Traffic } from "@zk-toip/trust-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Address } from "@solana/kit";
import { addressBytes, outcomeMessage } from "../chain/escrow";
import type { PaymentKey } from "../chain/keys";
import type { Simnet } from "../chain/simnet";
import {
  evidenceHash,
  termsHash,
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
  arbiter: { did: string; key: Address };
  licensingBoard: string;
  mint: Address;
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
  net: Simnet;
  policy: SettlePolicy;
  directory: Directory;
  onEvent?: (e: AgentEvent) => void;
  onTraffic?: (who: string, t: Traffic) => void;
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
  protected readonly clock: Clock;
  protected readonly net: Simnet;
  protected readonly policy: SettlePolicy;
  protected readonly directory: Directory;
  private readonly onEvent?: (e: AgentEvent) => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.identity = opts.identity;
    this.did = opts.identity.did;
    this.clock = opts.clock;
    this.net = opts.net;
    this.policy = opts.policy;
    this.directory = opts.directory;
    this.onEvent = opts.onEvent;
    this.transport = new RelayTransport({ url: opts.relayUrl, identity: opts.identity });
    this.endpoint = new Endpoint({
      identity: opts.identity,
      transport: this.transport,
      clock: opts.clock,
      freshness: { skewMs: 5 * 60_000, maxAgeMs: 60 * 24 * 3600_000 },
      onTraffic: opts.onTraffic ? (t) => opts.onTraffic!(this.name, t) : undefined,
    });
  }

  async start(): Promise<void> {
    this.transport.start();
    const end = Date.now() + 5000;
    while (this.transport.status !== "connected") {
      if (Date.now() > end) throw new Error(`${this.name} couldn't reach the relay`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  stop(): void {
    this.transport.stop();
    this.endpoint.close();
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
      p = { id, acceptances: [], attestations: [], disputes: [], signed: [] };
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

  /** Builds the policy input from an evidence bundle plus what this agent knows itself (design §8). */
  protected async evaluate(role: "payer" | "payee" | "arbiter", p: PaymentState, evidence: Evidence, payeeCancels = false): Promise<PolicyDecision> {
    const t = p.terms!;
    const attestations = await Promise.all(
      evidence.attestations.map(async (a) => ({
        issuer: a.issuer,
        claim: a.claim,
        atSeconds: Math.floor(Date.parse(a.at) / 1000),
        verified: await verifySigned(a, t, a.issuer, this.clock),
      })),
    );
    const disputes = [...evidence.disputes, ...p.disputes.filter((d) => !evidence.disputes.some((e) => e.at === d.at && e.issuer === d.issuer))];
    const ruling = evidence.ruling && (await verifySigned(evidence.ruling, t, t.arbiter.did, this.clock)) ? { payeeUnits: evidence.ruling.payeeUnits } : null;
    return this.policy.decide({
      role,
      now: Math.floor(this.clock.now() / 1000),
      proposal: { payeeUnits: evidence.payeeUnits },
      terms: { amountUnits: t.amount.units, attester: t.conditions.attester, disputeWindowSeconds: t.conditions.disputeWindowSeconds },
      attestations,
      disputes: disputes.map((d) => ({ issuer: d.issuer })),
      ruling,
      payeeCancels,
    });
  }

  /** Signs an outcome with this party's key for the payment, and sends it to the processor and the other parties. */
  protected async signOutcome(p: PaymentState, key: PaymentKey, evidence: Evidence, alsoTo: string[]): Promise<void> {
    const eh = evidenceHash(evidence);
    if (p.signed.some((s) => s.payeeUnits === evidence.payeeUnits && s.evidenceHash === hex(eh))) return;
    const message = outcomeMessage(this.net.programId, p.escrow!, BigInt(evidence.payeeUnits), eh);
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


/** Checks an outcome signature against the message it claims to sign. */
export function verifyOutcomeSignature(programId: Address, s: OutcomeSignature): boolean {
  try {
    const message = outcomeMessage(programId, s.escrow, BigInt(s.payeeUnits), evidenceHash(s.evidence));
    return ed25519.verify(fromB64u(s.signature), message, addressBytes(s.signer));
  } catch {
    return false;
  }
}
