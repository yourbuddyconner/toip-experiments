/**
 * The store (design §9.1): manifests and the evidence to check them offline, as one CBOR map.
 * Map keys are text: manifest ids as cm1_…, device ids as DIDs, beacons as "<kind>:<round>".
 */
import { decodeCbor, encodeCbor } from "@zk-toip/cose";
import type { Credential, StatusListDoc } from "@zk-toip/trust-core";

export const STORE_TYPE = "application/vnd.zk-toip.capture-store+cbor";

export interface TrailAnchor {
  kind: "trail";
  /** The device's DID. */
  log: string;
  /** The interaction event's sequence number in the device's key log. */
  event: number;
  /** The manifest's leaf index in the batch, the batch size, and the Merkle audit path (RFC 6962). */
  index: number;
  size: number;
  path: Uint8Array[];
}

export type Anchor = TrailAnchor;

export interface Store {
  v: 1;
  active: string;
  manifests: Record<string, Uint8Array>;
  /** Compact key logs (eventlog toCompactLog), with timed witness receipts. */
  keyLogs: Record<string, Uint8Array>;
  credentials: Credential[];
  statusLists: StatusListDoc[];
  /** capture/1 mandates from owners to devices (JSON). Additive to the design. */
  mandates: Record<string, unknown>[];
  anchors: Record<string, Anchor[]>;
  /** Beacon signatures: "drand-quicknet:<round>" → the round's BLS signature. */
  beacons: Record<string, Uint8Array>;
  tiles: Record<string, { hashes: Uint8Array }>;
  salts: Record<string, Uint8Array>;
}

interface Wire {
  v: 1;
  active: string;
  manifests: Record<string, Uint8Array>;
  keyLogs: Record<string, Uint8Array>;
  credentials: string[];
  statusLists: string[];
  mandates?: string[];
  anchors: Record<string, Anchor[]>;
  beacons: Record<string, Uint8Array>;
  tiles: Record<string, { hashes: Uint8Array }>;
  salts: Record<string, Uint8Array>;
}

export function emptyStore(active: string): Store {
  return { v: 1, active, manifests: {}, keyLogs: {}, credentials: [], statusLists: [], mandates: [], anchors: {}, beacons: {}, tiles: {}, salts: {} };
}

export function encodeStore(s: Store): Uint8Array {
  const w: Wire = {
    v: 1,
    active: s.active,
    manifests: s.manifests,
    keyLogs: s.keyLogs,
    credentials: s.credentials.map((c) => JSON.stringify(c)),
    statusLists: s.statusLists.map((c) => JSON.stringify(c)),
    ...(s.mandates.length ? { mandates: s.mandates.map((m) => JSON.stringify(m)) } : {}),
    anchors: s.anchors,
    beacons: s.beacons,
    tiles: s.tiles,
    salts: s.salts,
  };
  return encodeCbor(w);
}

const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Uint8Array) && !(x instanceof Map);

/** Decodes a store. Throws on anything that isn't one. */
export function decodeStore(b: Uint8Array): Store {
  const w = decodeCbor<Wire>(b, { strict: false });
  if (!isRec(w) || w.v !== 1 || typeof w.active !== "string") throw new Error("not a capture store");
  const rec = <T>(x: unknown): Record<string, T> => (isRec(x) ? (x as Record<string, T>) : {});
  const parse = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x) => typeof x === "string").map((x) => JSON.parse(x as string)) : []);
  return {
    v: 1,
    active: w.active,
    manifests: rec(w.manifests),
    keyLogs: rec(w.keyLogs),
    credentials: parse(w.credentials),
    statusLists: parse(w.statusLists),
    mandates: parse(w.mandates),
    anchors: rec(w.anchors),
    beacons: rec(w.beacons),
    tiles: rec(w.tiles),
    salts: rec(w.salts),
  };
}

const byJson = <T>(xs: T[]) => {
  const seen = new Map<string, T>();
  for (const x of xs) seen.set(JSON.stringify(x), x);
  return [...seen.values()];
};

/** Everything in both; `b`'s active manifest wins, and `b`'s key logs (newer) replace `a`'s. */
export function mergeStores(a: Store, b: Store): Store {
  const anchors: Record<string, Anchor[]> = { ...a.anchors };
  for (const [k, v] of Object.entries(b.anchors)) anchors[k] = byJson([...(anchors[k] ?? []), ...v]);
  return {
    v: 1,
    active: b.active,
    manifests: { ...a.manifests, ...b.manifests },
    keyLogs: { ...a.keyLogs, ...b.keyLogs },
    credentials: byJson([...a.credentials, ...b.credentials]),
    statusLists: newestLists([...a.statusLists, ...b.statusLists]),
    mandates: byJson([...a.mandates, ...b.mandates]),
    anchors,
    beacons: { ...a.beacons, ...b.beacons },
    tiles: { ...a.tiles, ...b.tiles },
    salts: { ...a.salts, ...b.salts },
  };
}

/** Keeps the newest list per id. */
export function newestLists(lists: StatusListDoc[]): StatusListDoc[] {
  const by = new Map<string, StatusListDoc>();
  for (const l of lists) {
    const have = by.get(l.id);
    if (!have || Date.parse(l.issuedAt) > Date.parse(have.issuedAt)) by.set(l.id, l);
  }
  return [...by.values()];
}
