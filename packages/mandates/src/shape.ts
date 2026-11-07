/** Step 1 of §8.2: the shape of mandates, constraints and actions. Anything odd is malformed. */
import { getProfile } from "./profiles";
import { OPS, PERIODS, type Action, type Mandate, type Profile, type Reason } from "./types";

export const MAX_LINKS = 5;
export const MAX_DIMENSIONS = 32;
export const MAX_SET = 256;
export const MAX_DEPTH = MAX_LINKS - 1;
const MAX_UNITS = Number.MAX_SAFE_INTEGER;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isStrings = (x: unknown, min = 0): x is string[] => Array.isArray(x) && x.length >= min && x.length <= MAX_SET && x.every((e) => typeof e === "string");
const isTime = (x: unknown): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x));
const isCount = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min;

/** A decimal integer string from 0 to 2^53 − 1. */
export function isUnits(x: unknown): x is string {
  return typeof x === "string" && /^(0|[1-9][0-9]{0,15})$/.test(x) && Number(x) <= MAX_UNITS;
}

const isLimit = (x: unknown) => isUnits(x) || isCount(x);

/** Exact, or ending in ".*" or "/*", with no other "*". */
export function isPattern(p: unknown): p is string {
  if (!isStr(p)) return false;
  const body = p.endsWith(".*") || p.endsWith("/*") ? p.slice(0, -1) : p;
  return body.length > 0 && !body.includes("*");
}

const malformed = (detail: string, link?: number, dimension?: string): Reason => ({
  code: "chain.malformed",
  ...(link !== undefined ? { link } : {}),
  ...(dimension !== undefined ? { dimension } : {}),
  detail,
  approvable: false,
});

export function checkConstraint(name: string, c: unknown, link?: number): Reason[] {
  if (!isObj(c)) return [malformed("a constraint isn't an object", link, name)];
  const out: Reason[] = [];
  const ops = Object.keys(c).filter((k) => (OPS as readonly string[]).includes(k));
  for (const k of Object.keys(c)) {
    if (k === "attr" || k === "when" || (k === "period" && "budget" in c) || ops.includes(k)) continue;
    out.push({ code: "constraint.unknownOp", ...(link !== undefined ? { link } : {}), dimension: name, op: k, approvable: false });
  }
  if (!isStr(c.attr)) out.push(malformed("a constraint has no attr", link, name));
  if ("when" in c && !isStrings(c.when, 1)) out.push(malformed("`when` must list at least one action type", link, name));
  if (ops.length !== 1) {
    if (out.length === 0 || ops.length > 1) out.push(malformed(ops.length ? "a constraint has more than one operator" : "a constraint has no operator", link, name));
    return out;
  }
  const op = ops[0];
  const v = c[op];
  const ok =
    op === "anyOf" || op === "noneOf"
      ? isStrings(v)
      : op === "within"
        ? isStrings(v) && v.every(isPattern)
        : op === "is"
          ? typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
          : op === "max" || op === "min"
            ? isLimit(v)
            : isUnits(v) && (PERIODS as readonly unknown[]).includes(c.period);
  if (!ok) out.push(malformed(`a bad value for ${op}`, link, name));
  return out;
}

/** Shape of one link. Problems name the link. */
export function checkMandate(m: unknown, link: number): Reason[] {
  if (!isObj(m)) return [malformed("a link isn't an object", link)];
  const out: Reason[] = [];
  const bad = (detail: string) => out.push(malformed(detail, link));
  if (!Array.isArray(m.type) || !m.type.includes("VerifiableCredential") || !m.type.includes("Mandate")) bad("it isn't a Mandate credential");
  if (!isStr(m.id)) bad("it has no id");
  if (!isStr(m.issuer)) bad("it has no issuer");
  if (!isTime(m.validFrom)) bad("it has no validFrom");
  if (!isTime(m.validUntil)) bad("it has no validUntil");
  const st = m.credentialStatus;
  if (!isObj(st) || st.type !== "BitstringStatusListEntry" || !isCount(st.statusListIndex) || !isStr(st.statusListCredential)) bad("it has no credentialStatus");
  const s = m.credentialSubject;
  if (!isObj(s)) {
    bad("it has no credentialSubject");
    return out;
  }
  if (!isStr(s.id)) bad("its subject has no id");
  if (s.mandateVersion !== 1) bad("mandateVersion must be 1");
  if (!isStr(s.profile) || !getProfile(s.profile)) bad(`unknown profile ${String(s.profile)}`);
  const parent = s.parent;
  if (parent !== null && !(isObj(parent) && isStr(parent.id) && isStr(parent.hash))) bad("parent must be null or { id, hash }");
  if (!isObj(s.delegation) || !isCount(s.delegation.maxDepth) || s.delegation.maxDepth > MAX_DEPTH) bad("delegation.maxDepth must be 0 to 4");
  if (!isObj(s.revocation) || !isCount(s.revocation.maxAgeSeconds, 1)) bad("revocation.maxAgeSeconds must be a positive integer");
  if (s.escalation !== undefined) {
    const e = s.escalation;
    if (!isObj(e) || !isStrings(e.approvable) || !isCount(e.approvalTtlSeconds, 1)) bad("escalation must be { approvable, approvalTtlSeconds }");
  }
  if (!isObj(s.constraints)) {
    bad("it has no constraints");
    return out;
  }
  const dims = Object.entries(s.constraints);
  if (dims.length > MAX_DIMENSIONS) bad(`more than ${MAX_DIMENSIONS} dimensions`);
  for (const [name, c] of dims) out.push(...checkConstraint(name, c, link));
  return out;
}

/** What a root must constrain: `actions` (attr "type") always, and what its profile requires. */
export function checkRoot(m: Mandate, profile: Profile): Reason[] {
  const cs = Object.values(m.credentialSubject.constraints);
  const out: Reason[] = [];
  for (const need of new Set(["type", ...profile.rootRequires])) {
    const [attr, op] = need.split(":");
    if (cs.some((c) => c.attr === attr && (!op || op in c))) continue;
    out.push(malformed(op === "budget" ? `a ${profile.id} root must set a budget on "${attr}"` : `a ${profile.id} root must constrain "${attr}"`, 0));
  }
  return out;
}

const actionBad = (detail: string): Reason => ({ code: "action.malformed", detail, approvable: false });

const isAttrValue = (v: unknown) =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.length <= MAX_SET && v.every((e) => typeof e === "string"));

export function checkAction(a: unknown, presenter: string): Reason[] {
  if (!isObj(a)) return [actionBad("the action isn't an object")];
  const out: Reason[] = [];
  for (const k of ["type", "profile", "id", "actor", "at"] as const) if (!isStr(a[k])) out.push(actionBad(`the action has no ${k}`));
  if (!isObj(a.attrs)) return [...out, actionBad("the action has no attrs")];
  const attrs = a.attrs;
  for (const [k, v] of Object.entries(attrs)) if (!isAttrValue(v)) out.push(actionBad(`attribute ${k} has a value of the wrong kind`));
  if (!isUnits(attrs.spend)) out.push(actionBad("spend must be a decimal integer of at most 2^53 − 1"));
  if (a.actor !== presenter) out.push(actionBad("its actor isn't the presenter"));
  const profile = typeof a.profile === "string" ? getProfile(a.profile) : undefined;
  if (profile) {
    const def = profile.actions[a.type as string];
    if (!def) out.push(actionBad(`${String(a.type)} isn't an action of ${profile.id}`));
    else for (const k of def.required) if (!(k in attrs)) out.push(actionBad(`it has no ${k}, which ${a.type} requires`));
  } else out.push(actionBad(`unknown profile ${String(a.profile)}`));
  return out;
}

export function isAction(a: unknown): a is Action {
  return isObj(a) && isObj(a.attrs);
}
