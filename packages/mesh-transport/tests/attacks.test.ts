import { describe, expect, it } from "vitest";
import { regions } from "../src/airtime";
import { decodeFrame, encodeFrame } from "../src/frame";
import { encodePacket } from "../src/packet";
import { meshWorld, setting, wireOf } from "./helpers";

async function withMallory(names = ["a", "b"]) {
  const w = await meshWorld({ names, links: [["a", "b"]] });
  const mallory = w.medium.node("mallory", { setting: setting(), mtu: 250, budget: regions.none });
  await mallory.open();
  for (const n of names) w.medium.connect("mallory", n);
  return { ...w, mallory };
}

describe("attacks", () => {
  it("ignores a forged ACK: the sender keeps going until the real one", async () => {
    const w = await withMallory();
    const { a, b } = w.nodes;
    await w.sched.run(b.mesh.post(b.id.did, a.id.did, await wireOf(b.id, a.id.did, 20)));
    await w.sched.runUntilIdle({ maxMs: 60_000 });
    // Mallory drops b's ACKs and answers in its place with a made-up MAC.
    w.medium.inject({ kind: "drop", from: "b", match: (x) => decodeFrame(x)?.type === "ack", count: 1 });
    w.mallory.onFrame((f) => {
      const d = decodeFrame(f.bytes);
      if (d?.type === "data" && d.index === d.count - 1) {
        const forged = encodeFrame({ type: "ack", pid: d.pid, count: d.count, bitmap: Uint8Array.of(0xff >> (8 - d.count)), mac: Uint8Array.of(1, 2, 3, 4) });
        w.sched.setTimeout(() => void w.mallory.send(forged), 5);
      }
    });
    const wire = await wireOf(a.id, b.id.did, 450);
    expect(await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire))).toBe("live");
    expect(a.mesh.stats().dropped["ack-mac"]).toBeGreaterThanOrEqual(1);
    expect(a.mesh.stats().retries).toBeGreaterThanOrEqual(1);
    expect(b.inbox).toEqual([wire]);
  });

  it("drops a packet that claims 64 fragments and then stops, and survives a flood of junk INTROs", async () => {
    const w = await withMallory();
    const { a, b } = w.nodes;
    const pid = Uint8Array.of(9, 9, 9, 9);
    await w.sched.run(w.mallory.send(encodeFrame({ type: "data", pid, index: 0, count: 64, ttl: 0, hops: 0, attempt: 0, chunk: Uint8Array.of(2, 81) })));
    await w.sched.advance(60_000);
    expect(b.mesh.stats().dropped["incomplete"]).toBe(1);

    // 200 INTRO-shaped packets that open for nobody: fragment 0 of each, which every node tries and discards.
    for (let i = 0; i < 200; i++) {
      const junk = encodePacket({ kind: "intro", sealedSender: new Uint8Array(81).fill(i), enc: new Uint8Array(32).fill(i), ct: new Uint8Array(16), signature: new Uint8Array(64) });
      await w.sched.run(w.mallory.send(encodeFrame({ type: "data", pid: Uint8Array.of(i, 1, 2, 3), index: 0, count: 2, ttl: 0, hops: 0, attempt: 0, chunk: junk.subarray(0, 242) })));
    }
    await w.sched.advance(60_000);
    expect(b.inbox).toHaveLength(0);
    // Still works afterwards.
    const wire = await wireOf(a.id, b.id.did, 300);
    await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire));
    await w.sched.runUntilIdle({ maxMs: 3600_000 });
    expect(b.inbox).toEqual([wire]);
  });
});
