/**
 * Guest passes, after Commons' design (projects/commons/docs/design.md §5.1), cut down for the demo:
 * the Building issues a credential to a fresh pass key, for one door, with a weekly time window and a
 * revocation index. The door checks it offline, against signed state it cached while online: the
 * Building's DID and the Building's revocation list.
 */
import { checkStatus, issueCredential, verifyCredential, type Clock, type Credential, type Identity, type StatusListDoc } from "@toip-tools/trust-core";

export const GUEST_PASS = "GuestPass";

export interface PassSubject {
  /** The pass key's DID: whoever signs with it holds the pass. */
  id: string;
  pass: string;
  household: string;
  door: string;
  /** "Mon-Fri", "Daily", or a comma list such as "Mon,Wed". */
  days: string;
  /** "12:00-14:00" in the building's time zone. "00:00-24:00" is all day. */
  hours: string;
}

export type GuestPass = Credential & { credentialSubject: PassSubject };

export function issuePass(
  building: Identity,
  clock: Clock,
  p: { holder: string; door: string; label: string; household: string; days: string; hours: string; validUntil: string; statusIndex: number },
): GuestPass {
  return issueCredential(building, clock, {
    type: ["VerifiableCredential", GUEST_PASS],
    validUntil: p.validUntil,
    credentialSubject: { id: p.holder, pass: p.label, household: p.household, door: p.door, days: p.days, hours: p.hours },
    credentialStatus: { type: "BitstringStatusListEntry", statusListIndex: p.statusIndex, statusListCredential: `${building.did}#status` },
  }) as GuestPass;
}

/** What a door cached while it was online. */
export interface DoorCache {
  building: string;
  statusList: StatusListDoc;
  /** How old the revocation list may be while the door is offline. Commons suggests 24 hours. */
  maxListAgeMs: number;
  timeZone: string;
}

export type PassVerdict =
  | { ok: true; pass: string; household: string }
  | { ok: false; code: "not-a-pass" | "wrong-issuer" | "forged" | "expired" | "not-holder" | "wrong-door" | "revoked" | "stale-list" | "outside-window"; reason: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daySet(spec: string): Set<string> | undefined {
  if (spec === "Daily") return new Set(DAYS);
  const range = /^(\w{3})-(\w{3})$/.exec(spec);
  if (range) {
    const a = DAYS.indexOf(range[1]);
    const b = DAYS.indexOf(range[2]);
    if (a < 0 || b < 0) return undefined;
    const out = new Set<string>();
    for (let i = a; ; i = (i + 1) % 7) {
      out.add(DAYS[i]);
      if (i === b) break;
    }
    return out;
  }
  const list = spec.split(",").map((d) => d.trim());
  return list.every((d) => DAYS.includes(d)) ? new Set(list) : undefined;
}

/** Whether `ms` falls inside the pass's weekly window, in `timeZone`. */
export function withinWindow(ms: number, days: string, hours: string, timeZone: string): boolean {
  const set = daySet(days);
  const h = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(hours);
  if (!set || !h) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  const from = Number(h[1]) * 60 + Number(h[2]);
  const to = Number(h[3]) * 60 + Number(h[4]);
  return set.has(get("weekday")) && minute >= from && minute < to;
}

/** Everything the door checks, offline, except the challenge (the door does that). `sender` signed the request. */
export async function checkPass(vc: GuestPass, ctx: { sender: string; door: string; cache: DoorCache; clock: Clock }): Promise<PassVerdict> {
  const s = vc?.credentialSubject;
  if (!vc || !Array.isArray(vc.type) || !vc.type.includes(GUEST_PASS) || !s) return { ok: false, code: "not-a-pass", reason: "that isn't a guest pass" };
  if (vc.issuer !== ctx.cache.building) return { ok: false, code: "wrong-issuer", reason: "the pass isn't from this building" };
  const v = await verifyCredential(vc, ctx.clock);
  if (!v.ok) {
    if (v.failure === "expired" || v.failure === "notYetValid") return { ok: false, code: "expired", reason: "the pass has expired" };
    return { ok: false, code: "forged", reason: "the Building's signature on the pass doesn't verify" };
  }
  if (s.id !== ctx.sender) return { ok: false, code: "not-holder", reason: "the request wasn't signed by the pass key" };
  if (s.door !== ctx.door) return { ok: false, code: "wrong-door", reason: "the pass is for another door" };
  const index = vc.credentialStatus?.statusListIndex;
  if (typeof index !== "number") return { ok: false, code: "revoked", reason: "the pass has no revocation index" };
  const st = await checkStatus(ctx.cache.statusList, index, ctx.cache.building, ctx.clock);
  if (!st.signatureValid) return { ok: false, code: "stale-list", reason: "the cached revocation list isn't signed by the Building" };
  if (st.ageSeconds * 1000 > ctx.cache.maxListAgeMs) return { ok: false, code: "stale-list", reason: `the cached revocation list is ${Math.round(st.ageSeconds / 3600)} h old` };
  if (st.revoked) return { ok: false, code: "revoked", reason: "the household revoked this pass" };
  if (!withinWindow(ctx.clock.now(), s.days, s.hours, ctx.cache.timeZone)) return { ok: false, code: "outside-window", reason: `the pass is for ${s.days} ${s.hours}` };
  return { ok: true, pass: s.pass, household: s.household };
}
