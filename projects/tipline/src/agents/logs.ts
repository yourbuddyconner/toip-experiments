/**
 * Fetching and cross-checking root logs: the organization's own copy and the outlet's mirror.
 * Two validly signed roots for one epoch are evidence the organization equivocated (design §6.6).
 */
import { checkRootLog, findEquivocation, rootDocHash, type GroupRoot } from "@toip-tools/anon-membership";
import { verifyDocument, type Clock } from "@toip-tools/trust-core";

export interface Fetcher {
  json(url: string): Promise<unknown>;
  bytes(url: string): Promise<Uint8Array>;
}

/** fetch(), with errors that say which URL failed. */
export const httpFetcher = (f: typeof fetch = fetch): Fetcher => ({
  async json(url) {
    const r = await f(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  },
  async bytes(url) {
    const r = await f(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
});

/** Joins a base URL and a path, keeping the base's own path. */
export function joinUrl(base: string, path: string): string {
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : base + "/").toString();
}

/** Two different roots for one epoch or seq, both validly signed by `issuer`, or null. */
export async function equivocation(docs: GroupRoot[], issuer: string, clock: Clock): Promise<[GroupRoot, GroupRoot] | null> {
  const seen = new Map<string, GroupRoot>();
  for (const d of docs) seen.set(rootDocHash(d), d);
  const pair = findEquivocation([...seen.values()]);
  if (!pair) return null;
  for (const d of pair) {
    if (d.issuer !== issuer || !(await verifyDocument(d, clock)).valid) return null;
  }
  return pair;
}

export type LogCompare =
  | { ok: true; log: GroupRoot[]; head: GroupRoot }
  | { ok: false; why: string; evidence?: [GroupRoot, GroupRoot] };

/**
 * Checks two copies of a group's log: each must pass checkRootLog, neither may hold a root the other
 * contradicts, and both must end at the same root.
 */
export async function compareLogs(a: unknown, b: unknown, issuer: string, clock: Clock, names: [string, string]): Promise<LogCompare> {
  const ca = await checkRootLog(a as GroupRoot[], issuer, clock);
  const cb = await checkRootLog(b as GroupRoot[], issuer, clock);
  const all = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])] as GroupRoot[];
  const ev = await equivocation(all, issuer, clock);
  if (ev) return { ok: false, why: `the organization signed two different roots for ${ev[0].epoch}`, evidence: ev };
  if (!ca.ok) return { ok: false, why: `${names[0]}'s copy of the log doesn't check out (${ca.reason})`, evidence: ca.evidence };
  if (!cb.ok) return { ok: false, why: `${names[1]}'s copy of the log doesn't check out (${cb.reason})`, evidence: cb.evidence };
  if (rootDocHash(ca.head) !== rootDocHash(cb.head)) return { ok: false, why: `${names[0]} and ${names[1]} show different newest roots (${ca.head.epoch} and ${cb.head.epoch})` };
  return { ok: true, log: a as GroupRoot[], head: ca.head };
}
