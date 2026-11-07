/**
 * Verifying sensor readings (design §12.5). For each seal: check its signature with the device's key,
 * find the reading whose hash is the head, and walk the links backwards. Each reading gets one status.
 * Gateways and the server carry frames but can't forge one: a changed reading no longer links.
 */
import { verifyCose1, type PublicKey } from "@toip-tools/cose";
import { ed25519 } from "@noble/curves/ed25519.js";
import { equal, hex, sha, utf8 } from "./bytes";
import { decodeFrame, type Reading, type Seal } from "./frames";

export type ReadingStatus = "verified" | "pending" | "unlinked" | "invalid" | "equivocation";

export interface DeviceKeys {
  id: string;
  dev: Uint8Array;
  /** The keys that may have signed seals: the current key and, around a rotation, earlier ones. */
  keys: PublicKey[];
}

export interface RoundInfo {
  round: number;
  randomness: Uint8Array;
  /** Unix ms when the round was published. */
  at: number;
}

export interface GatewayReceipt {
  gateway: string;
  /** Unix ms on the gateway's clock. */
  at: number;
  sig: Uint8Array;
}

export interface FrameIn {
  bytes: Uint8Array;
  /** Gateway receipts for this frame, if any. */
  receipts?: GatewayReceipt[];
  meta?: { rssi?: number; snr?: number; link?: string; at?: number };
}

export interface ReadingResult {
  seq: number;
  status: ReadingStatus;
  reading: Reading;
  bytesHex: string;
  /** The seal that verified it. */
  seal?: { firstSeq: number; lastSeq: number; hash: string };
  notBefore?: number;
  notAfter?: number;
  /** The device's own time is outside the provable interval (by more than 2 minutes). */
  clockWrong?: boolean;
  meta?: FrameIn["meta"];
}

export interface SealResult {
  firstSeq: number;
  lastSeq: number;
  hash: string;
  status: "valid" | "invalid";
  beacon?: { round: number; at?: number };
  notAfter?: number;
  receivedBy?: string;
  linked: number;
  meta?: FrameIn["meta"];
}

export interface DeviceReadings {
  id: string;
  readings: ReadingResult[];
  seals: SealResult[];
  equivocation: boolean;
  gaps: [number, number][];
}

export const gatewayReceiptMessage = (frame: Uint8Array, at: number) => utf8(`capture/gateway-receipt/v1|${hex(sha(frame))}|${at}`);

export function verifyGatewayReceipt(frame: Uint8Array, r: GatewayReceipt, gatewayKey: Uint8Array): boolean {
  try {
    return ed25519.verify(r.sig, gatewayReceiptMessage(frame, r.at), gatewayKey);
  } catch {
    return false;
  }
}

const SLACK = 2 * 60_000;

/**
 * What to ask a sensor to resend: gaps, unlinked readings, and readings left pending below a later valid
 * seal (their own seal was lost). Merged into at most `max` ranges, so one request covers a lot.
 */
export function backfillRanges(d: DeviceReadings, max = 4): [number, number][] {
  const lastSealed = Math.max(-1, ...d.seals.filter((s) => s.status === "valid").map((s) => s.lastSeq));
  const seqs = new Set<number>();
  for (const [a, b] of d.gaps) for (let s = a; s <= b && s <= lastSealed; s++) seqs.add(s);
  for (const r of d.readings) if (r.status === "unlinked" || (r.status === "pending" && r.seq <= lastSealed)) seqs.add(r.seq);
  const sorted = [...seqs].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const s of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = s;
    else ranges.push([s, s]);
  }
  while (ranges.length > max) {
    // merge the two ranges closest together
    let best = 0;
    for (let i = 1; i < ranges.length - 1; i++) if (ranges[i + 1][0] - ranges[i][1] < ranges[best + 1][0] - ranges[best][1]) best = i;
    ranges.splice(best, 2, [ranges[best][0], ranges[best + 1][1]]);
  }
  return ranges;
}

/**
 * `gateways` maps a gateway's id to its Ed25519 public key; receipts from others are ignored.
 * `rounds` are beacon rounds the caller has already verified (BLS), to resolve readings' beacon tags.
 */
export async function verifyReadings(frames: FrameIn[], ctx: { devices: DeviceKeys[]; rounds?: RoundInfo[]; gateways?: Record<string, Uint8Array> }): Promise<Map<string, DeviceReadings>> {
  // readings by dev tag, then seq, then exact bytes (duplicates merge)
  const readings = new Map<string, Map<number, Map<string, { reading: Reading; body: Uint8Array; meta?: FrameIn["meta"] }>>>();
  const seals: { seal: Seal; cose: Uint8Array; frame: Uint8Array; receipts: GatewayReceipt[]; meta?: FrameIn["meta"] }[] = [];
  const sealSeen = new Set<string>();
  for (const f of frames) {
    let fr;
    try {
      fr = decodeFrame(f.bytes);
    } catch {
      continue;
    }
    if (fr.type === 1) {
      const tag = hex(fr.reading.dev);
      const bySeq = readings.get(tag) ?? readings.set(tag, new Map()).get(tag)!;
      const variants = bySeq.get(fr.reading.seq) ?? bySeq.set(fr.reading.seq, new Map()).get(fr.reading.seq)!;
      const k = hex(fr.body);
      if (!variants.has(k)) variants.set(k, { reading: fr.reading, body: fr.body, meta: f.meta });
    } else if (fr.type === 2) {
      const k = hex(f.bytes);
      if (sealSeen.has(k)) {
        const have = seals.find((s) => hex(s.frame) === k);
        if (have && f.receipts) have.receipts.push(...f.receipts);
        continue;
      }
      sealSeen.add(k);
      seals.push({ seal: fr.seal, cose: fr.cose, frame: f.bytes, receipts: [...(f.receipts ?? [])], meta: f.meta });
    }
  }

  const out = new Map<string, DeviceReadings>();
  // which device signed each seal: the signature settles a dev collision
  const sealOwner = new Map<number, string>();
  for (const [i, s] of seals.entries()) {
    for (const d of ctx.devices) {
      if (!equal(d.dev, s.seal.dev)) continue;
      const v = await verifyCose1(s.cose, async () => d.keys, { allowedAlgs: [-19, -9, -8, -7] });
      if (v.ok) {
        sealOwner.set(i, d.id);
        break;
      }
    }
  }

  const roundFor = (tag: Uint8Array | undefined, maxRound?: number): RoundInfo | undefined => {
    if (!tag || !ctx.rounds) return undefined;
    let best: RoundInfo | undefined;
    for (const r of ctx.rounds) {
      if ((r.round & 255) !== tag[0] || r.randomness[0] !== tag[1] || r.randomness[1] !== tag[2]) continue;
      if (maxRound !== undefined && (r.round > maxRound || r.round < maxRound - 256 * 64)) continue;
      if (!best || r.round > best.round) best = r;
    }
    return best;
  };

  // reached[tag][seq] = set of body hex reached by each device's valid seals
  const reachedBy = new Map<string, Map<number, Map<string, string>>>();
  const walks: { d: DeviceKeys; tag: string; bySeq: Map<number, Map<string, { reading: Reading; body: Uint8Array; meta?: FrameIn["meta"] }>>; res: DeviceReadings; status: Map<string, ReadingResult> }[] = [];
  for (const d of ctx.devices) {
    const tag = hex(d.dev);
    const bySeq = readings.get(tag) ?? new Map();
    const res: DeviceReadings = { id: d.id, readings: [], seals: [], equivocation: false, gaps: [] };
    out.set(d.id, res);
    const status = new Map<string, ReadingResult>(); // key: seq|bodyHex
    for (const [i, s] of seals.entries()) {
      if (!equal(s.seal.dev, d.dev)) continue;
      const owner = sealOwner.get(i);
      if (owner && owner !== d.id) continue; // another device's seal
      const sealHash = hex(sha(s.frame));
      const valid = owner === d.id;
      const receipts = s.receipts.filter((r) => ctx.gateways?.[r.gateway] && verifyGatewayReceipt(s.frame, r, ctx.gateways[r.gateway]));
      const notAfter = receipts.length ? Math.min(...receipts.map((r) => r.at)) : undefined;
      const beaconRound = s.seal.beacon ? ctx.rounds?.find((r) => r.round === s.seal.beacon!.round && equal(r.randomness.subarray(0, 8), s.seal.beacon!.prefix)) : undefined;
      const sr: SealResult = {
        firstSeq: s.seal.firstSeq,
        lastSeq: s.seal.lastSeq,
        hash: sealHash,
        status: valid ? "valid" : "invalid",
        ...(s.seal.beacon ? { beacon: { round: s.seal.beacon.round, ...(beaconRound ? { at: beaconRound.at } : {}) } } : {}),
        ...(notAfter !== undefined ? { notAfter } : {}),
        ...(receipts[0] ? { receivedBy: receipts[0].gateway } : {}),
        linked: 0,
        meta: s.meta,
      };
      res.seals.push(sr);
      if (!valid) continue;
      // walk back from the head
      let expect: { full?: Uint8Array; link?: Uint8Array } = { full: s.seal.head };
      let broken: "missing" | "mismatch" | undefined;
      for (let seq = s.seal.lastSeq; seq >= s.seal.firstSeq; seq--) {
        const variants = bySeq.get(seq);
        if (broken || !variants) {
          broken ??= "missing";
          for (const [k, v] of variants ?? []) {
            const key = `${seq}|${k}`;
            if (!status.has(key)) status.set(key, { seq, status: "unlinked", reading: v.reading, bytesHex: k, meta: v.meta, seal: { firstSeq: s.seal.firstSeq, lastSeq: s.seal.lastSeq, hash: sealHash } });
          }
          continue;
        }
        let match: string | undefined;
        for (const [k, v] of variants) {
          const h = sha(v.body);
          if (expect.full ? equal(h, expect.full) : equal(h.subarray(0, 8), expect.link)) {
            match = k;
            expect = { link: v.reading.link };
            break;
          }
        }
        if (!match) {
          broken = "mismatch";
          for (const [k, v] of variants) {
            const key = `${seq}|${k}`;
            const prev = status.get(key);
            if (!prev || prev.status === "unlinked") status.set(key, { seq, status: "invalid", reading: v.reading, bytesHex: k, meta: v.meta });
          }
          continue;
        }
        const v = variants.get(match)!;
        const key = `${seq}|${match}`;
        const nb = roundFor(v.reading.beacon, s.seal.beacon?.round);
        const prev = status.get(key);
        const nbAt = nb?.at;
        const r: ReadingResult = {
          seq,
          status: "verified",
          reading: v.reading,
          bytesHex: match,
          meta: v.meta,
          seal: { firstSeq: s.seal.firstSeq, lastSeq: s.seal.lastSeq, hash: sealHash },
          ...(nbAt !== undefined ? { notBefore: nbAt } : {}),
          ...(notAfter !== undefined ? { notAfter: prev?.notAfter !== undefined ? Math.min(prev.notAfter, notAfter) : notAfter } : {}),
        };
        status.set(key, r);
        sr.linked++;
        const rb = reachedBy.get(tag) ?? reachedBy.set(tag, new Map()).get(tag)!;
        const at = rb.get(seq) ?? rb.set(seq, new Map()).get(seq)!;
        at.set(match, d.id);
      }
    }
    walks.push({ d, tag, bySeq, res, status });
  }

  // then classify, once every device's walks are known, so a dev collision is settled whatever the order
  for (const { d, tag, bySeq, res, status } of walks) {
    const theirs = (seq: number, k: string) => [...(reachedBy.get(tag)?.get(seq)?.entries() ?? [])].some(([kk, who]) => kk === k && who !== d.id);
    const mine = (seq: number, k: string) => reachedBy.get(tag)?.get(seq)?.get(k) === d.id;
    for (const [key, r] of [...status]) if (r.status !== "verified" && theirs(r.seq, r.bytesHex) && !mine(r.seq, r.bytesHex)) status.delete(key);
    // equivocation: two different verified readings at one seq
    const verifiedAt = new Map<number, string[]>();
    for (const [, r] of status) if (r.status === "verified") (verifiedAt.get(r.seq) ?? verifiedAt.set(r.seq, []).get(r.seq)!).push(r.bytesHex);
    for (const [seq, ks] of verifiedAt)
      if (ks.length > 1) {
        res.equivocation = true;
        for (const k of ks) status.get(`${seq}|${k}`)!.status = "equivocation";
      }
    // readings not touched by any seal of this device
    for (const [seq, variants] of bySeq)
      for (const [k, v] of variants) {
        const key = `${seq}|${k}`;
        if (status.has(key)) continue;
        // a variant at a seq this device verified with other bytes is a forgery, not pending
        const verifiedHere = verifiedAt.has(seq);
        // or it belongs to another device with the same tag
        if (theirs(seq, k)) continue;
        const coveredBy = res.seals.find((sr) => sr.status === "valid" && seq >= sr.firstSeq && seq <= sr.lastSeq);
        status.set(key, { seq, status: verifiedHere ? "invalid" : coveredBy ? "unlinked" : "pending", reading: v.reading, bytesHex: k, meta: v.meta });
      }
    for (const r of status.values()) {
      const t = r.reading.t * 1000;
      if ((r.notBefore !== undefined && t < r.notBefore - SLACK) || (r.notAfter !== undefined && t > r.notAfter + SLACK)) r.clockWrong = true;
    }
    res.readings = [...status.values()].sort((a, b) => a.seq - b.seq || a.bytesHex.localeCompare(b.bytesHex));
    const seqs = [...new Set(res.readings.map((r) => r.seq))].sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i++) if (seqs[i] > seqs[i - 1] + 1) res.gaps.push([seqs[i - 1] + 1, seqs[i] - 1]);
    res.seals.sort((a, b) => a.firstSeq - b.firstSeq);
  }
  return out;
}
