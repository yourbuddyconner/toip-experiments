import type { Proof } from "@openvtc/trust-tasks/runtime";
import { signDocument, verifyDocument, type Clock, type Identity } from "@zk-toip/trust-core";
import type { Role } from "./checks";

export interface RosterMember {
  did: string;
  name: string;
  role: Role;
  membershipId: string;
  joinedAt: string;
  removedAt?: string;
}

/**
 * The list's signed record of who is in it (design v2 §4.4). Only the list's key signs it,
 * every change bumps `version`, and a removal is never undone.
 */
export interface RosterDoc {
  type: "todo/roster";
  issuer: string;
  list: string;
  name: string;
  version: number;
  issuedAt: string;
  members: RosterMember[];
  proof?: Proof;
}

export function signRoster(list: Identity, clock: Clock, body: { name: string; version: number; members: RosterMember[] }): RosterDoc {
  const doc: RosterDoc = { type: "todo/roster", issuer: list.did, list: list.did, issuedAt: clock.iso(), ...body };
  return signDocument(doc, list, clock);
}

const ROLES = new Set(["admin", "editor", "viewer"]);

function isMember(m: unknown): m is RosterMember {
  const x = m as RosterMember;
  return (
    !!x &&
    typeof x.did === "string" &&
    typeof x.name === "string" &&
    ROLES.has(x.role) &&
    typeof x.membershipId === "string" &&
    typeof x.joinedAt === "string" &&
    (x.removedAt === undefined || typeof x.removedAt === "string")
  );
}

export type RosterVerdict = { ok: true; roster: RosterDoc } | { ok: false; reason: string };

/** Whether `incoming` may replace `held` as this device's roster for `listDid`. */
export async function acceptRoster(held: RosterDoc | undefined, incoming: unknown, listDid: string, clock: Clock): Promise<RosterVerdict> {
  const r = incoming as RosterDoc;
  if (!r || typeof r !== "object" || r.type !== "todo/roster" || !Array.isArray(r.members) || !Number.isInteger(r.version) || !r.members.every(isMember)) {
    return { ok: false, reason: "not a roster" };
  }
  if (r.list !== listDid || r.issuer !== listDid || !(await verifyDocument(r, clock)).valid) {
    return { ok: false, reason: "roster: signature does not verify" };
  }
  if (held && r.version <= held.version) return { ok: false, reason: "roster is not newer" };
  for (const h of held?.members ?? []) {
    if (h.removedAt && !r.members.some((m) => m.did === h.did && m.removedAt === h.removedAt)) {
      return { ok: false, reason: "roster drops a removal" };
    }
  }
  return { ok: true, roster: r };
}

export function rosterMember(roster: RosterDoc | undefined, did: string): RosterMember | undefined {
  return roster?.members.find((m) => m.did === did);
}

export function currentMembers(roster: RosterDoc | undefined): RosterMember[] {
  return (roster?.members ?? []).filter((m) => !m.removedAt);
}
