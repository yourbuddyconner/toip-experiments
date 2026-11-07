/**
 * The owner's side of a device's key log (design §7.4): the owner holds the device's next key (derived
 * from the owner's seed and the device's nonce), so a thief with the device can't rotate, and the owner can.
 */
import { attachmentsOf, coldKeysFromSeed, Controller, fromStream, keyQb64, MemoryStore, nextKeyDigest, type Signer, type SignedMessage, type WitnessClient } from "@zk-toip/eventlog";
import type { Clock } from "@zk-toip/trust-core";

/** The recovery keys an owner keeps for one device: set j signs the j-th rotation. */
export function recoveryKeys(ownerSeed: Uint8Array, deviceNonce: string) {
  const cold = coldKeysFromSeed(ownerSeed, `capture/recovery/v1|${deviceNonce}`);
  return {
    signer: (set: number): Signer => cold.release(set, 1)[0],
    digest: (set: number): string => nextKeyDigest(keyQb64(cold.release(set, 1)[0])),
  };
}

/** A store holding a log, from a CESR stream (a witness's copy). */
export async function storeFromStream(stream: string, clock: Clock): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (const m of fromStream(stream).messages) {
    if (m.t === "rct" || m.t === "trc") continue;
    await store.put({ logId: m.logId, s: m.s, d: m.d, t: m.t, raw: m.raw, attachments: attachmentsOf({ ...m, witnessSigs: undefined }), fn: 0, seenAt: clock.iso(), local: false });
  }
  return store;
}

/**
 * The owner rotates a device's key log with its recovery key. With `newKey`, the device's new capture key
 * takes over in a second rotation it signs itself (so the owner never holds a capture key); without it the
 * old key is simply retired and the owner's recovery key holds the log until a new device is enrolled.
 */
export async function ownerRotate(opts: {
  aid: string;
  stream: string;
  recovery: Signer;
  /** What the rotation commits to next: the owner's next recovery key, or a new device's capture key (it then rotates itself in). */
  nextRecovery: string;
  clock: Clock;
  witnesses: WitnessClient[];
}): Promise<{ rot: SignedMessage; controller: Controller }> {
  const store = await storeFromStream(opts.stream, opts.clock);
  const c = await Controller.load(opts.aid, { hot: [], store, clock: opts.clock });
  const rot = await c.rotate({ exposed: [opts.recovery], next: [opts.nextRecovery] });
  const report = await c.publish(opts.witnesses);
  if (report.missing.length && report.missing.length >= opts.witnesses.length) throw new Error(`no witness took the rotation: ${report.missing.map((m) => m.error).join("; ")}`);
  return { rot, controller: c };
}
