/** Making captures and edits: what the camera and the editor do, shared by the web app and the tests. */
import type { AsyncSigner } from "@zk-toip/cose";
import { randomBytes } from "./bytes";
import { contentHash, embedStore, sniffMime } from "./embed";
import { idBytes, idText, parseManifest, signManifest, type Action, type AppInfo, type Beacon, type CameraInfo, type CaptureClaim, type EditClaim, type LocationClaim, type Rect } from "./manifest";
import { merklePath, merkleRoot } from "./merkle";
import { emptyStore, mergeStores, type Store, type TrailAnchor } from "./store";
import { commitTiles, crop as cropImage, decodeJpegReference, decodePngReference, encodePngRgba, proveTiles, redact, TILE, type RedactMethod, type Rgba } from "./tiles";

export interface CaptureInput {
  /** The photo as written by the camera (a JPEG from a canvas). */
  file: Uint8Array;
  signer: AsyncSigner;
  device: string;
  deviceTime: number;
  beacons?: Beacon[];
  /** Beacon signatures to carry in the store, keyed "<kind>:<round>". */
  beaconSigs?: Record<string, Uint8Array>;
  sensor: CameraInfo;
  app: AppInfo;
  location?: LocationClaim;
  /** Random 32 bytes, kept private by the camera; needed later to prove a redaction. */
  tileKey?: Uint8Array;
  timeSource?: CaptureClaim["timeSource"];
}

export async function makeCapture(i: CaptureInput): Promise<{ id: Uint8Array; idText: string; cose: Uint8Array; claim: CaptureClaim; store: Store; tileKey: Uint8Array; pixels?: Rgba }> {
  const mime = sniffMime(i.file);
  const tileKey = i.tileKey ?? randomBytes(32);
  let pixels: Rgba | undefined;
  let tiles: ReturnType<typeof commitTiles> | undefined;
  if (mime === "image/jpeg") {
    pixels = decodeJpegReference(i.file);
    tiles = commitTiles(pixels, tileKey);
  }
  const claim: CaptureClaim = {
    v: 1,
    kind: "capture",
    signer: i.device,
    content: { alg: "sha-256", hash: contentHash(i.file, mime), size: i.file.length, mime, ...(pixels ? { width: pixels.width, height: pixels.height } : {}) },
    ...(tiles ? { tiles: tiles.commit } : {}),
    deviceTime: i.deviceTime,
    timeSource: i.timeSource ?? "os-clock",
    beacons: i.beacons ?? [],
    ...(i.location ? { location: i.location } : {}),
    sensor: i.sensor,
    app: i.app,
    nonce: randomBytes(16),
  };
  const { id, cose } = await signManifest(claim, i.signer);
  const store = emptyStore(idText(id));
  store.manifests[idText(id)] = cose;
  if (tiles) store.tiles[idText(id)] = { hashes: tiles.hashes };
  Object.assign(store.beacons, i.beaconSigs ?? {});
  return { id, idText: idText(id), cose, claim, store, tileKey, pixels };
}

/** One Merkle root over a batch of manifest ids, and each id's anchor once the root is in interaction event `event`. */
export function batchAnchors(ids: Uint8Array[], log: string, event: number): { root: Uint8Array; anchors: TrailAnchor[] } {
  const root = merkleRoot(ids);
  return { root, anchors: ids.map((_, index) => ({ kind: "trail", log, event, index, size: ids.length, path: merklePath(ids, index) })) };
}

/** Snaps a crop to the tile grid, so whole tiles survive and the redaction proof still works. */
export function snapCrop(r: Rect, width: number, height: number, size = TILE): Rect {
  const x = Math.max(0, Math.floor(r.x / size) * size);
  const y = Math.max(0, Math.floor(r.y / size) * size);
  const x2 = Math.min(width, Math.ceil((r.x + r.w) / size) * size);
  const y2 = Math.min(height, Math.ceil((r.y + r.h) / size) * size);
  return { x, y, w: x2 - x, h: y2 - y };
}

export interface EditInput {
  original: Uint8Array;
  store: Store;
  tileKey: Uint8Array;
  /** Redactions, in the original's pixels. */
  regions: Rect[];
  method: RedactMethod;
  reason?: string;
  /** Crop, in the original's pixels; snapped to the grid. */
  crop?: Rect;
  signer: AsyncSigner;
  editor: string;
  deviceTime: number;
  beacons?: Beacon[];
  beaconSigs?: Record<string, Uint8Array>;
  tool?: EditClaim["tool"];
  /** Extra things to put in the store: the editor's credential, say. */
  extra?: Partial<Pick<Store, "credentials" | "statusLists">>;
}

/** Redacts and crops the original, writes a PNG, and signs an edit manifest with a tile proof against the capture. */
export async function makeEdit(i: EditInput): Promise<{ file: Uint8Array; store: Store; claim: EditClaim; idText: string }> {
  const parentId = i.store.active;
  const parentCose = i.store.manifests[parentId];
  if (!parentCose) throw new Error("the original's store has no active manifest");
  const mime = sniffMime(i.original);
  const original = mime === "image/png" ? decodePngReference(i.original) : decodeJpegReference(i.original);
  const area = i.crop ? snapCrop(i.crop, original.width, original.height) : { x: 0, y: 0, w: original.width, h: original.height };
  const redacted = redact(original, i.regions, i.method);
  const out = cropImage(redacted, area);
  const regionsOut = i.regions
    .map((r) => ({ x: r.x - area.x, y: r.y - area.y, w: r.w, h: r.h }))
    .map((r) => ({ x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(out.width, r.x + r.w) - Math.max(0, r.x), h: Math.min(out.height, r.y + r.h) - Math.max(0, r.y) }))
    .filter((r) => r.w > 0 && r.h > 0);
  const offset: [number, number] = [area.x / TILE, area.y / TILE];
  const proof = Number.isInteger(offset[0]) && Number.isInteger(offset[1]) ? proveTiles(original, out, i.tileKey, regionsOut, offset) : undefined;
  const png = encodePngRgba(out);
  const actions: Action[] = [{ action: "c2pa.opened" }];
  if (regionsOut.length) actions.push({ action: "capture.redactedRegion", params: { regions: regionsOut, method: i.method, ...(i.reason ? { reason: i.reason } : {}) } });
  if (area.w !== original.width || area.h !== original.height) actions.push({ action: "c2pa.cropped", params: { x: area.x, y: area.y, w: area.w, h: area.h } });
  actions.push({ action: "c2pa.converted", params: { to: "image/png" } });
  const parentHash = parseManifest(parentCose);
  if ("error" in parentHash) throw new Error(parentHash.error);
  const claim: EditClaim = {
    v: 1,
    kind: "edit",
    signer: i.editor,
    parents: [{ manifest: idBytes(parentId), content: parentHash.claim.content.hash, relationship: "parentOf" }],
    actions,
    tool: i.tool ?? { name: "capture-editor", version: "0.1.0" },
    content: { alg: "sha-256", hash: contentHash(png, "image/png"), size: png.length, mime: "image/png", width: out.width, height: out.height },
    ...(proof ? { tileProof: { against: idBytes(parentId), offset, kept: proof.ref.kept } } : {}),
    deviceTime: i.deviceTime,
    beacons: i.beacons ?? [],
    nonce: randomBytes(16),
  };
  const { id, cose } = await signManifest(claim, i.signer);
  const own = emptyStore(idText(id));
  own.manifests[idText(id)] = cose;
  if (proof) own.salts[idText(id)] = proof.salts;
  Object.assign(own.beacons, i.beaconSigs ?? {});
  own.credentials = i.extra?.credentials ?? [];
  own.statusLists = i.extra?.statusLists ?? [];
  const store = mergeStores(i.store, own);
  return { file: embedStore(png, store, "image/png"), store, claim, idText: idText(id) };
}
