/** Signatures made outside the log, bundles, and trailRef checks (trail design §11.3, §11.4, §12.1). */
import { sha256 } from "@noble/hashes/sha2.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { utf8, type Clock } from "@zk-toip/trust-core";
import { verifyBinding, type DidBinding } from "./binding";
import { encode, isQb64 } from "./cesr";
import type { WitnessClient } from "./client";
import { isDigestSeal, retiredAt, sealsOf, verifyKel, type KelResult, type VerifyOptions } from "./kel";
import { verifyCouple, verifyKeySig } from "./keys";
import type { LogStore } from "./store";
import { fromStream } from "./stream";
import { checkKeyRefSig, cutStatus, verifyTrail, type TrailResult, type TrailVerifyOptions } from "./trail";
import type { Body, KeyRef, KeyRefSig, Problem, Qb64, SignedMessage } from "./types";
import { problem } from "./types";

/** The digest forms we look for when matching anchors: Blake3 (E) and SHA-256 (I). */
export function digestForms(bytes: Uint8Array): Qb64[] {
  return [encode("E", blake3(bytes)), encode("I", sha256(bytes))];
}

function seal32(digest: Qb64 | Uint8Array): Qb64[] {
  if (typeof digest === "string") return [digest];
  if (digest.length !== 32) throw new Error("a raw digest must be 32 bytes");
  return [encode("E", digest), encode("I", digest)];
}

export interface Anchor {
  /** In the KEL: the event that anchors it. */
  kelSn?: number;
  /** In a trail: the entry that anchors it. */
  trailId?: Qb64;
  s?: number;
  receipts: Qb64[];
  earliestReceipt?: string;
  status: string;
  keyState?: KeyRef;
}

/**
 * Where a digest is anchored: KEL seals {d}, and trail entries' `a` or `x`.
 * `digest` is a qb64 digest, or 32 raw bytes (matched as Blake3 or SHA-256).
 */
export function anchoredIn(kel: KelResult, digest: Qb64 | Uint8Array, trails: TrailResult[] = []): Anchor[] {
  const forms = new Set(seal32(digest));
  const out: Anchor[] = [];
  for (const m of kel.messages) {
    if (!sealsOf(m).some((a) => isDigestSeal(a) && forms.has(a.d))) continue;
    const ev = kel.events.find((e) => e.s === m.s && e.d === m.d);
    out.push({ kelSn: m.s, receipts: ev?.receipts ?? [], status: ev?.status ?? "valid" });
  }
  for (const t of trails) {
    for (const e of t.entries) {
      if (!(forms.has(e.a as Qb64) || e.x.some((x) => forms.has(x.d)))) continue;
      const a: Anchor = { trailId: t.trailId, s: e.s, receipts: e.receipts.map((r) => r.witness), status: e.status, keyState: e.keyState };
      if (e.earliestReceipt) a.earliestReceipt = e.earliestReceipt;
      out.push(a);
    }
  }
  return out;
}

export interface SignatureCheck {
  valid: boolean;
  keyState: KeyRef;
  current: boolean;
  retiredAt?: number;
  anchored?: { trailId?: Qb64; s?: number; kelSn?: number };
  anchoredBeforeRetirement: boolean;
  witnessedBy?: string;
  disputed: boolean;
  problems: Problem[];
}

/** Checks a signature made outside the log against the key state it names, and whether it was anchored while that key was current. */
export async function verifySignature(
  input: { bytes: Uint8Array; sig: KeyRefSig; kel: KelResult; trails?: TrailResult[] },
  opts: VerifyOptions = {},
): Promise<SignatureCheck> {
  const { bytes, sig, kel } = input;
  const keyState: KeyRef = { aid: sig.aid, estSn: sig.estSn, estSaid: sig.estSaid };
  const out: SignatureCheck = { valid: false, keyState, current: false, anchoredBeforeRetirement: false, disputed: false, problems: [] };
  const est = kel.states.find((s) => s.estSn === sig.estSn && s.estSaid === sig.estSaid);
  if (sig.aid !== kel.aid || !est) {
    out.problems.push(problem("unknownKeyState", "the key state is not in the KEL", sig.aid));
    return out;
  }
  const seen = new Set<number>();
  for (const s of sig.sigs) {
    const k = est.keys[s.index];
    if (!k || !(await verifyKeySig(k, bytes, s, opts))) {
      out.problems.push(problem("signatureInvalid", `signature ${s.index} does not verify`, sig.aid));
      return out;
    }
    seen.add(s.index);
  }
  if (seen.size < est.kt) {
    out.problems.push(problem("thresholdNotMet", `${seen.size} of ${est.kt} signatures`, sig.aid));
    return out;
  }
  out.valid = true;
  const r = retiredAt(kel, est.estSn);
  out.current = r === null;
  if (r !== null) out.retiredAt = r;
  const anchors = anchoredIn(kel, bytes.length === 32 ? bytes : blake3(bytes), input.trails).concat(bytes.length === 32 ? [] : anchoredIn(kel, sha256(bytes), input.trails));
  // anchored before retirement: in a trail entry under the same key state, valid, not cut; or in a KEL event while current
  let best: Anchor | undefined;
  for (const a of anchors) {
    if (a.trailId !== undefined) {
      if (a.keyState?.estSn !== est.estSn) continue;
      if (a.status === "cut") {
        out.disputed = true;
        continue;
      }
      if (a.status === "valid" || (opts.allowUnwitnessed && a.status === "pending")) best ??= a;
    } else if (a.kelSn !== undefined) {
      if (a.kelSn >= est.estSn && (r === null || a.kelSn < r) && (a.status === "valid" || opts.allowUnwitnessed)) best ??= a;
    }
  }
  if (best) {
    out.anchored = best.trailId !== undefined ? { trailId: best.trailId, s: best.s } : { kelSn: best.kelSn };
    out.anchoredBeforeRetirement = true;
    if (best.earliestReceipt) out.witnessedBy = best.earliestReceipt;
    out.disputed = false;
  }
  return out;
}

// ---- bundles

export interface Bundle {
  kel: string;
  trails: { id: Qb64; stream: string; bodies?: Body[] }[];
  bindings: DidBinding[];
}

async function logStream(store: LogStore, logId: Qb64): Promise<string> {
  let out = "";
  for (const m of await store.all(logId)) {
    out += m.raw + m.attachments;
    for (const r of await store.receipts(m.logId, m.s, m.d)) out += r.raw + r.attachments;
  }
  return out;
}

/**
 * Everything needed to verify an AID's logs offline: KEL (all versions, so recoveries show), trails with receipts and endorsements,
 * the disclosed bodies, and DID bindings. `bodies` takes body SAIDs, or entry numbers per trail.
 */
export async function exportBundle(
  store: LogStore,
  aid: Qb64,
  opts: { trails?: Qb64[]; bodies?: "all" | "none" | Qb64[]; entries?: Record<Qb64, number[]> } = {},
): Promise<Bundle> {
  const kel = await logStream(store, aid);
  const logs = (await store.logs()).filter((l) => l.kind === "trail" && l.controller === aid && (!opts.trails || opts.trails.includes(l.logId)));
  const trails: Bundle["trails"] = [];
  for (const l of logs) {
    const stream = await logStream(store, l.logId);
    const bodies: Body[] = [];
    const want = opts.bodies ?? "none";
    const pick = opts.entries?.[l.logId];
    for (const m of await store.all(l.logId)) {
      if (m.t !== "ten") continue;
      const a = String(JSON.parse(m.raw).a);
      if (!a) continue;
      const wanted = want === "all" || (Array.isArray(want) && want.includes(a)) || (pick?.includes(m.s) ?? false);
      if (!wanted) continue;
      const raw = await store.getBody(a);
      if (raw) bodies.push(JSON.parse(raw));
    }
    trails.push({ id: l.logId, stream, ...(bodies.length ? { bodies } : {}) });
  }
  const bindings: DidBinding[] = [];
  for (const m of fromStream(kel).messages) {
    for (const a of sealsOf(m)) {
      if (!isDigestSeal(a)) continue;
      const raw = await store.getBody(a.d);
      if (!raw) continue;
      try {
        const doc = JSON.parse(raw);
        if (doc?.type === "trail/did-binding" && !bindings.some((b) => JSON.stringify(b) === raw)) bindings.push(doc);
      } catch {
        // not a binding
      }
    }
  }
  return { kel, trails, bindings };
}

export interface BundleResult {
  ok: boolean;
  kel: KelResult;
  trails: TrailResult[];
  bindings: { did: string; ok: boolean; sealedAt?: number; replacedAt?: number }[];
  /** Heads were compared with witnesses at verification time. Otherwise the bundle is complete only up to its last head. */
  witnessChecked: boolean;
  problems: Problem[];
}

export async function verifyBundle(
  b: Bundle,
  opts: TrailVerifyOptions & { expectDid?: string; witnesses?: WitnessClient[]; clock?: Clock } = {},
): Promise<BundleResult> {
  const problems: Problem[] = [];
  const kel = await verifyKel(b.kel, opts);
  problems.push(...kel.problems);
  const trails: TrailResult[] = [];
  for (const t of b.trails) {
    const r = await verifyTrail({ kel, stream: t.stream, bodies: t.bodies }, opts);
    if (r.trailId !== t.id) problems.push(problem("badFields", "trail id does not match its stream", t.id));
    trails.push(r);
    problems.push(...r.problems);
  }
  const clock = opts.clock ?? { now: () => Date.now(), iso: () => new Date().toISOString(), date: () => new Date() };
  const bindings: BundleResult["bindings"] = [];
  for (const bd of b.bindings) {
    const r = await verifyBinding(bd, kel, clock, b.bindings);
    bindings.push({ did: bd.issuer, ok: r.ok, ...(r.sealedAt !== undefined ? { sealedAt: r.sealedAt } : {}), ...(r.replacedAt !== undefined ? { replacedAt: r.replacedAt } : {}) });
    problems.push(...r.problems);
  }
  if (opts.expectDid && !bindings.some((x) => x.ok && x.did === opts.expectDid && x.replacedAt === undefined))
    problems.push(problem("bindingInvalid", `no valid binding to ${opts.expectDid}`, kel.aid));
  let witnessChecked = false;
  if (opts.witnesses?.length) {
    witnessChecked = true;
    const logs: { id: Qb64; head?: { s: number; d: Qb64 } }[] = [
      { id: kel.aid, head: kel.latest.sn >= 0 ? { s: kel.latest.sn, d: kel.latest.said } : undefined },
      ...trails.map((t) => ({ id: t.trailId, head: t.head })),
    ];
    for (const l of logs) {
      let answered = false;
      for (const w of opts.witnesses) {
        let h: SignedMessage | undefined;
        try {
          h = await w.head(l.id);
        } catch {
          continue;
        }
        answered = true;
        if (!h) continue;
        if (!l.head || h.s > l.head.s) problems.push(problem("truncated", `witness ${w.aid} holds entry ${h.s}; the bundle ends at ${l.head?.s ?? -1}`, l.id, h.s));
        else if (h.s === l.head.s && h.d !== l.head.d) problems.push(problem("duplicity", `witness ${w.aid} holds another version of ${h.s}`, l.id, h.s));
      }
      if (!answered) witnessChecked = false;
    }
  }
  const ok = problems.length === 0 && kel.ok && trails.every((t) => t.ok) && bindings.every((x) => x.ok);
  return { ok, kel, trails, bindings, witnessChecked, problems };
}

// ---- trailRef checks for counterparties

export interface TrailRefCheck {
  ok: boolean;
  entry?: SignedMessage;
  kel?: KelResult;
  controller?: Qb64;
  receipts: { witness: Qb64; dt: string }[];
  problems: Problem[];
}

/**
 * Checks a trailRef {i, s, d} against a witness: fetches the entry, its receipts and the controller's KEL, and verifies them.
 * Use httpWitnessClient inside a Trust Task handler, so the check doesn't await a TSP request.
 */
export async function checkTrailRef(ref: { i: Qb64; s: string | number; d: Qb64 }, witness: WitnessClient, opts: VerifyOptions = {}): Promise<TrailRefCheck> {
  const problems: Problem[] = [];
  const s = typeof ref.s === "number" ? ref.s : parseInt(ref.s, 16);
  const fail = (p: Problem): TrailRefCheck => ({ ok: false, receipts: [], problems: [...problems, p] });
  if (!isQb64(ref.i, ["E"]) || !isQb64(ref.d, ["E"]) || !Number.isInteger(s) || s < 0) return fail(problem("badFields", "bad trailRef"));
  const tin = fromStream(await witness.query({ logId: ref.i, from: 0, to: 0 })).messages.find((m) => m.t === "tin");
  if (!tin) return fail(problem("unknownKeyState", "the witness doesn't hold this trail", ref.i));
  const controller = String(tin.body.ci);
  const kel = await verifyKel(await witness.query({ logId: controller }), opts);
  if (!kel.ok) return { ok: false, kel, controller, receipts: [], problems: kel.problems };
  const got = fromStream(await witness.query({ logId: ref.i, from: s, to: s })).messages;
  const entry = got.find((m) => m.t !== "trc" && m.s === s);
  if (!entry) return fail(problem("truncated", `the witness doesn't hold entry ${s}`, ref.i, s));
  if (entry.d !== ref.d) return { ok: false, entry, kel, controller, receipts: [], problems: [problem("duplicity", "the witness holds another version of this entry", ref.i, s)] };
  if (entry.logId !== ref.i || (entry.t !== "tin" && entry.t !== "ten" && entry.t !== "tcl")) return fail(problem("badFields", "not a trail entry", ref.i, s));
  if (tin.body.ci !== kel.aid) return fail(problem("badFields", "trail controller mismatch", ref.i, s));
  const est = await checkKeyRefSig(entry, kel, opts);
  if ("code" in est) return { ok: false, entry, kel, controller, receipts: [], problems: [est] };
  const c = cutStatus(kel, ref.i, est, s);
  if ("cut" in c && c.cut) problems.push(problem("staleKeyState", `entry ${s} was cut by the rotation at KEL ${c.by}`, ref.i, s));
  if ("unsealed" in c) problems.push(problem("unsealedRotation", "the rotation after this entry's key state did not seal the trail", ref.i, s));
  const receipts: { witness: Qb64; dt: string }[] = [];
  for (const r of got.filter((m) => m.t === "trc" && m.s === s && m.d === entry.d)) {
    for (const cpl of r.couples ?? []) {
      if (est.witnesses.includes(cpl.signer) && !receipts.some((x) => x.witness === cpl.signer) && verifyCouple(cpl.signer, utf8(r.raw), cpl.sig))
        receipts.push({ witness: cpl.signer, dt: String(r.body.dt) });
    }
  }
  if (receipts.length < est.bt) problems.push(problem("notWitnessed", `${receipts.length} of ${est.bt} receipts`, ref.i, s));
  return { ok: problems.length === 0, entry, kel, controller, receipts, problems };
}

/** For a watcher or explorer: a trail's stream, and the KEL, from one source. */
export async function fetchTrail(trailId: Qb64, source: WitnessClient, opts: TrailVerifyOptions = {}): Promise<{ kel: KelResult; trail: TrailResult } | undefined> {
  const tin = fromStream(await source.query({ logId: trailId, from: 0, to: 0 })).messages.find((m) => m.t === "tin");
  if (!tin) return undefined;
  const kel = await verifyKel(await source.query({ logId: String(tin.body.ci) }), opts);
  const trail = await verifyTrail({ kel, stream: await source.query({ logId: trailId }) }, opts);
  return { kel, trail };
}

