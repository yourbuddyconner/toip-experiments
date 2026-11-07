/**
 * The worker's gates (design §11.3): before invoicing an agent, check its mandate presentation against the
 * payment link; before agreeing terms, check the terms match the presented action. Used by people (Dana's
 * view) and by worker agents alike. HTTP and CPU only: these run inside Settle's handlers.
 */
import { checkTrailRef, endorse, toStream, type WitnessClient } from "@zk-toip/eventlog";
import { jcsHash, type Decision, type MandateEngine, type Presentation, type Requirements, type StatusResolver } from "@zk-toip/mandates";
import type { Clock, Identity } from "@zk-toip/trust-core";
import type { PayeeGates, PaymentLink } from "@zk-toip/settle/src/agents/party";
import type { Terms } from "@zk-toip/settle/src/protocol/documents";
import { termsHash } from "@zk-toip/settle/src/protocol/documents";
import { hex } from "@zk-toip/settle/src/agents/base";
import { decisionView } from "./explain";
import type { DecisionView } from "./api";

export interface GateRecord {
  checkout: string;
  sender: string;
  link: PaymentLink;
  presentation: Presentation;
  decision: Decision;
  view: DecisionView;
  /** Whether the presentation's trail entry was found at a witness and endorsed. */
  trailChecked: boolean;
  termsHash?: string;
  at: string;
}

export interface GateOptions {
  me: Identity;
  engine: MandateEngine;
  status: StatusResolver;
  requirements: Requirements;
  clock: Clock;
  mint: string;
  arbiter: string;
  feeFor: (price: bigint) => bigint;
  name: (did: string) => string;
  /** A witness reached over HTTP, to check and endorse the presentation's trailRef. Without one, it isn't checked. */
  witness?: WitnessClient;
  /** Told about every refusal, e.g. to send agents/job/refused. Must not await a TSP request. */
  onRefused?: (r: { sender: string; link: PaymentLink; reasons: string[] }) => void;
  onAllowed?: (r: GateRecord) => void;
}

export type MandateGates = Required<PayeeGates> & { records: Map<string, GateRecord>; byTerms(h: string): GateRecord | undefined };

/** Where the presented action differs from the link, in words. Empty means it matches. */
export function actionMismatch(p: Presentation, link: PaymentLink, o: { me: string; sender: string; mint: string; arbiter: string; fee: bigint }): string[] {
  const a = p?.action;
  const at = (a?.attrs ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (a?.type !== "settle/pay") out.push("the presented action isn't a payment");
  if (at.counterparty !== o.me) out.push("the presented payment is to someone else");
  if (at.price !== link.units) out.push("the presented price isn't this link's");
  if (at.link !== jcsHash(link)) out.push("the presentation is for another payment link");
  const attester = link.release === "payer-confirms" ? o.sender : link.attester;
  if (at.attester !== attester) out.push("the presented attester isn't this link's");
  if (at.disputeWindowSeconds !== link.disputeWindowDays * 86400) out.push("the presented dispute window isn't this link's");
  if (at.asset !== o.mint) out.push("the presented token isn't Settle's");
  if (at.arbiter !== o.arbiter) out.push("the presented arbiter isn't Settle's");
  if (at.spend !== String(BigInt(link.units) + o.fee)) out.push("the presented spend isn't the price plus the processor's fee");
  return out;
}

export function mandateGates(o: GateOptions): MandateGates {
  const records = new Map<string, GateRecord>();
  const refuse = (sender: string, link: PaymentLink, reasons: string[]) => {
    o.onRefused?.({ sender, link, reasons });
    return reasons.join(" ");
  };
  return {
    records,
    byTerms: (h) => [...records.values()].find((r) => r.termsHash === h),
    async beforeInvoice({ link, sender, attachments, checkout }) {
      const p = (attachments as { presentation?: Presentation } | undefined)?.presentation;
      if (!p) return refuse(sender, link, ["No mandate presentation came with the payment."]);
      const mismatch = actionMismatch(p, link, { me: o.me.did, sender, mint: o.mint, arbiter: o.arbiter, fee: o.feeFor(BigInt(link.units)) });
      if (mismatch.length) return refuse(sender, link, mismatch.map((m) => `${m[0].toUpperCase()}${m.slice(1)}.`));
      const decision = await o.engine.verifyPresentation(p, { sender, me: o.me.did, status: o.status, requirements: o.requirements, clock: o.clock });
      const view = decisionView(decision, { name: o.name });
      if (decision.outcome !== "allow") return refuse(sender, link, view.sentences);
      let trailChecked = false;
      if (o.witness) {
        if (!p.trailRef) return refuse(sender, link, ["The presentation names no audit trail entry."]);
        const r = await checkTrailRef(p.trailRef, o.witness).catch(() => null);
        if (!r?.ok || !r.entry) return refuse(sender, link, ["The agent's decision for this payment isn't witnessed."]);
        if (r.entry.body?.k !== "agent/mandate-decision") return refuse(sender, link, ["The presentation's trail entry isn't a mandate decision."]);
        // Endorse it, so the agent can't later deny having made this decision (trail design §12.1).
        await o.witness.addReceipts(toStream([endorse(r.entry, o.me, o.clock.iso())])).catch(() => undefined);
        trailChecked = true;
      }
      const rec: GateRecord = { checkout, sender, link, presentation: p, decision, view, trailChecked, at: o.clock.iso() };
      records.set(checkout, rec);
      o.onAllowed?.(rec);
      return null;
    },
    async beforeAccept({ terms, sender, checkout }) {
      const rec = checkout ? records.get(checkout) : undefined;
      if (!rec) return ["no checked mandate presentation for these terms"];
      const problems = termsMismatch(terms, rec.presentation, sender);
      if (!problems.length) rec.termsHash = hex(termsHash(terms));
      return problems;
    },
  };
}

/** The terms against the presented action: payer, price, fee, attester, arbiter, token and window. */
export function termsMismatch(t: Terms, p: Presentation, sender: string): string[] {
  const at = p.action.attrs as Record<string, unknown>;
  const out: string[] = [];
  if (t.payer.did !== sender || p.issuer !== sender) out.push("the payer isn't the agent that presented");
  if (t.amount.units !== at.price) out.push("the price isn't the presented one");
  if (String(BigInt(t.amount.units) + BigInt(t.fee.units)) !== at.spend) out.push("the fee isn't the presented one");
  if (t.conditions.attester !== at.attester) out.push("the attester isn't the presented one");
  if (t.arbiter.did !== at.arbiter) out.push("the arbiter isn't the presented one");
  if (t.amount.mint !== at.asset) out.push("the token isn't the presented one");
  if (t.conditions.disputeWindowSeconds !== at.disputeWindowSeconds) out.push("the dispute window isn't the presented one");
  return out;
}
