/** Issuing a root mandate, and delegating a narrower one (agents design §7). */
import { signDocument, type Clock, type Identity } from "@toip-tools/trust-core";
import { newId } from "./approval.js";
import { narrows } from "./engine.js";
import { mandateHash } from "./hash.js";
import { getProfile } from "./profiles.js";
import { checkMandate, checkRoot } from "./shape.js";
import type { Constraint, Mandate, MandateSubject, Reason, StatusEntry } from "./types.js";

function build(issuer: Identity, clock: Clock, subject: MandateSubject, validUntil: string, status: StatusEntry): Mandate {
  const s: MandateSubject = { ...subject };
  if (s.escalation === undefined) delete s.escalation;
  if (s.purpose === undefined) delete s.purpose;
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: newId(),
    type: ["VerifiableCredential", "Mandate"],
    issuer: issuer.did,
    validFrom: clock.iso(),
    validUntil,
    credentialSubject: s as Mandate["credentialSubject"],
    credentialStatus: status,
  };
}

export type IssueOptions = { subject: string; validUntil: string; status: StatusEntry } & Omit<MandateSubject, "id" | "mandateVersion" | "parent">;

/** Signs a root mandate. Throws if it is malformed, e.g. a settle/1 root without a budget. */
export function issueMandate(issuer: Identity, clock: Clock, o: IssueOptions): Mandate {
  const { subject, validUntil, status, ...rest } = o;
  const m = build(issuer, clock, { ...rest, id: subject, mandateVersion: 1, parent: null }, validUntil, status);
  let problems = checkMandate(m, 0);
  if (problems.length === 0) problems = checkRoot(m, getProfile(m.credentialSubject.profile)!);
  if (problems.length) throw new Error(`malformed mandate: ${problems.map((p) => p.detail ?? `${p.code} ${p.dimension ?? ""}`).join("; ")}`);
  return signDocument(m, issuer, clock);
}

export interface DelegateOptions {
  subject: string;
  validUntil: string;
  status: StatusEntry;
  /** Narrower versions of the parent's dimensions. */
  tighten: Partial<Record<string, Constraint>>;
  /** New dimensions. */
  add?: Record<string, Constraint>;
  purpose?: string;
  /** Default: the parent's minus one. */
  maxDepth?: number;
  /** Default: the parent's. */
  escalation?: MandateSubject["escalation"];
  /** Default: the parent's. */
  revocation?: MandateSubject["revocation"];
}

/**
 * Issues a child of the chain's leaf, signed by the leaf's subject. The child starts as a copy of the
 * leaf, tightened and extended. If it doesn't narrow, nothing is signed and the problems come back.
 */
export async function delegate(parentChain: Mandate[], delegator: Identity, clock: Clock, o: DelegateOptions): Promise<{ mandate: Mandate } | { problems: Reason[] }> {
  const leaf = parentChain[parentChain.length - 1];
  if (!leaf) return { problems: [{ code: "chain.malformed", detail: "no parent", approvable: false }] };
  const ls = leaf.credentialSubject;
  if (delegator.did !== ls.id) return { problems: [{ code: "chain.brokenLink", detail: "the delegator isn't the subject of the parent mandate", approvable: false }] };
  const problems: Reason[] = [];
  for (const k of Object.keys(o.tighten)) if (!(k in ls.constraints)) problems.push({ code: "chain.malformed", dimension: k, detail: `the parent has no dimension ${k} to tighten`, approvable: false });
  for (const k of Object.keys(o.add ?? {})) if (k in ls.constraints) problems.push({ code: "chain.malformed", dimension: k, detail: `the parent already has a dimension ${k}`, approvable: false });
  if (problems.length) return { problems };
  const constraints: Record<string, Constraint> = structuredClone(ls.constraints);
  for (const [k, c] of Object.entries(o.tighten)) if (c) constraints[k] = c;
  Object.assign(constraints, o.add ?? {});
  const child = build(
    delegator,
    clock,
    {
      id: o.subject,
      mandateVersion: 1,
      profile: ls.profile,
      ...(o.purpose !== undefined ? { purpose: o.purpose } : {}),
      parent: { id: leaf.id, hash: mandateHash(leaf) },
      constraints,
      delegation: { maxDepth: o.maxDepth ?? Math.max(0, ls.delegation.maxDepth - 1) },
      ...(o.escalation ?? ls.escalation ? { escalation: o.escalation ?? ls.escalation } : {}),
      revocation: o.revocation ?? ls.revocation,
    },
    o.validUntil,
    o.status,
  );
  const found = await narrows(leaf, child);
  if (found.length) return { problems: found };
  return { mandate: signDocument(child, delegator, clock) };
}
