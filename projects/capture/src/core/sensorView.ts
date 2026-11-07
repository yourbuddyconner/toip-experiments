/**
 * The sensor dashboard's checks, run in the browser: beacon rounds (BLS), device keys (key logs),
 * installation credentials, gateway receipts, and every reading chain. The server only carries frames.
 */
import { keyAt, type KelResult } from "@zk-toip/eventlog";
import type { Credential } from "@zk-toip/trust-core";
import { verifyCredential } from "@zk-toip/trust-core";
import { fromB64, fromHex } from "./bytes";
import { randomnessOf, roundTime, verifyRounds, type DrandChain } from "./drand";
import { devTag } from "./frames";
import { isKelResult, readKeyLog } from "./keylog";
import { verifyReadings, type DeviceReadings, type FrameIn } from "./readings";
import type { TrustEntry, Installation } from "./credentials";

export interface FeedSensor {
  did: string;
  aid: string;
  label: string;
  node?: string;
  installation?: Installation;
  credentials: Credential[];
}

export interface FeedFrame {
  type: number;
  frame: string;
  receipt: { gateway: string; at: number; sig: string };
  meta: { rssi?: number; snr?: number; link: string; at: number };
}

export interface SensorCheck {
  sensor: FeedSensor;
  readings: DeviceReadings;
  keyLog: "ok" | "invalid" | "missing";
  installation?: { credential: Credential; ok: boolean; trusted: boolean };
  owner?: { name: string; trusted: boolean };
  rotated: boolean;
}

/** Keys that may have signed seals: the current key and the one before, around a rotation. */
function sealKeys(kel: KelResult) {
  const states = kel.states.slice(-2);
  return states.flatMap((s) => keyAt(kel, s.estSn).map((k) => ({ curve: k.curve, bytes: k.bytes })));
}

export async function verifySensorFeed(
  feed: { sensors: FeedSensor[]; frames: FeedFrame[]; rounds: { kind: string; round: number; signature: string }[]; gateway: { id: string; publicKey: string } },
  ctx: { chains: DrandChain[]; keyLog: (did: string) => Promise<Uint8Array | null>; trust: TrustEntry[]; now: number },
): Promise<SensorCheck[]> {
  // beacon rounds: checked in one batch per chain
  const rounds: { round: number; randomness: Uint8Array; at: number }[] = [];
  for (const chain of ctx.chains) {
    const mine = feed.rounds.filter((r) => r.kind === chain.kind).map((r) => ({ round: r.round, signature: fromHex(r.signature) }));
    const ok = verifyRounds(chain, mine);
    mine.forEach((r, i) => ok[i] && rounds.push({ round: r.round, randomness: randomnessOf(r.signature), at: roundTime(chain, r.round) }));
  }
  const frames: FrameIn[] = feed.frames.map((f) => ({ bytes: fromB64(f.frame), receipts: [{ gateway: f.receipt.gateway, at: f.receipt.at, sig: fromB64(f.receipt.sig) }], meta: f.meta }));
  const devices = [];
  const kels = new Map<string, KelResult | null>();
  for (const s of feed.sensors) {
    const bytes = await ctx.keyLog(s.did).catch(() => null);
    const kel = bytes ? await readKeyLog(bytes) : null;
    const good = kel && isKelResult(kel) && kel.ok ? kel : null;
    kels.set(s.did, good);
    if (good) devices.push({ id: s.did, dev: devTag(s.did), keys: sealKeys(good) });
  }
  const results = await verifyReadings(frames, { devices, rounds, gateways: { [feed.gateway.id]: fromHex(feed.gateway.publicKey) } });
  const fixed = { now: () => ctx.now, iso: () => new Date(ctx.now).toISOString(), date: () => new Date(ctx.now) };
  const out: SensorCheck[] = [];
  for (const s of feed.sensors) {
    const kel = kels.get(s.did);
    const instVc = s.credentials.find((c) => c.type.includes("SensorInstallationCredential") && c.credentialSubject.id === s.did);
    const ownerVc = s.credentials.find((c) => c.type.includes("DeviceOwnerCredential") && c.credentialSubject.id === s.did);
    const inst = instVc ? { credential: instVc, ok: (await verifyCredential(instVc, fixed)).ok, trusted: ctx.trust.some((t) => t.did === instVc.issuer && t.trustedFor.includes("installer")) } : undefined;
    const owner = ownerVc && (await verifyCredential(ownerVc, fixed)).ok ? { name: String(ownerVc.credentialSubject.ownerName ?? ""), trusted: ctx.trust.some((t) => t.did === ownerVc.issuer && t.trustedFor.includes("owner")) } : undefined;
    out.push({
      sensor: s,
      readings: results.get(s.did) ?? { id: s.did, readings: [], seals: [], equivocation: false, gaps: [] },
      keyLog: kel ? "ok" : kel === null && (await ctx.keyLog(s.did).catch(() => null)) ? "invalid" : "missing",
      ...(inst ? { installation: inst } : {}),
      ...(owner ? { owner } : {}),
      rotated: !!kel && kel.states.length > 1,
    });
  }
  return out;
}
