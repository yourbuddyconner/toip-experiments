/** Shared state for the pages: the server's config, the verifier's trust list, the gallery, and the vault. */
import { createVault } from "@zk-toip/web-vault";
import { chainFromJson, QUICKNET, type DrandChain, type TrustEntry } from "../../src/core";

export interface Config {
  owner: { did: string; name: string };
  maker: { did: string; name: string };
  gateway: { id: string; publicKey: string };
  witnesses: { aid: string; url: string }[];
  bt: number;
  drand: { mode: "live" | "dev"; chain: Parameters<typeof chainFromJson>[0] };
}

let configP: Promise<Config> | undefined;
export const config = () => (configP ??= fetch("/api/config").then((r) => r.json()));

/** The beacon chains this verifier knows: the public quicknet always, and the server's development beacon when it runs one. */
export async function chains(): Promise<DrandChain[]> {
  const c = await config();
  const own = chainFromJson(c.drand.chain);
  return own.kind === "drand-quicknet" ? [QUICKNET] : [QUICKNET, own];
}

// ---------------------------------------------------------------- the trust list (this browser's choice)

const TRUST_KEY = "capture.trust";

export async function trustList(): Promise<TrustEntry[]> {
  const saved = localStorage.getItem(TRUST_KEY);
  if (saved) return JSON.parse(saved);
  // a fresh verifier trusts the demo maker for what it makes, and nobody as an owner
  const c = await config();
  const list: TrustEntry[] = [{ did: c.maker.did, name: c.maker.name, trustedFor: ["maker"] }];
  localStorage.setItem(TRUST_KEY, JSON.stringify(list));
  return list;
}

export async function trust(entry: TrustEntry): Promise<TrustEntry[]> {
  const list = (await trustList()).filter((t) => t.did !== entry.did);
  list.push(entry);
  localStorage.setItem(TRUST_KEY, JSON.stringify(list));
  return list;
}

export async function untrust(did: string): Promise<TrustEntry[]> {
  const list = (await trustList()).filter((t) => t.did !== did);
  localStorage.setItem(TRUST_KEY, JSON.stringify(list));
  return list;
}

// ---------------------------------------------------------------- the vault: the camera's and the editor's keys

export const vault = createVault({ prefix: "capture", rpName: "Capture" });

// ---------------------------------------------------------------- the gallery (IndexedDB)

export interface Shot {
  id: string;
  takenAt: number;
  file: Uint8Array;
  /** The store, CBOR. */
  store: Uint8Array;
  mime: string;
  width: number;
  height: number;
  anchored: boolean;
  witnessed?: number;
  published: boolean;
  /** The camera's account; the tile key is sealed in the vault under it. */
  account: string;
  kind: "capture" | "edit";
  note?: string;
}

const DB = "capture.gallery";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("shots", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction("shots", mode).objectStore("shots"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const gallery = {
  all: async () => ((await tx("readonly", (s) => s.getAll())) as Shot[]).sort((a, b) => b.takenAt - a.takenAt),
  get: (id: string) => tx("readonly", (s) => s.get(id)) as Promise<Shot | undefined>,
  put: (shot: Shot) => tx("readwrite", (s) => s.put(shot)),
  remove: (id: string) => tx("readwrite", (s) => s.delete(id)),
};

export const tileKeyName = (shotId: string) => `tilekey-${shotId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-24)}`;

// ---------------------------------------------------------------- small helpers

export function download(bytes: Uint8Array | string, name: string, type = "application/octet-stream") {
  const blob = new Blob([typeof bytes === "string" ? bytes : (bytes as BlobPart)], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const objectUrl = (bytes: Uint8Array, type: string) => URL.createObjectURL(new Blob([bytes as BlobPart], { type }));

export function navigate(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC", timeZoneName: "short" });
export const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

/** Passes a file to the verifier page without a download. */
export let handoff: { file: Uint8Array; name: string; sidecar?: Uint8Array } | null = null;
export const setHandoff = (h: typeof handoff) => (handoff = h);
