import { describe, expect, it } from "vitest";
import { nextKeyDigest } from "../src/cesr";
import { Controller } from "../src/controller";
import { fromCompact, fromCompactLog, toCompact, toCompactLog } from "../src/compact";
import { verifyKel } from "../src/kel";
import { coldKeysFromSeed } from "../src/keys";
import { MemoryStore } from "../src/store";
import { attachmentsOf, fromStream, toStream } from "../src/stream";
import { verifyTrail } from "../src/trail";
import { exportBundle } from "../src/verify";
import { Witness, localWitnessClient } from "../src/witness";
import { seedFrom, setup, signer } from "./helpers";
import type { SignedMessage } from "../src/types";

async function everything() {
  const s = setup("compact");
  const ws = [0, 1].map((i) => new Witness({ signer: signer(`cw/${i}`), store: new MemoryStore(), clock: s.clock }));
  const c = await Controller.incept({ hot: s.hot, cold: s.cold, witnesses: ws.map((w) => w.aid), bt: 2, store: s.store, clock: s.clock, data: { device: "camera" } });
  const t = await c.openTrail("agent/actions");
  await t.append({ kind: "agent/payment", body: { amount: "340.00" }, refs: [{ d: nextKeyDigest("terms") }] });
  await c.checkpointNow();
  await c.rotate();
  await t.append({ kind: "", body: { hidden: true } });
  await t.close();
  await c.publish(ws.map(localWitnessClient));
  const b = await exportBundle(s.store, c.aid);
  return { c, t, b, kel: fromStream(b.kel).messages, trail: fromStream(b.trails[0].stream).messages };
}

describe("compact form", () => {
  it("every message type round-trips to identical raw bytes and attachments", async () => {
    const { kel, trail } = await everything();
    const all = [...kel, ...trail];
    expect(new Set(all.map((m) => m.t))).toEqual(new Set(["icp", "rot", "ixn", "rct", "tin", "ten", "tcl", "trc"]));
    for (const m of all) {
      const back = fromCompact(toCompact(m));
      expect(back.raw).toBe(m.raw);
      expect(attachmentsOf(back)).toBe(attachmentsOf(m));
    }
  });

  it("a flipped bit in a header fails the SAID check", async () => {
    const { trail } = await everything();
    const ten = trail.find((m) => m.t === "ten")!;
    const bytes = toCompact(ten);
    let failures = 0;
    // flip bits in the header part: everything before the attachments
    const headerLen = bytes.length - toCompact({ ...ten, keyRefSig: undefined }).length;
    const end = bytes.length - headerLen;
    for (let i = 4; i < end; i++) {
      const copy = bytes.slice();
      copy[i] ^= 0x04;
      try {
        const m = fromCompact(copy);
        if (m.raw !== ten.raw) failures++; // rebuilt to different JSON: only possible if the SAID check passed
      } catch {
        failures++;
      }
    }
    expect(failures).toBe(end - 4);
  });

  it("sizes: a trail entry with its signature, and a receipt", async () => {
    const { trail } = await everything();
    const ten = trail.find((m) => m.t === "ten")!;
    const trc = trail.find((m) => m.t === "trc")!;
    const header = toCompact({ ...ten, keyRefSig: undefined }).length;
    const withSig = toCompact(ten).length;
    const receipt = toCompact(trc).length;
    const json = ten.raw.length + attachmentsOf(ten).length;
    console.log(`ten: JSON+CESR ${json} B, compact header ${header} B, with -F group ${withSig} B; trc with signature ${receipt} B (JSON+CESR ${trc.raw.length + attachmentsOf(trc).length} B)`);
    expect(header).toBeLessThan(210);
    expect(withSig).toBeLessThan(360);
    expect(receipt).toBeLessThan(200);
    expect(withSig).toBeLessThan(json * 0.65);
  });

  it("a device's KEL with witness receipts exports under 2 KB and verifies offline", async () => {
    const s = setup("device");
    const cold = coldKeysFromSeed(seedFrom("owner"), "device", { curve: "p256" });
    const ws = [0, 1].map((i) => new Witness({ signer: signer(`dw/${i}`), store: new MemoryStore(), clock: s.clock }));
    const c = await Controller.incept({ hot: cold.release(0, 1), cold, witnesses: ws.map((w) => w.aid), bt: 2, store: s.store, clock: s.clock, data: { messagingDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", keyClass: "B", device: "camera" } });
    for (let i = 0; i < 2; i++) await c.interact([{ d: nextKeyDigest(`batch ${i}`) }]);
    await c.rotate();
    await c.interact([{ d: nextKeyDigest("batch b") }]);
    await c.rotate();
    await c.publish(ws.map(localWitnessClient));
    const kel = await verifyKel(c.kelMessages());
    expect(kel.ok).toBe(true);
    const bytes = toCompactLog(kel.messages);
    const jsonSize = toStream(kel.messages).length;
    console.log(`device KEL: ${kel.messages.length} events (icp, 2 rot, 3 ixn), 2 witness receipts each: CESR ${jsonSize} B, compact log ${bytes.length} B`);
    expect(bytes.length).toBeLessThan(2048);
    const back = fromCompactLog(bytes);
    expect(toStream(back.messages)).toBe(toStream(kel.messages));
    const again = await verifyKel(back.messages);
    expect(again.ok).toBe(true);
    expect(again.latest).toEqual(kel.latest);
    // each further interaction event with two receipts costs about this much
    const more = await Controller.load(c.aid, { cold, store: s.store, clock: s.clock });
    await more.interact([{ d: nextKeyDigest("one more") }]);
    await more.publish(ws.map(localWitnessClient));
    const perIxn = toCompactLog((await verifyKel(more.kelMessages())).messages).length - bytes.length;
    console.log(`one more ixn with 2 receipts: ${perIxn} B`);
    expect(perIxn).toBeLessThan(260);
  });

  it("a trail exports as a compact log with its receipts", async () => {
    const { c, trail } = await everything();
    const msgs = trail.filter((m) => m.t !== "trc");
    const rcts = trail.filter((m) => m.t === "trc");
    const bytes = toCompactLog(msgs, rcts);
    const back = fromCompactLog(bytes);
    const kel = await verifyKel(c.kelMessages());
    const r = await verifyTrail({ kel, stream: [...back.messages, ...back.receipts] });
    expect(r.problems).toEqual([]);
    expect(r.entries.every((e) => e.status === "valid")).toBe(true);
    const flipped = bytes.slice();
    flipped[Math.floor(bytes.length / 3)] ^= 1;
    let detected = false;
    try {
      const b2 = fromCompactLog(flipped);
      const r2 = await verifyTrail({ kel, stream: [...b2.messages, ...b2.receipts] });
      detected = !r2.ok;
    } catch {
      detected = true;
    }
    expect(detected).toBe(true);
    void ([] as SignedMessage[]);
  });
});
