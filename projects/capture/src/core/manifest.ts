/**
 * Capture and edit manifests (design §8, §11.1): a deterministic CBOR claim, signed as a COSE_Sign1.
 * The manifest id is SHA-256 of the whole COSE_Sign1, written cm1_<base64url>.
 */
import { decodeCbor, encodeCbor, signCose1, Tagged, type AsyncSigner, type CoseAlg } from "@toip-tools/cose";
import { b64u, fromB64u, fromUtf8, sha } from "./bytes";

export const CLAIM_TYPE = "application/vnd.zk-toip.capture-claim+cbor";

export interface ContentRef {
  alg: "sha-256";
  hash: Uint8Array;
  size: number;
  mime: string;
  width?: number;
  height?: number;
}

export interface TileCommit {
  size: number;
  cols: number;
  rows: number;
  decoder: string;
  root: Uint8Array;
}

export interface Beacon {
  /** "drand-quicknet" is the public League of Entropy chain; "drand-dev" is a beacon the capture server runs itself. */
  kind: "drand-quicknet" | "drand-dev";
  round: number;
  /** The first 8 bytes of the round's randomness. */
  prefix: Uint8Array;
}

export interface LocationClaim {
  lat: number;
  lon: number;
  accuracyM?: number;
  source: "browser-geolocation" | "gnss" | "owner-declared";
  at?: number;
}

export interface CameraInfo {
  type: "camera";
  pipeline: string;
  trackLabel?: string;
  deviceIdHash?: Uint8Array;
  settings?: { width?: number; height?: number; facingMode?: string };
}

export interface AppInfo {
  name: string;
  version: string;
  origin?: string;
  build?: Uint8Array;
}

export interface CaptureClaim {
  v: 1;
  kind: "capture";
  signer: string;
  content: ContentRef;
  tiles?: TileCommit;
  deviceTime: number;
  timeSource: "os-clock" | "ntp" | "gnss" | "none";
  beacons: Beacon[];
  location?: LocationClaim;
  sensor: CameraInfo;
  app: AppInfo;
  nonce: Uint8Array;
}

export interface ParentRef {
  manifest: Uint8Array;
  content: Uint8Array;
  relationship: "parentOf" | "componentOf" | "inputTo";
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Action {
  action: string;
  params?: Record<string, unknown>;
  digitalSourceType?: string;
  softwareAgent?: string;
}

export interface TileProofRef {
  /** The capture manifest id the proof is against. */
  against: Uint8Array;
  /** Crop offset, in tiles: output tile (x, y) is capture tile (x + dx, y + dy). */
  offset: [number, number];
  /** Bitmap over the capture's tiles, row-major, LSB first: 1 = kept unchanged. */
  kept: Uint8Array;
}

export interface EditClaim {
  v: 1;
  kind: "edit";
  signer: string;
  parents: ParentRef[];
  actions: Action[];
  tool: { name: string; version: string; did?: string };
  content: ContentRef;
  tiles?: TileCommit;
  tileProof?: TileProofRef;
  deviceTime: number;
  beacons: Beacon[];
  nonce: Uint8Array;
}

export type Claim = CaptureClaim | EditClaim;

export const idText = (id: Uint8Array) => `cm1_${b64u(id)}`;
export const idBytes = (t: string) => fromB64u(t.replace(/^cm1_/, ""));
export const manifestId = (cose: Uint8Array) => sha(cose);

/** The kid of a manifest: "<signer id>#<key ref>" for a device, the did:key itself for a person or tool. */
export function kidOf(signer: string, keyRef?: number): string {
  return keyRef === undefined ? signer : `${signer}#${keyRef}`;
}

export async function signManifest(claim: Claim, signer: AsyncSigner): Promise<{ id: Uint8Array; cose: Uint8Array }> {
  const cose = await signCose1(encodeCbor(claim), signer, { contentType: CLAIM_TYPE });
  return { id: manifestId(cose), cose };
}

export interface ParsedManifest {
  id: Uint8Array;
  idText: string;
  alg: CoseAlg;
  kid: string;
  /** The id part of the kid. */
  kidSigner: string;
  /** The key ref part of the kid (a KEL establishment sn), when there is one. */
  keyRef?: number;
  claim: Claim;
  cose: Uint8Array;
}

/** Reads a manifest without checking its signature. Returns a reason when it can't be read. */
export function parseManifest(cose: Uint8Array): ParsedManifest | { error: string } {
  try {
    let v = decodeCbor(cose, { strict: false, useMaps: true });
    if (v instanceof Tagged) {
      if (v.tag !== 18) return { error: "not a COSE_Sign1" };
      v = v.value;
    }
    if (!Array.isArray(v) || v.length !== 4) return { error: "not a COSE_Sign1" };
    const [prot, , payload] = v as [Uint8Array, unknown, Uint8Array, Uint8Array];
    if (!(prot instanceof Uint8Array) || !(payload instanceof Uint8Array)) return { error: "not a COSE_Sign1" };
    const h = decodeCbor(prot, { strict: false, useMaps: true }) as Map<number, unknown>;
    const alg = h.get(1) as CoseAlg;
    const kidBytes = h.get(4);
    if (!(kidBytes instanceof Uint8Array)) return { error: "no kid" };
    if (h.get(3) !== CLAIM_TYPE) return { error: "not a capture claim" };
    const kid = fromUtf8(kidBytes);
    const claim = decodeCbor<Claim>(payload, { strict: true });
    if (!claim || typeof claim !== "object" || claim.v !== 1 || (claim.kind !== "capture" && claim.kind !== "edit")) return { error: "unknown claim kind" };
    const hashAt = kid.lastIndexOf("#");
    let kidSigner = kid;
    let keyRef: number | undefined;
    if (hashAt > 0 && /^\d+$/.test(kid.slice(hashAt + 1))) {
      kidSigner = kid.slice(0, hashAt);
      keyRef = Number(kid.slice(hashAt + 1));
    }
    const id = manifestId(cose);
    return { id, idText: idText(id), alg, kid, kidSigner, keyRef, claim, cose };
  } catch (e) {
    return { error: `does not decode: ${(e as Error).message}` };
  }
}
