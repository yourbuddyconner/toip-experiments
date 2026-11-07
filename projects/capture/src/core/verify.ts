/**
 * The verifier (design §14): a pure function of the file, the store, the trust list, the clock and an
 * optional fetcher. Nothing it is handed is trusted; every signature, hash, path and receipt is redone here.
 */
import { verifyCose1, type CoseAlg, type PublicKey } from "@toip-tools/cose";
import { anchoredIn, keyAt, retiredAt, type KelResult } from "@toip-tools/eventlog";
import { resolveDidKey, verifyCredential, isRevokedIn, verifyDocument, type Clock, type Credential, type StatusListDoc } from "@toip-tools/trust-core";
import { equal, hex, sha } from "./bytes";
import { credentialKind, type TrustEntry } from "./credentials";
import { randomnessOf, roundTime, verifyRound, type DrandChain } from "./drand";
import { contentHash, extractStore, sniffMime } from "./embed";
import { deviceData, isDeviceDid, isKelResult, readKeyLog, witnessedBy } from "./keylog";
import { idText, parseManifest, type Action, type Beacon, type CaptureClaim, type Claim, type EditClaim, type ParsedManifest, type Rect } from "./manifest";
import { rootFromPath } from "./merkle";
import { decodeStore, mergeStores, type Store } from "./store";
import { checkTiles, decodePngReference, type TileCheck } from "./tiles";

export type Level = "ok" | "warn" | "fail" | "info";
export interface Finding {
  level: Level;
  code: string;
  text: string;
  manifest?: string;
}

export interface Fetcher {
  storeByHash(hash: Uint8Array): Promise<Uint8Array | null>;
  manifest(id: string): Promise<Uint8Array | null>;
  keyLog(did: string): Promise<Uint8Array | null>;
  statusList(issuer: string): Promise<StatusListDoc | null>;
  drandRound(kind: string, round: number): Promise<Uint8Array | null>;
}

/** Decides capture/1 mandates; optional, so the core doesn't need the policy engine. */
export type MandateCheck = (input: { mandate: Record<string, unknown>; device: string; media: string; mediaType: string; at: number; statusLists: StatusListDoc[] }) => Promise<{ outcome: string; reasons: string[] }>;

export interface VerifyContext {
  /** The verifier's clock, in Unix ms. */
  now: number;
  trust: TrustEntry[];
  drand: DrandChain[];
  fetch?: Fetcher;
  mandates?: MandateCheck;
  webauthnOrigins?: string[];
}

export interface SignerSummary {
  id: string;
  kind: "device" | "person";
  name?: string;
  label?: string;
  owner?: { did: string; name?: string; trusted: boolean; revoked?: boolean };
  maker?: { did: string; name?: string; model?: string; trusted: boolean };
  editorOf?: { did: string; name?: string; trusted: boolean; role?: string };
  keyClass?: string;
  keyClassEvidence?: string;
  deviceKind?: string;
  keyRef?: number;
  keyStatus?: "current" | "retiredAnchored" | "retiredUnanchored" | "retiredAfter";
  retiredAtSn?: number;
}

export interface Interval {
  notBefore?: number;
  notBeforeWhy?: string;
  notAfter?: number;
  notAfterWhy?: string;
}

export interface ChainStep {
  id: string;
  kind: "capture" | "edit";
  signer: SignerSummary;
  deviceTime: number;
  interval: Interval;
  actions?: Action[];
  tool?: EditClaim["tool"];
  content: { hash: string; mime: string; width?: number; height?: number; size: number };
  location?: CaptureClaim["location"];
  sensor?: CaptureClaim["sensor"];
  app?: CaptureClaim["app"];
  redactions?: { regions: Rect[]; method?: string; reason?: string }[];
  tiles?: Omit<TileCheck, "grid"> & { grid: TileCheck["grid"] };
  claim: Claim;
  ok: boolean;
}

export type Verdict = "verified" | "verifiedWithWarnings" | "untrustedIssuer" | "broken" | "none";

export interface Report {
  verdict: Verdict;
  findings: Finding[];
  /** From this file's manifest back to the capture. */
  chain: ChainStep[];
  storeSource: "sidecar" | "embedded" | "registry" | "none";
  contentHash: string;
  mime: string;
  /** The interval of the capture at the end of the chain. */
  interval?: Interval;
  /** The issuers whose credentials appear, for "trust this owner". */
  issuers: { did: string; name?: string; role: string; trusted: boolean }[];
  store?: Store;
}

const ALLOWED: CoseAlg[] = [-19, -9, -8, -7, -65600];
const MAX_DEPTH = 32;
const CLOCK_SLACK_MS = 2 * 60_000;

const fixedClock = (ms: number): Clock => ({ now: () => ms, iso: () => new Date(ms).toISOString(), date: () => new Date(ms) });
const fmt = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;

interface Ctx {
  store: Store;
  vc: VerifyContext;
  findings: Finding[];
  kels: Map<string, KelResult | null>;
  statusCache: Map<string, { doc: StatusListDoc; fresh: boolean } | null>;
}

function add(c: Ctx, level: Level, code: string, text: string, manifest?: string) {
  c.findings.push({ level, code, text, ...(manifest ? { manifest } : {}) });
}

async function keyLogFor(c: Ctx, did: string): Promise<KelResult | null> {
  if (c.kels.has(did)) return c.kels.get(did)!;
  let bytes = c.store.keyLogs[did];
  let fromRegistry = false;
  // a fresher log from the registry shows rotations that happened after the store was made
  if (c.vc.fetch) {
    const fresh = await c.vc.fetch.keyLog(did).catch(() => null);
    if (fresh) {
      bytes = fresh;
      fromRegistry = true;
    }
  }
  if (!bytes) {
    c.kels.set(did, null);
    return null;
  }
  let r = await readKeyLog(bytes);
  if (!isKelResult(r) && fromRegistry && c.store.keyLogs[did]) r = await readKeyLog(c.store.keyLogs[did]);
  if (!isKelResult(r)) {
    add(c, "fail", "keylog.invalid", `The key history of ${did} doesn't verify: ${r.error}.`);
    c.kels.set(did, null);
    return null;
  }
  if (!r.ok) {
    add(c, "fail", "keylog.invalid", `The key history of ${did} doesn't verify: ${r.problems.map((p) => p.message).join("; ")}.`);
    c.kels.set(did, null);
    return null;
  }
  c.kels.set(did, r);
  return r;
}

async function statusOf(c: Ctx, vc: Credential): Promise<{ revoked: boolean; fresh: boolean } | null> {
  const st = vc.credentialStatus;
  if (!st) return null;
  let entry = c.statusCache.get(vc.issuer);
  if (entry === undefined) {
    entry = null;
    const fresh = c.vc.fetch ? await c.vc.fetch.statusList(vc.issuer).catch(() => null) : null;
    const candidates: { doc: StatusListDoc; fresh: boolean }[] = [];
    if (fresh) candidates.push({ doc: fresh, fresh: true });
    for (const d of c.store.statusLists) if (d.issuer === vc.issuer) candidates.push({ doc: d, fresh: false });
    for (const cand of candidates) {
      const sig = await verifyDocument(cand.doc, fixedClock(c.vc.now)).catch(() => ({ valid: false }));
      if (sig.valid && cand.doc.issuer === vc.issuer) {
        entry = cand;
        break;
      }
    }
    c.statusCache.set(vc.issuer, entry);
  }
  if (!entry) return null;
  return { revoked: isRevokedIn(entry.doc, st.statusListIndex), fresh: entry.fresh };
}

const trusted = (c: Ctx, did: string, role: TrustEntry["trustedFor"][number]) => c.vc.trust.some((t) => t.did === did && t.trustedFor.includes(role));
const trustName = (c: Ctx, did: string) => c.vc.trust.find((t) => t.did === did)?.name;

interface CredCheck {
  vc: Credential;
  kind: string;
  revoked: boolean;
  trusted: boolean;
}

async function credentialsFor(c: Ctx, subject: string, at: number, id: string): Promise<CredCheck[]> {
  const out: CredCheck[] = [];
  for (const vc of c.store.credentials) {
    if (vc?.credentialSubject?.id !== subject) continue;
    const kind = credentialKind(vc);
    const r = await verifyCredential(vc, fixedClock(at)).catch(() => ({ ok: false as const, failure: "malformedProof" as const }));
    if (!r.ok) {
      if (r.failure === "notYetValid" || r.failure === "expired") add(c, "warn", "credential.outsideValidity", `A ${kind} credential for this signer wasn't valid at the time of signing (${r.failure === "expired" ? "it had expired" : "it was issued later"}).`, id);
      else add(c, "fail", "credential.invalid", `A ${kind} credential for this signer has a bad signature.`, id);
      continue;
    }
    const s = await statusOf(c, vc);
    if (vc.credentialStatus && !s) add(c, "warn", "credential.statusUnknown", `Couldn't check whether the ${kind} credential was revoked.`, id);
    const role = kind === "other" ? "owner" : (kind as TrustEntry["trustedFor"][number]);
    out.push({ vc, kind, revoked: !!s?.revoked, trusted: trusted(c, vc.issuer, role) });
    if (s?.revoked) add(c, "warn", "credential.revoked", `The ${kind} credential from ${String(vc.credentialSubject.ownerName ?? trustName(c, vc.issuer) ?? vc.issuer)} has been revoked${s.fresh ? "" : " (according to the copy of the list in the file)"}. The list doesn't say when.`, id);
  }
  return out;
}

async function beaconBound(c: Ctx, beacons: Beacon[], id: string): Promise<{ at: number; why: string } | undefined> {
  let best: { at: number; why: string } | undefined;
  for (const b of beacons) {
    const chain = c.vc.drand.find((d) => d.kind === b.kind);
    if (!chain) {
      add(c, "info", "time.unknownBeacon", `A ${b.kind} time beacon isn't one this verifier knows, so it was ignored.`, id);
      continue;
    }
    let sig: Uint8Array | null | undefined = c.store.beacons[`${b.kind}:${b.round}`];
    if (!sig && c.vc.fetch) sig = await c.vc.fetch.drandRound(b.kind, b.round).catch(() => null);
    if (!sig) {
      add(c, "warn", "time.beaconUnchecked", `The time beacon (round ${b.round}) couldn't be fetched to check it.`, id);
      continue;
    }
    if (!verifyRound(chain, b.round, sig) || !equal(randomnessOf(sig).subarray(0, b.prefix.length), b.prefix) || b.prefix.length < 2) {
      add(c, "fail", "time.beaconInvalid", `The signed time beacon (round ${b.round}) doesn't match the published round.`, id);
      continue;
    }
    const at = roundTime(chain, b.round);
    const why = `after ${b.kind === "drand-quicknet" ? "drand" : "the development beacon's"} round ${b.round}`;
    if (!best || at > best.at) best = { at, why };
  }
  return best;
}

interface AnchorResult {
  notAfter?: number;
  why?: string;
  /** The interaction event's sn, when a valid anchor was found. */
  sn?: number;
}

function trailAnchor(c: Ctx, kel: KelResult, did: string, p: ParsedManifest): AnchorResult {
  const out: AnchorResult = {};
  for (const a of c.store.anchors[p.idText] ?? []) {
    if (a.kind !== "trail" || a.log !== did) continue;
    const root = rootFromPath(p.id, a.index, a.size, a.path);
    if (!root) {
      add(c, "fail", "anchor.badPath", "An anchor's Merkle path is malformed.", p.idText);
      continue;
    }
    const at = anchoredIn(kel, root).find((x) => x.kelSn === a.event && x.status === "valid");
    if (!at) {
      add(c, "warn", "anchor.notFound", `The anchor names event ${a.event} of the device's key history, which doesn't hold this batch.`, p.idText);
      continue;
    }
    const w = witnessedBy(kel, a.event);
    if (out.sn === undefined || a.event < out.sn) out.sn = a.event;
    if (w && (out.notAfter === undefined || w.at < out.notAfter)) {
      out.notAfter = w.at;
      out.why = `before ${w.witnesses >= w.of ? (w.of === 1 ? "its witness" : `${w.of} of ${w.of} witnesses`) : `${w.witnesses} of ${w.of} witnesses`} received it`;
    }
  }
  return out;
}

async function verifyDeviceManifest(c: Ctx, p: ParsedManifest, step: ChainStep): Promise<void> {
  const did = p.claim.signer;
  const kel = await keyLogFor(c, did);
  step.signer.kind = "device";
  if (!kel) {
    add(c, "fail", "keylog.missing", "The device's key history isn't in the file or the registry, so its signature can't be checked.", p.idText);
    step.ok = false;
    return;
  }
  const data = deviceData(kel);
  step.signer.keyClass = String(data.keyClass ?? "");
  step.signer.deviceKind = String(data.device ?? "");
  step.signer.keyRef = p.keyRef;
  if (p.keyRef === undefined) {
    add(c, "fail", "manifest.kid", "The signature doesn't say which of the device's keys made it.", p.idText);
    step.ok = false;
    return;
  }
  const keys: PublicKey[] = keyAt(kel, p.keyRef).map((k) => ({ curve: k.curve, bytes: k.bytes }));
  if (!keys.length) {
    add(c, "fail", "manifest.unknownKey", `The device's key history has no key event ${p.keyRef}.`, p.idText);
    step.ok = false;
    return;
  }
  const v = await verifyCose1(p.cose, async () => keys, { allowedAlgs: ALLOWED, webauthnOrigins: c.vc.webauthnOrigins });
  if (!v.ok) {
    add(c, "fail", "signature.invalid", `The device's signature doesn't verify (${v.failure}).`, p.idText);
    step.ok = false;
    return;
  }
  add(c, "ok", "signature.ok", "Signed by the device's key.", p.idText);
  const label = p.claim.kind === "capture" ? p.claim.sensor?.trackLabel : undefined;
  if (label && /virtual|obs|fake|snap camera|manycam|droidcam/i.test(label))
    add(c, "warn", "capture.virtualCamera", `The camera input was named “${label}”, which is a virtual or test camera: the picture may not have come from a lens.`, p.idText);

  // time
  const nb = await beaconBound(c, p.claim.beacons ?? [], p.idText);
  const an = trailAnchor(c, kel, did, p);
  step.interval = { ...(nb ? { notBefore: nb.at, notBeforeWhy: nb.why } : {}), ...(an.notAfter !== undefined ? { notAfter: an.notAfter, notAfterWhy: an.why } : {}) };

  // key history
  const retired = retiredAt(kel, p.keyRef);
  if (retired === null) {
    step.signer.keyStatus = "current";
    add(c, "ok", "key.current", "The key is still the device's current key.", p.idText);
  } else {
    step.signer.retiredAtSn = retired;
    const rot = witnessedBy(kel, retired);
    if (an.sn !== undefined && an.sn >= p.keyRef && an.sn < retired) {
      step.signer.keyStatus = "retiredAnchored";
      add(c, "ok", "key.retiredAfter", "Signed before the key was retired: it was anchored in the device's key history while the key was current.", p.idText);
    } else if (nb && rot && nb.at > rot.at) {
      step.signer.keyStatus = "retiredAfter";
      add(c, "fail", "key.usedAfterRetirement", `Signed after this device's key was retired. The owner replaced the key by ${fmt(rot.at)}, and this was signed ${nb.why.replace("after ", "after ")} at ${fmt(nb.at)}.`, p.idText);
      step.ok = false;
    } else if (an.sn !== undefined) {
      step.signer.keyStatus = "retiredAfter";
      add(c, "fail", "key.anchoredAfterRetirement", "The anchor comes after the key was retired.", p.idText);
      step.ok = false;
    } else {
      step.signer.keyStatus = "retiredUnanchored";
      add(c, "warn", "key.retiredUnanchored", "Signed with a key that was later retired, and there is no proof it was signed before that.", p.idText);
    }
  }

  // credentials
  const at = step.interval.notAfter ?? step.interval.notBefore ?? p.claim.deviceTime;
  const creds = await credentialsFor(c, did, at, p.idText);
  const owner = creds.find((x) => x.kind === "owner" && !x.revoked) ?? creds.find((x) => x.kind === "owner");
  const maker = creds.find((x) => x.kind === "maker");
  if (owner) {
    const s = owner.vc.credentialSubject as Record<string, unknown>;
    step.signer.label = String(s.label ?? "");
    step.signer.name = String(s.label ?? "");
    step.signer.owner = { did: owner.vc.issuer, name: String(s.ownerName ?? ""), trusted: owner.trusted, revoked: owner.revoked };
  }
  if (maker) {
    const s = maker.vc.credentialSubject as Record<string, unknown>;
    step.signer.maker = { did: maker.vc.issuer, name: String(s.maker ?? ""), model: String(s.model ?? ""), trusted: maker.trusted };
    step.signer.keyClass = String(s.keyClass ?? step.signer.keyClass);
    step.signer.keyClassEvidence = String(s.keyClassEvidence ?? "");
  }
  if (!owner) add(c, "warn", "owner.none", "No owner vouches for this device.", p.idText);
  else if (!owner.trusted) add(c, "info", "owner.untrusted", `The owner, ${step.signer.owner?.name || owner.vc.issuer}, isn't on your trust list.`, p.idText);
  else add(c, "ok", "owner.trusted", `Owned by ${step.signer.owner?.name}, whom you trust.`, p.idText);

  // the owner's capture/1 mandate, when the file carries one
  const mandate = c.store.mandates.find((m) => (m.credentialSubject as { id?: string } | undefined)?.id === did);
  if (mandate && c.vc.mandates) {
    const d = await c.vc.mandates({ mandate, device: did, media: `sha-256:${hex(p.claim.content.hash)}`, mediaType: p.claim.content.mime, at, statusLists: c.store.statusLists }).catch((e) => ({ outcome: "deny", reasons: [String(e)] }));
    if (d.outcome === "allow") add(c, "ok", "mandate.allow", "The owner's mandate allows this device to sign this kind of photo.", p.idText);
    else add(c, "warn", "mandate.deny", `The owner's mandate doesn't allow this: ${d.reasons.join(" ")}`, p.idText);
  }
}

async function verifyPersonManifest(c: Ctx, p: ParsedManifest, step: ChainStep, owners: Set<string>): Promise<void> {
  const did = p.claim.signer;
  step.signer.kind = "person";
  let key: Uint8Array;
  try {
    key = resolveDidKey(did).signingKey;
  } catch {
    add(c, "fail", "signer.unknown", `The editor's identifier (${did}) can't be resolved.`, p.idText);
    step.ok = false;
    return;
  }
  const v = await verifyCose1(p.cose, async () => [{ curve: "ed25519", bytes: key }], { allowedAlgs: [-19, -8] });
  if (!v.ok) {
    add(c, "fail", "signature.invalid", `The editor's signature doesn't verify (${v.failure}).`, p.idText);
    step.ok = false;
    return;
  }
  add(c, "ok", "signature.ok", "Signed by the editor's key.", p.idText);
  const nb = await beaconBound(c, p.claim.beacons ?? [], p.idText);
  if (nb) step.interval = { notBefore: nb.at, notBeforeWhy: nb.why };
  const creds = await credentialsFor(c, did, nb?.at ?? p.claim.deviceTime, p.idText);
  const ed = creds.find((x) => x.kind === "editor" && !x.revoked);
  if (ed) {
    const s = ed.vc.credentialSubject as Record<string, unknown>;
    step.signer.name = String(s.name ?? "");
    const trustedEditor = ed.trusted || owners.has(ed.vc.issuer);
    step.signer.editorOf = { did: ed.vc.issuer, name: String(s.ownerName ?? ""), trusted: trustedEditor, role: String(s.role ?? "") };
    if (trustedEditor) add(c, "ok", "edit.editorAuthorized", `Edited by ${step.signer.name}, who edits for ${s.ownerName}.`, p.idText);
    else add(c, "warn", "edit.editorNotAuthorized", `The editor ${step.signer.name} is vouched for by ${s.ownerName || ed.vc.issuer}, which you don't trust for editing.`, p.idText);
  } else {
    add(c, "warn", "edit.editorNotAuthorized", "The edit was signed by someone nobody you trust vouches for as an editor.", p.idText);
  }
}

function regionsOf(actions: Action[]): { regions: Rect[]; method?: string; reason?: string }[] {
  const out: { regions: Rect[]; method?: string; reason?: string }[] = [];
  for (const a of actions) {
    if (a.action !== "capture.redactedRegion") continue;
    const p = (a.params ?? {}) as { regions?: Rect[]; method?: string; reason?: string };
    out.push({ regions: Array.isArray(p.regions) ? p.regions : [], method: p.method, reason: p.reason });
  }
  return out;
}

async function getManifest(c: Ctx, id: string): Promise<Uint8Array | null> {
  const have = c.store.manifests[id];
  if (have) return have;
  if (!c.vc.fetch) return null;
  const got = await c.vc.fetch.manifest(id).catch(() => null);
  if (got) c.store.manifests[id] = got;
  return got;
}

const summaryOf = (claim: Claim): SignerSummary => ({ id: claim.signer, kind: isDeviceDid(claim.signer) ? "device" : "person" });

/** Verifies a file. `sidecar` is a .capture store file, if one was given. */
export async function verifyAsset(file: Uint8Array, sidecar: Uint8Array | null, vc: VerifyContext): Promise<Report> {
  const mime = sniffMime(file);
  let hash: Uint8Array;
  try {
    hash = contentHash(file, mime);
  } catch (e) {
    return { verdict: "none", findings: [{ level: "fail", code: "file.unreadable", text: `The file can't be read: ${(e as Error).message}.` }], chain: [], storeSource: "none", contentHash: "", mime, issuers: [] };
  }
  const findings: Finding[] = [];
  // 1. find the store
  let store: Store | null = null;
  let storeSource: Report["storeSource"] = "none";
  try {
    if (sidecar) {
      store = decodeStore(sidecar);
      storeSource = "sidecar";
    }
  } catch {
    findings.push({ level: "fail", code: "store.unreadable", text: "The .capture file is damaged and can't be read." });
  }
  if (!store) {
    try {
      store = extractStore(file, mime);
      if (store) storeSource = "embedded";
    } catch {
      findings.push({ level: "warn", code: "store.unreadable", text: "The credentials inside the file are damaged." });
    }
  }
  if (!store && vc.fetch) {
    const got = await vc.fetch.storeByHash(hash).catch(() => null);
    if (got) {
      try {
        store = decodeStore(got);
        storeSource = "registry";
        findings.push({ level: "info", code: "store.registry", text: "This file carries no credentials. They were found in the registry by the file's fingerprint." });
      } catch {
        // ignore
      }
    }
  }
  if (!store) {
    findings.push({ level: "info", code: "store.none", text: "No Capture credentials were found in the file, beside it, or in the registry." });
    return { verdict: "none", findings, chain: [], storeSource, contentHash: hex(hash), mime, issuers: [] };
  }
  // a sidecar or embedded store may be older than the registry's copy (late anchors); merge what the registry has
  if (storeSource !== "registry" && vc.fetch) {
    const got = await vc.fetch.storeByHash(hash).catch(() => null);
    if (got) {
      try {
        const reg = decodeStore(got);
        if (reg.active === store.active) store = mergeStores(reg, store);
      } catch {
        // ignore
      }
    }
  }

  const c: Ctx = { store, vc, findings, kels: new Map(), statusCache: new Map() };
  // 2. bind the file to the active manifest
  const activeBytes = store.manifests[store.active];
  const active = activeBytes ? parseManifest(activeBytes) : { error: "missing" };
  if ("error" in active) {
    add(c, "fail", "manifest.unreadable", "The file's own manifest is missing or unreadable.");
    return finish(c, [], storeSource, hash, mime);
  }
  if (!equal(active.claim.content.hash, hash)) {
    add(c, "fail", "file.mismatch", "This file doesn't match its credentials. Its fingerprint differs from the one that was signed, so it was changed after signing.", active.idText);
  } else add(c, "ok", "file.match", "The file is exactly the one that was signed.", active.idText);

  // 3–10. walk the chain
  const chain: ChainStep[] = [];
  const seen = new Set<string>();
  const owners = new Set<string>();
  // collect device owners first, so an editor vouched for by the capture's own owner counts
  for (const vc0 of store.credentials) if (credentialKind(vc0) === "owner" && trusted(c, vc0.issuer, "owner")) owners.add(vc0.issuer);
  let queue: { p: ParsedManifest; expectContent?: Uint8Array; childId?: string }[] = [{ p: active }];
  let depth = 0;
  while (queue.length) {
    const next: typeof queue = [];
    for (const { p, expectContent, childId } of queue) {
      if (seen.has(p.idText)) {
        add(c, "fail", "chain.cycle", "The edit chain loops back on itself.", p.idText);
        continue;
      }
      seen.add(p.idText);
      if (p.kidSigner !== p.claim.signer) {
        add(c, "fail", "manifest.signerMismatch", "The manifest names a different signer than the key that signed it.", p.idText);
      }
      if (expectContent && !equal(expectContent, p.claim.content.hash))
        add(c, "fail", "chain.parentMismatch", `The edit${childId ? "" : ""} names a parent photo whose fingerprint doesn't match. This file may not come from the photo it claims.`, childId);
      const claim = p.claim;
      const step: ChainStep = {
        id: p.idText,
        kind: claim.kind,
        signer: summaryOf(claim),
        deviceTime: claim.deviceTime,
        interval: {},
        content: { hash: hex(claim.content.hash), mime: claim.content.mime, width: claim.content.width, height: claim.content.height, size: claim.content.size },
        claim,
        ok: true,
      };
      if (claim.kind === "capture") {
        step.location = claim.location;
        step.sensor = claim.sensor;
        step.app = claim.app;
        if (!isDeviceDid(claim.signer)) {
          add(c, "fail", "capture.notDevice", "A capture must be signed by a device.", p.idText);
          step.ok = false;
        } else await verifyDeviceManifest(c, p, step);
        if (step.signer.owner?.trusted) owners.add(step.signer.owner.did);
      } else {
        step.actions = claim.actions;
        step.tool = claim.tool;
        step.redactions = regionsOf(claim.actions);
        await verifyPersonManifest(c, p, step, owners);
        if (!claim.parents?.length) add(c, "fail", "chain.noParent", "An edit names no parent.", p.idText);
        for (const parent of claim.parents ?? []) {
          const pid = idText(parent.manifest);
          const bytes = await getManifest(c, pid);
          if (!bytes) {
            add(c, "warn", "chain.incomplete", "The chain is incomplete: a parent manifest isn't in the file or the registry.", p.idText);
            continue;
          }
          const pp = parseManifest(bytes);
          if ("error" in pp) {
            add(c, "fail", "manifest.unreadable", `A parent manifest is unreadable (${pp.error}).`, p.idText);
            continue;
          }
          if (pp.idText !== pid) {
            add(c, "fail", "chain.parentMismatch", "A parent manifest's bytes don't match the id the edit names.", p.idText);
            continue;
          }
          next.push({ p: pp, expectContent: parent.content, childId: p.idText });
        }
        for (const a of claim.actions ?? [])
          if (a.digitalSourceType?.includes("trainedAlgorithmicMedia")) add(c, "info", "edit.ai", `AI-generated content was added${a.softwareAgent ? ` (${a.softwareAgent})` : ""}.`, p.idText);
      }
      chain.push(step);
    }
    queue = next;
    if (++depth > MAX_DEPTH && queue.length) {
      add(c, "fail", "chain.tooDeep", `The edit chain is longer than ${MAX_DEPTH} steps.`);
      break;
    }
  }

  // tile proof for the file in hand
  const top = chain[0];
  if (top?.kind === "edit") {
    const e = top.claim as EditClaim;
    if (e.tileProof && mime === "image/png" && equal(e.content.hash, hash)) {
      const against = chain.find((s) => s.kind === "capture" && s.id === idText(e.tileProof!.against));
      const cap = against?.claim as CaptureClaim | undefined;
      const hashes = store.tiles[idText(e.tileProof.against)]?.hashes;
      const salts = store.salts[top.id];
      if (!cap?.tiles || !hashes || !salts || !cap.content.width || !cap.content.height) add(c, "warn", "tiles.missing", "The redaction proof can't be checked: the capture's tile list or the salts are missing.", top.id);
      else if (!equal(sha(hashes), cap.tiles.root)) add(c, "fail", "tiles.rootMismatch", "The capture's tile list doesn't match what the camera signed.", top.id);
      else {
        const regions = (top.redactions ?? []).flatMap((r) => r.regions);
        const t = checkTiles(decodePngReference(file), { width: cap.content.width, height: cap.content.height, commit: cap.tiles }, hashes, e.tileProof, salts, regions);
        top.tiles = t;
        if (t.failures.length) {
          const und = t.failures.filter((f) => f.reason === "undeclaredChange").length;
          const chg = t.failures.filter((f) => f.reason === "changed").length;
          add(
            c,
            "fail",
            "tiles.changed",
            `${chg ? `${chg} area${chg > 1 ? "s" : ""} the editor said were unchanged ${chg > 1 ? "are" : "is"} not what the camera captured. ` : ""}${und ? `${und} area${und > 1 ? "s" : ""} changed outside every declared redaction.` : ""}`.trim() || "The redaction proof is malformed.",
            top.id,
          );
        } else
          add(
            c,
            "ok",
            "tiles.ok",
            `Unchanged from the capture: ${t.kept} of ${t.total} tiles. Redacted: ${t.redacted} tile${t.redacted === 1 ? "" : "s"}${top.redactions?.length ? `, in ${top.redactions.reduce((n, r) => n + r.regions.length, 0)} region${top.redactions.reduce((n, r) => n + r.regions.length, 0) === 1 ? "" : "s"}` : ""}. Cropped: ${t.cropped ? `${t.cropped} tiles` : "none"}.`,
            top.id,
          );
      }
    } else if (!e.tileProof || mime !== "image/png") {
      add(c, "warn", "tiles.none", "Edited, and the rest of the image is not proven unchanged.", top.id);
    }
  }

  // time for the capture(s)
  for (const s of chain) {
    if (s.kind !== "capture") continue;
    const { notBefore, notAfter } = s.interval;
    if (notBefore !== undefined && notAfter !== undefined && notBefore > notAfter) add(c, "fail", "time.contradiction", "The time evidence contradicts itself: the capture was anchored before its beacon was published.", s.id);
    if (notBefore === undefined) add(c, "warn", "time.noNotBefore", "There is no proof of the earliest time this was captured; only the device's clock.", s.id);
    if (notAfter === undefined) add(c, "warn", "time.noNotAfter", "There is no proof yet of the latest time this was captured: no witness has anchored it.", s.id);
    const dt = s.deviceTime;
    if ((notBefore !== undefined && dt < notBefore - CLOCK_SLACK_MS) || (notAfter !== undefined && dt > notAfter + CLOCK_SLACK_MS))
      add(c, "warn", "time.deviceClockWrong", `The device clock was wrong: it said ${fmt(dt)}, outside the interval that can be proven.`, s.id);
  }

  return finish(c, chain, storeSource, hash, mime);
}

function finish(c: Ctx, chain: ChainStep[], storeSource: Report["storeSource"], hash: Uint8Array, mime: string): Report {
  const capture = chain.find((s) => s.kind === "capture");
  const issuers = new Map<string, { did: string; name?: string; role: string; trusted: boolean }>();
  for (const vc of c.store.credentials) {
    const role = credentialKind(vc);
    const s = vc.credentialSubject as Record<string, unknown>;
    const name = String(s.ownerName ?? s.maker ?? trustName(c, vc.issuer) ?? "");
    const k = `${vc.issuer}|${role}`;
    if (!issuers.has(k)) issuers.set(k, { did: vc.issuer, name: name || undefined, role, trusted: trusted(c, vc.issuer, role === "other" ? "owner" : (role as TrustEntry["trustedFor"][number])) });
  }
  const f = c.findings;
  let verdict: Verdict;
  if (f.some((x) => x.level === "fail")) verdict = "broken";
  else if (!capture) verdict = chain.length ? "untrustedIssuer" : "none";
  else if (!capture.signer.owner?.trusted) verdict = "untrustedIssuer";
  else if (f.some((x) => x.level === "warn")) verdict = "verifiedWithWarnings";
  else verdict = "verified";
  return { verdict, findings: f, chain, storeSource, contentHash: hex(hash), mime, interval: capture?.interval, issuers: [...issuers.values()], store: c.store };
}
