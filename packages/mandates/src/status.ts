/** Revocation: the issuer's side (StatusRegistry) and the verifier's side (resolvers). */
import { fromB64u, isRevokedIn, signDocument, toB64u, type Clock, type Identity, type StatusListDoc } from "@toip-tools/trust-core";
import type { Mandate, StatusEntry, StatusResolver } from "./types.js";

export interface StatusRegistryState {
  length: number;
  next: number;
  bits: string;
}

/**
 * One signed revocation list per issuer, with id "<issuer DID>#status". The caller persists `save()`.
 * The list format is trust-core's StatusListDoc, so trust-core's checkStatus reads it too.
 */
export class StatusRegistry {
  readonly listId: string;
  private readonly bits: Uint8Array;
  private readonly length: number;
  private next: number;

  constructor(
    private readonly issuer: Identity,
    private readonly clock: Clock,
    saved?: StatusRegistryState,
  ) {
    this.listId = `${issuer.did}#status`;
    this.length = saved?.length ?? 1024;
    this.next = saved?.next ?? 0;
    this.bits = saved ? fromB64u(saved.bits) : new Uint8Array(Math.ceil(this.length / 8));
  }

  allocate(): StatusEntry {
    if (this.next >= this.length) throw new Error("status list full");
    return { type: "BitstringStatusListEntry", statusListIndex: this.next++, statusListCredential: this.listId };
  }

  revoke(e: StatusEntry): void {
    this.own(e);
    this.bits[e.statusListIndex >> 3] |= 1 << (e.statusListIndex & 7);
  }

  isRevoked(e: StatusEntry): boolean {
    this.own(e);
    return (this.bits[e.statusListIndex >> 3] & (1 << (e.statusListIndex & 7))) !== 0;
  }

  /** A freshly signed list. Verifiers refuse lists older than a mandate's `revocation.maxAgeSeconds`, so re-sign often. */
  sign(): StatusListDoc {
    const doc: StatusListDoc = { id: this.listId, type: "status-list", issuer: this.issuer.did, issuedAt: this.clock.iso(), length: this.length, bits: toB64u(this.bits) };
    return signDocument(doc, this.issuer, this.clock);
  }

  save(): StatusRegistryState {
    return { length: this.length, next: this.next, bits: toB64u(this.bits) };
  }

  private own(e: StatusEntry): void {
    if (e.statusListCredential !== this.listId) throw new Error(`entry is for list ${e.statusListCredential}, not ${this.listId}`);
    if (!Number.isSafeInteger(e.statusListIndex) || e.statusListIndex < 0 || e.statusListIndex >= this.length) throw new Error("index outside the list");
  }
}

/** Whether `list` revokes `mandate`. Doesn't check the list's signature or age: the engine does. */
export function isRevoked(mandate: Mandate, list: StatusListDoc): boolean {
  const e = mandate.credentialStatus;
  return list.id === e.statusListCredential && isRevokedIn(list, e.statusListIndex);
}

/** Lists already in hand, e.g. from a presentation. The newest per id wins. */
export function staticStatusResolver(lists: StatusListDoc[]): StatusResolver {
  const byId = new Map<string, StatusListDoc>();
  for (const l of lists) {
    const old = byId.get(l.id);
    if (!old || Date.parse(l.issuedAt) > Date.parse(old.issuedAt)) byId.set(l.id, l);
  }
  return { get: async (id) => byId.get(id) ?? null };
}

/**
 * Fetches signed lists over HTTP: GET `${base}/${encodeURIComponent(did)}` for list "did#…", as the
 * agents hub serves them (`GET /api/status/:did`). Anything but a JSON list with the asked-for id is null.
 */
export function httpStatusResolver(
  base: string,
  o: { fetch?: typeof fetch; cacheSeconds?: number; path?: (listId: string) => string } = {},
): StatusResolver {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const cacheMs = (o.cacheSeconds ?? 0) * 1000;
  const cache = new Map<string, { at: number; doc: StatusListDoc }>();
  const url = o.path ?? ((listId: string) => `${base.replace(/\/$/, "")}/${encodeURIComponent(listId.split("#")[0])}`);
  return {
    async get(listId) {
      const hit = cache.get(listId);
      if (hit && Date.now() - hit.at < cacheMs) return hit.doc;
      try {
        const res = await f(url(listId), { headers: { accept: "application/json" } });
        if (!res.ok) return null;
        const doc = (await res.json()) as StatusListDoc;
        if (!doc || typeof doc !== "object" || doc.id !== listId || doc.type !== "status-list") return null;
        if (cacheMs > 0) cache.set(listId, { at: Date.now(), doc });
        return doc;
      } catch {
        return null;
      }
    },
  };
}
