import type { Policies } from "@zk-toip/trust-core";

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

/** The list's rules, from policies/todo.rego. */
export function authorize(policies: Policies, input: AuthzInput): Decision {
  return policies.evaluate<Decision>(AUTHZ_ENTRYPOINT, input);
}

import { checkStatus, verifyCredential, type Credential, type DemoClock, type StatusListDoc } from "@zk-toip/trust-core";
import type { ListState } from "./list";
import { verifyOp, type Op } from "./ops";

export type CheckResult = { ok: true; duplicate?: true } | { ok: false; reason: string };

const canonical = (x: unknown) => JSON.stringify(x);

/** Design 4.5: everything a device checks before applying an op, in order. The first failure is the reason. */
export async function checkOp(input: {
  op: Op;
  membership: Credential | undefined;
  directSender?: string;
  listDid: string;
  status: StatusListDoc;
  state: ListState;
  policies: Policies;
  clock: DemoClock;
}): Promise<CheckResult> {
  const { op, membership, directSender, listDid, status, state, policies, clock } = input;
  const fail = (reason: string): CheckResult => ({ ok: false, reason });

  if (!(await verifyOp(op, clock)) || op.list !== listDid) return fail("operation: signature does not verify");
  const known = state.seen(op.id);
  if (known) return canonical(known) === canonical(op) ? { ok: true, duplicate: true } : fail("duplicate operation id");
  if (directSender !== undefined && directSender !== op.issuer) return fail("not from its author");

  if (!membership) return fail("not a member");
  if (!(await verifyCredential(membership, clock)).ok) return fail("membership: signature does not verify");
  if (membership.issuer !== listDid || membership.credentialSubject.list !== listDid) return fail("not a member");
  if (membership.credentialSubject.id !== op.issuer || membership.id !== op.membershipId) return fail("credential is for someone else");
  const index = membership.credentialStatus?.statusListIndex;
  if (index === undefined) return fail("not a member");
  const st = await checkStatus(status, index, listDid, clock);
  if (!st.signatureValid || st.revoked) return fail("membership revoked");

  const item = state.item(op.itemId);
  if (op.kind === "add" ? item !== undefined : item === undefined) return fail(op.kind === "add" ? "item already exists" : "no such item");

  const decision = authorize(policies, {
    role: membership.credentialSubject.role as Role,
    kind: op.kind,
    isItemAuthor: item?.author === op.issuer,
    itemPrivate: item?.readers !== undefined,
    isReader: item?.readers?.includes(op.issuer) ?? false,
  });
  return decision.allow ? { ok: true } : fail(decision.reasons[0]);
}
