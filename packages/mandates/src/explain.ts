/** Decisions in plain sentences (agents design §8.3). Every reason code has one sentence template. */
import type { Decision, Period, Reason, Units } from "./types";

export interface ExplainOptions {
  /** A person's or an agent's name for a DID. Default: the DID. */
  name?: (did: string) => string;
  /** How to show a value of an attribute, e.g. units of USDC. Default: as is. */
  units?: (u: Units, attr: string) => string;
  /** A phrase for a dimension, e.g. spendPerTx → "per payment". Default: the dimension's name. */
  label?: (dimension: string) => string | undefined;
  /** What is being decided, e.g. "this payment". Default: "this action". */
  noun?: string;
}

type Ctx = Required<Omit<ExplainOptions, "label">> & { label: (d: string) => string | undefined; d: Decision };
type Template = (r: Reason, c: Ctx) => string;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const PERIOD_TEXT: Record<Period, string> = {
  P1D: "the spending in the last day",
  P7D: "the spending in the last 7 days",
  P30D: "the spending in the last 30 days",
  total: "the total",
};

function fmt(v: unknown, attr: string | undefined, c: Ctx): string {
  if (Array.isArray(v)) return v.map((x) => fmt(x, attr, c)).join(", ");
  if (typeof v === "string" || typeof v === "number") return c.units(String(v), attr ?? "");
  return String(v);
}

const issuer = (r: Reason, c: Ctx) => c.name(c.d.parties[r.link ?? -1]?.issuer ?? "someone");
const subject = (r: Reason, c: Ctx) => c.name(c.d.parties[r.link ?? -1]?.subject ?? "someone");
const allowed = (r: Reason, c: Ctx) => `${issuer(r, c)} allowed ${subject(r, c)}`;
const mandate = (r: Reason, c: Ctx) => (c.d.parties[r.link ?? -1] ? `the mandate from ${issuer(r, c)} to ${subject(r, c)}` : "a mandate in the chain");
const lab = (r: Reason, c: Ctx) => c.label(r.dimension ?? "") ?? r.dimension ?? "a limit";
const v = (r: Reason, c: Ctx) => fmt(r.value, r.attr, c);
const l = (r: Reason, c: Ctx) => fmt(r.limit, r.attr, c);
const detail = (r: Reason) => (r.detail ? `: ${r.detail}` : "");

const CONSTRAINT: Record<string, Template> = {
  max: (r, c) =>
    c.label(r.dimension ?? "")
      ? `${v(r, c)} is more than the ${l(r, c)} ${c.label(r.dimension ?? "")} that ${allowed(r, c)}.`
      : `${v(r, c)} is more than the limit of ${l(r, c)} (${r.dimension}) that ${allowed(r, c)}.`,
  min: (r, c) =>
    c.label(r.dimension ?? "")
      ? `${v(r, c)} is less than the ${l(r, c)} ${c.label(r.dimension ?? "")} that ${allowed(r, c)}.`
      : `${v(r, c)} is less than the minimum of ${l(r, c)} (${r.dimension}) that ${allowed(r, c)}.`,
  anyOf: (r, c) => `The ${r.attr} “${v(r, c)}” isn't one ${allowed(r, c)} (${lab(r, c)}).`,
  noneOf: (r, c) => `The ${r.attr} “${v(r, c)}” is one ${issuer(r, c)} ruled out for ${subject(r, c)} (${lab(r, c)}).`,
  within: (r, c) => `The ${r.attr} “${v(r, c)}” is outside what ${allowed(r, c)} (${lab(r, c)}).`,
  is: (r, c) => `The ${r.attr} is “${v(r, c)}”, but ${allowed(r, c)} only “${l(r, c)}” (${lab(r, c)}).`,
};

function requirement(r: Reason, c: Ctx): string {
  switch (r.requirement) {
    case "maxLinks":
      return `at most ${r.limit} links in a chain, and this one has ${r.value}`;
    case "rootMustHold": {
      const [type, from] = String(r.limit).split("@");
      return `the root to hold a ${type} credential from ${c.name(from ?? "")}`;
    }
    case "passport":
      return "a passport for the delegate";
    case "passportIssuerMustBeRoot":
      return `a passport issued by ${c.name(String(r.limit ?? c.d.parties[0]?.issuer ?? "the root"))}`;
    default:
      return `something this chain doesn't meet (${r.requirement ?? "unnamed"})`;
  }
}

const SENTENCES: Record<string, Template> = {
  "chain.malformed": (r) => `The mandate chain is malformed${detail(r)}.`,
  "constraint.unknownOp": (r, c) => `${cap(mandate(r, c))} has a limit this verifier doesn't understand (${r.dimension}${r.op ? `: ${r.op}` : ""}).`,
  "action.malformed": (r) => `The action is malformed${detail(r)}.`,
  "presentation.invalid": (r) => `The presentation doesn't verify${detail(r)}.`,
  "presentation.wrongAudience": () => "The presentation is meant for someone else.",
  "chain.signatureInvalid": (r, c) => `${cap(mandate(r, c))} has a signature that doesn't verify.`,
  "chain.brokenLink": (r, c) => `${cap(mandate(r, c))} isn't linked to the mandate above it${detail(r)}.`,
  "chain.notPresenter": () => "The mandate chain was presented by someone it wasn't issued to.",
  "chain.cycle": () => "The mandate chain goes in a circle.",
  "chain.notYetValid": (r, c) => `${cap(mandate(r, c))} isn't valid yet.`,
  "chain.expired": (r, c) => `${cap(mandate(r, c))} has expired.`,
  "status.revoked": (r, c) => `${issuer(r, c)} has revoked the mandate to ${subject(r, c)}.`,
  "status.stale": (r, c) => `The revocation list for ${mandate(r, c)} is too old to rely on.`,
  "status.unavailable": (r, c) => `The revocation list for ${mandate(r, c)} can't be fetched.`,
  "status.wrongIssuer": (r, c) => `The revocation list for ${mandate(r, c)} isn't signed by ${issuer(r, c)}.`,
  "chain.profileMismatch": () => "The action and the mandates don't use the same profile.",
  "narrowing.widened": (r, c) => `${cap(mandate(r, c))} widens ${lab(r, c)}, which a delegate may only narrow.`,
  "narrowing.dropped": (r, c) => `${cap(mandate(r, c))} drops the limit ${lab(r, c)}.`,
  "narrowing.changedMeaning": (r, c) => `${cap(mandate(r, c))} changes what ${lab(r, c)} limits.`,
  "narrowing.depth": (r, c) => `${cap(mandate(r, c))} delegates further than the mandate above it allows.`,
  "narrowing.window": (r, c) => `${cap(mandate(r, c))} is valid outside the time the mandate above it allows.`,
  "narrowing.escalation": (r, c) => `${cap(mandate(r, c))} allows more approvals than the mandate above it.`,
  "narrowing.revocation": (r, c) => `${cap(mandate(r, c))} accepts older revocation lists than the mandate above it.`,
  "attr.missing": (r, c) => `The action doesn't say its ${r.attr}, which ${issuer(r, c)} requires of ${subject(r, c)} (${lab(r, c)}).`,
  "constraint.failed": (r, c) => (CONSTRAINT[r.op ?? ""] ?? ((x, y) => `The ${x.attr} is outside what ${allowed(x, y)} (${lab(x, y)}).`))(r, c),
  "budget.exceeded": (r, c) => {
    let sum = "";
    try {
      sum = fmt(String(BigInt(String(r.spent ?? "0")) + BigInt(String(r.value ?? "0"))), r.attr, c);
    } catch {
      sum = "more";
    }
    return `Spending ${v(r, c)} would bring ${PERIOD_TEXT[r.period as Period] ?? "the spending"} to ${sum}, over the ${l(r, c)} budget that ${allowed(r, c)} (${lab(r, c)}).`;
  },
  "approval.invalid": (r) => `An approval doesn't verify${detail(r)}.`,
  "approval.expired": () => "An approval has expired.",
  "approval.used": () => "An approval was already used.",
  "approval.wrongAction": () => "An approval is for a different action.",
  "approval.notInChain": () => "An approval is from someone who isn't in the mandate chain.",
  "requirement.failed": (r, c) => `This verifier requires ${requirement(r, c)}.`,
  "agent.paused": () => "The principal has paused this agent.",
};

/** Every reason code this library produces. */
export const REASON_CODES: readonly string[] = Object.keys(SENTENCES);

export const hasSentence = (code: string): boolean => code in SENTENCES;

/** One sentence per reason, then one for the outcome. */
export function explain(d: Decision, o: ExplainOptions = {}): string[] {
  const c: Ctx = { name: o.name ?? ((x) => x), units: o.units ?? ((u) => u), label: o.label ?? (() => undefined), noun: o.noun ?? "this action", d };
  const lines = d.reasons.map((r) => (SENTENCES[r.code] ? SENTENCES[r.code](r, c) : `Refused for a reason this version can't describe: ${r.code}.`));
  if (d.outcome === "allow") {
    const root = d.parties[0]?.issuer;
    const leaf = d.parties[d.parties.length - 1]?.subject;
    lines.push(root && leaf ? `${cap(c.noun)} is within every limit of the chain from ${c.name(root)} to ${c.name(leaf)}.` : `${cap(c.noun)} is allowed.`);
  } else if (d.outcome === "escalate") lines.push(`${d.approver ? c.name(d.approver) : "The principal"} can approve ${c.noun}.`);
  else lines.push(`${cap(c.noun)} can't go ahead.`);
  return lines;
}
