/**
 * Device key logs (design §7.3), on @toip-tools/eventlog: compact export for stores, offline verification,
 * and the witness-receipt time bounds that give "not after".
 */
import { aidDid, aidOfDid, fromCompactLog, fromStream, toCompactLog, verifyKel, type KelResult, type SignedMessage } from "@toip-tools/eventlog";

export { digestSeal as digestSealOf } from "@toip-tools/eventlog";

/** A key log's compact form from a CESR stream (a witness's or a controller's), timed receipts included. */
export async function compactFromStream(stream: string): Promise<{ bytes: Uint8Array; kel: KelResult }> {
  const kel = await verifyKel(stream, { allowUnwitnessed: true });
  const trc = fromStream(stream).messages.filter((m) => m.t === "trc" && m.logId === kel.aid);
  return { bytes: toCompactLog(kel.messages, trc), kel };
}

export function compactFromMessages(messages: SignedMessage[], receipts: SignedMessage[]): Uint8Array {
  return toCompactLog(messages, receipts.filter((m) => m.t === "trc"));
}

/** Verifies a compact key log offline, requiring the witness threshold on every event. */
export async function readKeyLog(bytes: Uint8Array, opts: { allowUnwitnessed?: boolean } = {}): Promise<KelResult | { error: string }> {
  try {
    const { messages, receipts } = fromCompactLog(bytes);
    return await verifyKel([...messages, ...receipts], { allowUnwitnessed: opts.allowUnwitnessed ?? false });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const deviceDid = (aid: string) => aidDid(aid);
export const deviceAid = (did: string) => aidOfDid(did);
export const isDeviceDid = (did: string) => did.startsWith("did:keri:");

/**
 * The time by which a threshold of the event's witnesses say they had it: the bt-th earliest timed receipt
 * from a witness in the event's witness list. Undefined when too few witnesses gave a time.
 */
export function witnessedBy(kel: KelResult, sn: number): { at: number; witnesses: number; of: number } | undefined {
  const ev = kel.events.find((e) => e.s === sn && e.status === "valid");
  if (!ev) return undefined;
  const state = [...kel.states].reverse().find((s) => s.estSn <= sn) ?? kel.states[0];
  const times = ev.receiptTimes
    .filter((r) => state.witnesses.includes(r.witness))
    .map((r) => Date.parse(r.dt))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  const need = Math.max(1, state.bt);
  if (times.length < need) return undefined;
  return { at: times[need - 1], witnesses: times.length, of: state.witnesses.length };
}

/** The inception's data field: messaging DID, key class, device kind. */
export function deviceData(kel: KelResult): Record<string, unknown> {
  const icp = kel.messages[0];
  const a = (icp?.body.a as unknown[]) ?? [];
  for (const x of a) if (x && typeof x === "object" && !("d" in (x as object))) return x as Record<string, unknown>;
  return {};
}

export function isKelResult(x: KelResult | { error: string }): x is KelResult {
  return !("error" in x);
}
