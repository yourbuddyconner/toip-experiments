/** Approvals: a chain issuer's signature over the hash of one exact action (agents design §9). */
import { signDocument, verifyDocument, type Clock, type Identity } from "@toip-tools/trust-core";
import { actionHash, jcsHash } from "./hash";
import type { Action, Approval, Mandate, Reason } from "./types";

const SKEW_MS = 5 * 60_000;

export const newId = () => `urn:uuid:${globalThis.crypto.randomUUID()}`;

/** Signs an approval of `action` under `chain`, valid from now for `ttlSeconds`. */
export function approve(approver: Identity, clock: Clock, o: { chain: Mandate[]; action: Action; ttlSeconds: number }): Approval {
  const leaf = o.chain[o.chain.length - 1];
  const doc: Approval = {
    type: "mandates/approval",
    version: 1,
    id: newId(),
    issuer: approver.did,
    subject: leaf.credentialSubject.id,
    chain: o.chain.map((m) => m.id),
    action: o.action,
    actionHash: actionHash(o.action),
    validFrom: clock.iso(),
    validUntil: new Date(clock.now() + o.ttlSeconds * 1000).toISOString(),
    uses: 1,
  };
  return signDocument(doc, approver, clock);
}

const bad = (code: string, detail?: string): Reason => ({ code, ...(detail ? { detail } : {}), approvable: false });

/**
 * Checks an approval for `action` under `chain` (§9.2). Empty means valid. Whether it was already used
 * is the caller's to know (SpendLedger.approvalUsed, or `usedApprovals` in decide).
 */
export async function verifyApproval(a: Approval, o: { chain: Mandate[]; action: Action; clock: Clock }): Promise<Reason[]> {
  if (!a || typeof a !== "object" || a.type !== "mandates/approval" || a.version !== 1 || a.uses !== 1) return [bad("approval.invalid", "it isn't a version 1, single-use approval")];
  const sig = await verifyDocument(a, o.clock).catch(() => ({ valid: false }));
  if (!sig.valid) return [bad("approval.invalid", "its signature doesn't verify")];
  const out: Reason[] = [];
  let ownHash = "";
  try {
    ownHash = jcsHash(a.action);
  } catch {
    ownHash = "";
  }
  if (ownHash !== a.actionHash) out.push(bad("approval.invalid", "its actionHash doesn't match its action"));
  const ids = o.chain.map((m) => m.id);
  if (!Array.isArray(a.chain) || a.chain.length !== ids.length || a.chain.some((id, k) => id !== ids[k])) out.push(bad("approval.notInChain", "it is for another chain"));
  if (!o.chain.some((m) => m.issuer === a.issuer)) out.push(bad("approval.notInChain", "its issuer didn't issue any link"));
  const leaf = o.chain[o.chain.length - 1];
  if (a.subject !== leaf?.credentialSubject.id) out.push(bad("approval.invalid", "it is for another delegate"));
  if (a.actionHash !== actionHash(o.action)) out.push(bad("approval.wrongAction"));
  const now = o.clock.now();
  const from = Date.parse(a.validFrom);
  const until = Date.parse(a.validUntil);
  if (Number.isNaN(from) || Number.isNaN(until) || from > now + SKEW_MS) out.push(bad("approval.invalid", "it isn't valid yet"));
  else if (now >= until) out.push(bad("approval.expired"));
  const ttl = leaf?.credentialSubject.escalation?.approvalTtlSeconds;
  if (ttl === undefined) out.push(bad("approval.invalid", "the leaf mandate allows no approvals"));
  else if ((until - from) / 1000 > ttl) out.push(bad("approval.invalid", `it lasts longer than the ${ttl} seconds the leaf allows`));
  return out;
}
