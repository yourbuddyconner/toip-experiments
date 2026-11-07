/** A mandate in plain words, for the console and the terminal. Browser-safe. */
import type { Constraint, Mandate } from "@zk-toip/mandates";

const usdc = (u: string | number) => `${(Number(u) / 1e6).toFixed(2)} USDC`;
const PERIOD: Record<string, string> = { P1D: "per day", P7D: "per week", P30D: "per 30 days", total: "in total" };
const list = (xs: string[], names: (d: string) => string) => xs.map((x) => (x.startsWith("did:") ? names(x) : x)).join(" or ");

export interface MandateLine {
  dimension: string;
  text: string;
}

export function mandateLines(m: Mandate, names: (did: string) => string): MandateLine[] {
  const s = m.credentialSubject;
  const out: MandateLine[] = [];
  const c = s.constraints;
  const spend: string[] = [];
  for (const [dim, k] of Object.entries(c) as [string, Constraint][]) {
    if (k.attr === "spend" && "max" in k) spend.push(`${usdc(String(k.max))} per payment`);
    if (k.attr === "spend" && "budget" in k) spend.push(`${usdc(k.budget)} ${PERIOD[k.period] ?? k.period}`);
    void dim;
  }
  if (spend.length) out.push({ dimension: "spend", text: `Up to ${spend.join("; ")}.` });
  for (const [dim, k] of Object.entries(c) as [string, Constraint][]) {
    if (k.attr === "category" && "within" in k) out.push({ dimension: dim, text: `Only for work in: ${k.within.join(", ")}.` });
    else if (k.attr === "attester" && "anyOf" in k) out.push({ dimension: dim, text: `Work must be confirmed by ${list(k.anyOf, names)}.` });
    else if (k.attr === "arbiter" && "anyOf" in k) out.push({ dimension: dim, text: `Disputes go to ${list(k.anyOf, names)}.` });
    else if (k.attr === "type" && "anyOf" in k) out.push({ dimension: dim, text: `May: ${k.anyOf.join(", ")}.` });
    else if (k.attr === "price" && "min" in k) out.push({ dimension: dim, text: `Never quotes under ${usdc(String(k.min))}.` });
    else if (k.attr === "price" && "max" in k) out.push({ dimension: dim, text: `Never quotes over ${usdc(String(k.max))}.` });
    else if (k.attr === "counterpartyCredentials" && "anyOf" in k) out.push({ dimension: dim, text: `Only pays workers holding ${k.anyOf.join(" or ")}.` });
  }
  out.push({ dimension: "delegation", text: s.delegation.maxDepth > 0 ? `May pass a narrower mandate on, ${s.delegation.maxDepth} level${s.delegation.maxDepth > 1 ? "s" : ""} deep.` : "May not delegate." });
  if (s.escalation?.approvable.length) out.push({ dimension: "escalation", text: `Over a limit in ${s.escalation.approvable.join(", ")}, ${s.parent ? "the root principal" : names(m.issuer)} can approve one exact action, for up to ${Math.round(s.escalation.approvalTtlSeconds / 60)} minutes.` });
  out.push({ dimension: "window", text: `Valid until ${m.validUntil.slice(0, 16).replace("T", " ")} UTC. Revocation lists must be under ${Math.round(s.revocation.maxAgeSeconds / 60)} minutes old.` });
  return out;
}

/** The constraints a child narrowed, side by side with its parent's. */
export function narrowingRows(parent: Mandate, child: Mandate): { dimension: string; parent: string; child: string }[] {
  const show = (k?: Constraint) => {
    if (!k) return "—";
    if ("max" in k) return k.attr === "spend" || k.attr === "price" ? `≤ ${usdc(String(k.max))}` : `≤ ${k.max}`;
    if ("min" in k) return `≥ ${k.min}`;
    if ("budget" in k) return `${usdc(k.budget)} ${PERIOD[k.period]}`;
    if ("within" in k) return k.within.join(", ");
    if ("anyOf" in k) return `${k.anyOf.length} allowed`;
    if ("noneOf" in k) return `none of ${k.noneOf.length}`;
    return String((k as { is: unknown }).is);
  };
  const dims = new Set([...Object.keys(parent.credentialSubject.constraints), ...Object.keys(child.credentialSubject.constraints)]);
  const rows = [...dims].map((d) => ({ dimension: d, parent: show(parent.credentialSubject.constraints[d]), child: show(child.credentialSubject.constraints[d]) }));
  rows.push({ dimension: "delegation depth", parent: String(parent.credentialSubject.delegation.maxDepth), child: String(child.credentialSubject.delegation.maxDepth) });
  rows.push({ dimension: "valid until", parent: parent.validUntil.slice(0, 16).replace("T", " "), child: child.validUntil.slice(0, 16).replace("T", " ") });
  return rows;
}
