/**
 * Acts 2 and 3 carry a real Settle attestation: Settle's own document builders (projects/settle,
 * src/protocol/documents.ts) make the terms and Alice's signed `settle/attestation`, sent under Settle's
 * `settle/escrow/attest` spec. On the other end, a party accepts it the way a Settle agent does
 * (Party.onAttest): the terms are its own, the issuer is the terms' attester, and the signature verifies.
 * No chain is needed for that check, so none runs here.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Endpoint, ctt1, utf8, type Clock, type Identity, type Transport } from "@zk-toip/trust-core";
import { attest, bindPaymentKey, derivePaymentKey, hexHash, termsHash, verifySigned, type Attestation, type Terms } from "@zk-toip/settle/src/protocol/documents";
import { ESCROW_ATTEST } from "@zk-toip/settle/src/protocol/specs";
import { bytesAddress } from "@zk-toip/settle/src/chain/escrow";

export { ESCROW_ATTEST, attest, type Attestation, type Terms };

const addressFor = (label: string) => bytesAddress(sha256(utf8(`zk-toip/mesh-demo/address/${label}`)));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Terms for a payment, as the landlord's Settle agent would propose them, with Alice as attester. */
export async function demoTerms(o: {
  payment: string;
  purpose: string;
  units: bigint;
  payer: Identity;
  payee: Identity;
  attester: Identity;
  arbiter: Identity;
  clock: Clock;
}): Promise<Terms> {
  const payerKey = await derivePaymentKey(o.payer, o.payment);
  const payeeKey = await derivePaymentKey(o.payee, o.payment);
  const display = `${(Number(o.units) / 1e6).toFixed(2)} USDC`;
  const fee = o.units / 100n > 500_000n ? o.units / 100n : 500_000n;
  return {
    type: "settle/terms",
    version: 1,
    payment: o.payment,
    purpose: o.purpose,
    payer: { did: o.payer.did, paymentKey: payerKey.address, tokenAccount: addressFor(`${o.payment}/payer`), binding: bindPaymentKey(o.payer, payerKey, o.payment, o.clock) },
    payee: { did: o.payee.did, paymentKey: payeeKey.address, tokenAccount: addressFor(`${o.payment}/payee`), binding: bindPaymentKey(o.payee, payeeKey, o.payment, o.clock), credentials: [] },
    arbiter: { did: o.arbiter.did, key: addressFor("arbiter") },
    amount: { mint: addressFor("usdc"), units: o.units.toString(), display },
    conditions: { policy: "settle/policies/attested-completion/1", attester: o.attester.did, disputeWindowSeconds: 7 * 86400 },
    fee: { bps: 100, minUnits: "500000", units: fee.toString(), account: addressFor("fees"), to: addressFor("processor") },
    threshold: 2,
    refundAfter: Math.floor(o.clock.now() / 1000) + 30 * 86400,
  };
}

/**
 * An attestation may arrive days late: through a gateway's outbox, or on a USB stick. trust-core's default
 * window is 5 minutes, so this party accepts documents up to 3 days old (its replay record covers them).
 */
export const CARRIED_FRESHNESS = { skewMs: 10 * 60_000, maxAgeMs: 3 * 86400_000, requireIssuedAt: true };

export interface Accepted {
  payment: string;
  purpose: string;
  sender: string;
  claim: Attestation["claim"];
  note?: string;
  attestationHash: string;
}

/**
 * A Settle party's agent, online at home: it knows the terms it agreed, and accepts an attestation the
 * way Settle's Party does. It reads JSON and CTT1 bodies, like every Endpoint in this repository.
 */
export class SettleParty {
  readonly endpoint: Endpoint;
  readonly accepted: Accepted[] = [];
  readonly ignored: string[] = [];
  private readonly terms = new Map<string, Terms>();

  constructor(
    private readonly opts: { identity: Identity; transport: Transport; clock: Clock; onAccepted?: (a: Accepted) => void; onIgnored?: (why: string) => void },
  ) {
    this.endpoint = new Endpoint({ identity: opts.identity, transport: opts.transport, clock: opts.clock, bodyCodecFor: () => ctt1, freshness: CARRIED_FRESHNESS });
    this.endpoint.handle<Attestation, void>(ESCROW_ATTEST, async (doc, ctx) => {
      const a = doc.payload;
      const t = this.terms.get(a?.termsHash ?? "");
      const why = !t
        ? "an attestation for terms this party never agreed"
        : a.issuer !== t.conditions.attester
          ? "an attestation from someone who isn't the attester"
          : !(await verifySigned(a, t, a.issuer, opts.clock))
            ? "an attestation whose signature doesn't verify"
            : undefined;
      if (why || !t) {
        this.ignored.push(why ?? "unknown");
        opts.onIgnored?.(why ?? "unknown");
        return;
      }
      const ok: Accepted = { payment: t.payment, purpose: t.purpose, sender: ctx.sender, claim: a.claim, ...(a.note ? { note: a.note } : {}), attestationHash: hexHash(a) };
      this.accepted.push(ok);
      opts.onAccepted?.(ok);
    });
  }

  get did(): string {
    return this.opts.identity.did;
  }

  /** The terms this party agreed (online, before the act). */
  know(terms: Terms): void {
    this.terms.set(hex(termsHash(terms)), terms);
  }

  close(): void {
    this.endpoint.close();
  }
}
