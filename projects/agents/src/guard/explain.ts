/** Decisions as people and models see them: mandates' explain, plus the guard's own checks of a quote against its job. */
import { explain, type Decision, type Reason } from "@zk-toip/mandates";
import { DIMENSION_LABELS, SPEND_ATTRS, usdc } from "../config";
import type { DecisionView } from "./api";

/** The guard's own reason codes, beside the library's. */
export const GUARD_SENTENCES: Record<string, (r: Reason) => string> = {
  "quote.mismatch": (r) => `The quote doesn't match the job that was offered: ${r.detail}.`,
  "agent.noMandate": () => "This agent holds no mandate yet.",
  "agent.revoked": () => "This agent's mandate was revoked.",
};

export const formatValue = (u: string, attr: string): string => {
  if (SPEND_ATTRS.has(attr) && /^\d+$/.test(u)) return usdc(u);
  if (attr === "disputeWindowSeconds") return `${Number(u) / 86400} days`;
  return u;
};

export function decisionView(d: Decision, o: { name: (did: string) => string; extra?: Reason[]; noun?: string; categorySource?: DecisionView["categorySource"] }): DecisionView {
  const extra = o.extra ?? [];
  const outcome: Decision["outcome"] = extra.length ? "deny" : d.outcome;
  const base = explain({ ...d, outcome }, { name: o.name, units: (u, attr) => (u.startsWith("did:") ? o.name(u) : formatValue(u, attr)), label: (dim) => DIMENSION_LABELS[dim], noun: o.noun ?? "this payment" });
  const own = extra.map((r) => (GUARD_SENTENCES[r.code] ?? ((x: Reason) => `Refused: ${x.code}.`))(r));
  const sentences = [...own, ...base];
  if (o.categorySource === "the job as declared" && d.reasons.some((r) => r.dimension === "categories")) sentences.push("The category is the one the job declared; the worker showed no verified category.");
  return {
    outcome,
    sentences,
    reasons: [...extra, ...d.reasons].map((r) => ({ code: r.code, approvable: r.approvable, ...(r.dimension ? { dimension: r.dimension } : {}), ...(r.link !== undefined ? { link: r.link } : {}), ...(r.detail ? { detail: r.detail } : {}) })),
    actionHash: d.actionHash,
    approver: outcome === "escalate" ? d.approver : null,
    ...(o.categorySource ? { categorySource: o.categorySource } : {}),
  };
}

/** A refusal that doesn't come from the mandate engine (paused, no mandate). */
export function guardRefusal(code: string, sentence: string): DecisionView {
  return { outcome: "deny", sentences: [sentence], reasons: [{ code, approvable: false }], actionHash: "", approver: null };
}
