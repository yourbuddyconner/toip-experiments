import { verifyCredential, type Clock, type Credential, type Policies } from "@zk-toip/trust-core";
import type { ListModel } from "./model";
import { opKey, validateOpShape, verifyOp, type Op } from "./ops";
import { rosterEntry, type RosterDoc } from "./roster";

export type Role = "admin" | "editor" | "viewer";
export type AuthzKind = "add" | "check" | "uncheck" | "edit" | "delete" | "invite" | "revoke";

export interface AuthzInput {
  role: Role;
  kind: AuthzKind;
  isItemAuthor: boolean;
  itemPrivate: boolean;
  isReader: boolean;
}

export interface Decision {
  allow: boolean;
  reasons: string[];
}

export const AUTHZ_ENTRYPOINT = "todo/authz/decision";
export const MAX_FUTURE_MS = 5 * 60_000;

/** The list's rules, from policies/todo.rego. */
export function authorize(policies: Policies, input: AuthzInput): Decision {
  return policies.evaluate<Decision>(AUTHZ_ENTRYPOINT, input);
}

export type CheckResult = { ok: true; duplicate?: true } | { ok: false; reason: string; holdable?: true };

export interface CheckInput {
  op: unknown;
  /** The author's membership credential, sent alongside the op. */
  membership: Credential | undefined;
  roster: RosterDoc | undefined;
  /** The authenticated TSP sender, when the op came straight from someone. */
  directSender?: string;
  /** True when the op arrived inside a welcome or sync from someone other than its author. */
  forwarded: boolean;
  listDid: string;
  model: ListModel;
  policies: Policies;
  clock: Clock;
}

/** Design v2 §4.5: everything a device checks before accepting an op, in order. The first failure is the reason. */
export async function checkOp(input: CheckInput): Promise<CheckResult> {
  const { membership, roster, directSender, forwarded, listDid, model, policies, clock } = input;
  const fail = (reason: string): CheckResult => ({ ok: false, reason });

  if (!validateOpShape(input.op)) return fail("malformed operation");
  const op: Op = input.op;
  if (op.list !== listDid) return fail("for a different list");
  // Before the signature: the proof verifier itself refuses a proof dated in the future, which would hide the real reason.
  if (Date.parse(op.at) > clock.now() + MAX_FUTURE_MS) return fail("from the future");
  if (!(await verifyOp(op, clock))) return fail("operation: signature does not verify");

  const known = model.get(opKey(op));
  if (known) return model.insertWouldDuplicate(op) ? { ok: true, duplicate: true } : fail("duplicate operation id");

  if (!forwarded && directSender !== op.issuer) return fail("not from its author");

  if (!membership) return fail("not a member");
  if (!(await verifyCredential(membership, clock)).ok) return fail("membership: signature does not verify");
  if (membership.issuer !== listDid || membership.credentialSubject.list !== listDid) return fail("not a member");
  if (membership.credentialSubject.id !== op.issuer || membership.id !== op.membershipId) return fail("credential is for someone else");
  const member = rosterEntry(roster, membership.id);
  if (!member || member.did !== op.issuer) return fail("not a member");

  // For a removed membership, exactly the ops its removal kept stay valid, however they arrive (review I1).
  if (member.removedAt && !(member.keptOps ?? []).includes(op.id)) return fail("membership revoked");

  const item = model.item(op.itemId);
  if (op.kind === "add") {
    if (item) return fail("item already exists");
  } else if (!item) {
    return { ok: false, reason: "no such item", holdable: true };
  }

  const decision = authorize(policies, {
    role: member.role,
    kind: op.kind,
    isItemAuthor: item?.author === op.issuer,
    itemPrivate: item?.private ?? false,
    isReader: item?.readers?.includes(op.issuer) ?? false,
  });
  return decision.allow ? { ok: true } : fail(decision.reasons[0]);
}
