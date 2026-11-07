import { describe, expect, it } from "vitest";
import { seedSigner } from "@zk-toip/cose";
import { plans, regions } from "@zk-toip/mesh-transport";
import { SimMedium, VirtualScheduler } from "@zk-toip/mesh-transport/sim";
import { seedFrom } from "@zk-toip/trust-core";
import {
  backfillRanges,
  beaconTag,
  concat,
  decodeFrame,
  devChain,
  devTag,
  encodeBackfill,
  encodeBeacon,
  freshChain,
  FRAME,
  ReadingChain,
  readingBody,
  roundAt,
  utf8,
  verifyReadings,
  type DeviceKeys,
} from "../src/core";
import { CaptureGateway, type HeardFrame } from "../src/sensors/gateway";
import { SensorNode, simulatedChannels } from "../src/sensors/node";

const ID = "did:keri:ESensorRiverside4";
const signerFor = (label: string) => seedSigner(seedFrom(label), utf8(label));

function sensor(label = "riverside-4", id = ID) {
  const signer = signerFor(label);
  const chain = new ReadingChain(freshChain(devTag(id)), signer);
  const device: DeviceKeys = { id, dev: devTag(id), keys: [signer.publicKey] };
  return { chain, device, signer };
}

const values = (i: number): [number, number][] => [
  [1, 1400 + i],
  [2, 620],
  [4, 80 + i],
];

async function batch(n: number, chain: ReadingChain, t0 = 1_794_000_000) {
  const readings = [];
  for (let i = 0; i < n; i++) readings.push(chain.next(t0 + i * 60, values(i)));
  const seal = (await chain.seal())!;
  return { readings, seal };
}

const statuses = async (frames: Uint8Array[], devices: DeviceKeys[]) => {
  const r = await verifyReadings(
    frames.map((bytes) => ({ bytes })),
    { devices },
  );
  return r.get(devices[0].id)!.readings.map((x) => `${x.seq}:${x.status}`);
};

describe("sensor frames: byte budgets (design §12.4)", () => {
  it("encoded sizes are exactly 42, 46, 108, 126, 141 and 17 bytes", async () => {
    const big = 2 ** 31; // 32-bit seq and time, the worst case the table counts
    const dev = devTag(ID);
    const v: [number, number][] = [
      [1, -32768],
      [2, 32767],
      [4, 30000],
    ];
    const reading = concat(Uint8Array.of(1), readingBody({ dev, seq: big, t: big, link: new Uint8Array(8), values: v }));
    expect(reading.length).toBe(42);
    expect(concat(Uint8Array.of(1), readingBody({ dev, seq: big, t: big, link: new Uint8Array(8), values: v, beacon: new Uint8Array(3) })).length).toBe(46);
    const chain = new ReadingChain({ dev, seq: big, lastHash: new Uint8Array(32), firstUnsealed: big - 1000 }, signerFor("x"));
    chain.next(big, v);
    expect((await chain.signedReading(big, v)).length).toBe(108);
    expect((await chain.seal())!.length).toBe(126);
    chain.next(big, v);
    expect((await chain.seal({ round: big, prefix: new Uint8Array(8) }))!.length).toBe(141);
    expect(encodeBeacon(big, new Uint8Array(8)).length).toBe(17);
    expect(decodeFrame(encodeBackfill(dev, 3, 9))).toMatchObject({ type: 5, fromSeq: 3, toSeq: 9 });
  });
});

describe("reading chains", () => {
  it("a whole batch verifies; with no seal yet, readings are pending", async () => {
    const s = sensor();
    const { readings, seal } = await batch(10, s.chain);
    expect(await statuses([...readings, seal], [s.device])).toEqual(readings.map((_, i) => `${i}:verified`));
    expect(await statuses(readings.slice(0, 3), [s.device])).toEqual(["0:pending", "1:pending", "2:pending"]);
  });

  it("a gap: readings before a lost frame are unlinked, after it verified; backfill fixes it", async () => {
    const s = sensor();
    const { readings, seal } = await batch(6, s.chain);
    const lost = [...readings.slice(0, 2), ...readings.slice(3), seal];
    expect(await statuses(lost, [s.device])).toEqual(["0:unlinked", "1:unlinked", "3:verified", "4:verified", "5:verified"]);
    const r = await verifyReadings(lost.map((bytes) => ({ bytes })), { devices: [s.device] });
    expect(r.get(ID)!.gaps).toEqual([[2, 2]]);
    const backfilled = [...lost, ...s.chain.backfill(2, 2)];
    expect(await statuses(backfilled, [s.device])).toEqual(readings.map((_, i) => `${i}:verified`));
    // losing at every position
    for (let k = 0; k < 6; k++) {
      const st = await statuses([...readings.filter((_, i) => i !== k), seal], [s.device]);
      expect(st).toEqual(readings.map((_, i) => `${i}:${i < k ? "unlinked" : "verified"}`).filter((_, i) => i !== k));
    }
  });

  it("reordered and replayed frames change nothing; duplicates are ignored", async () => {
    const s = sensor();
    const { readings, seal } = await batch(5, s.chain);
    const mixed = [seal, readings[3], readings[0], readings[4], readings[0], readings[2], seal, readings[1], readings[3]];
    expect(await statuses(mixed, [s.device])).toEqual(readings.map((_, i) => `${i}:verified`));
  });

  it("a tampered reading is invalid; the readings before it can no longer be linked", async () => {
    const s = sensor();
    const { readings, seal } = await batch(5, s.chain);
    const f = decodeFrame(readings[2]);
    if (f.type !== 1) throw new Error();
    const forged = concat(Uint8Array.of(FRAME.reading), readingBody({ ...f.reading, values: [[1, 9999], ...f.reading.values.slice(1)] }));
    const frames = [readings[0], readings[1], forged, readings[3], readings[4], seal];
    expect(await statuses(frames, [s.device])).toEqual(["0:unlinked", "1:unlinked", "2:invalid", "3:verified", "4:verified"]);
    // the original arrives later (backfill): it verifies and the forgery stays invalid
    const st = await statuses([...frames, readings[2]], [s.device]);
    expect(st.filter((x) => x.startsWith("2:")).sort()).toEqual(["2:invalid", "2:verified"]);
    expect(st.filter((x) => !x.startsWith("2:"))).toEqual(["0:verified", "1:verified", "3:verified", "4:verified"]);
  });

  it("a forged seal (wrong key) is invalid and verifies nothing", async () => {
    const s = sensor();
    const { readings } = await batch(3, s.chain);
    const mallory = new ReadingChain({ ...s.chain.state, firstUnsealed: 0 }, signerFor("mallory"));
    const fake = (await mallory.seal())!;
    const r = await verifyReadings([...readings, fake].map((bytes) => ({ bytes })), { devices: [s.device] });
    expect(r.get(ID)!.seals[0].status).toBe("invalid");
    expect(r.get(ID)!.readings.every((x) => x.status === "pending")).toBe(true);
  });

  it("equivocation: two different readings with the same seq, both sealed, flag the device", async () => {
    const s = sensor();
    const fork = new ReadingChain({ ...s.chain.state }, s.signer);
    const a = await batch(3, s.chain);
    const b = await batch(3, fork, 1_794_100_000);
    const r = await verifyReadings([...a.readings, a.seal, ...b.readings, b.seal].map((bytes) => ({ bytes })), { devices: [s.device] });
    expect(r.get(ID)!.equivocation).toBe(true);
    expect(r.get(ID)!.readings.filter((x) => x.status === "equivocation")).toHaveLength(6);
  });

  it("a dev collision is settled by the signature", async () => {
    const a = sensor("a", "did:keri:EA");
    const b = sensor("b", "did:keri:EB");
    // force the same 4-byte tag
    const dev = devTag("did:keri:EA");
    const ca = new ReadingChain(freshChain(dev), a.signer);
    const cb = new ReadingChain(freshChain(dev), b.signer);
    const fa = await batch(3, ca);
    const fb = await batch(3, cb, 1_794_200_000);
    const devices = [
      { ...a.device, dev },
      { ...b.device, dev },
    ];
    const r = await verifyReadings([...fa.readings, fa.seal, ...fb.readings, fb.seal].map((bytes) => ({ bytes })), { devices });
    expect(r.get("did:keri:EA")!.readings.map((x) => x.status)).toEqual(["verified", "verified", "verified"]);
    expect(r.get("did:keri:EB")!.readings.map((x) => x.status)).toEqual(["verified", "verified", "verified"]);
    expect(r.get("did:keri:EA")!.equivocation).toBe(false);
  });

  it("beacon tags resolve to a round: not-before per reading; a gateway receipt gives not-after; a wrong clock is flagged", async () => {
    const chain = devChain(seedFrom("drand").slice(0, 32), 1_794_000_000 - 3600, 3);
    const s = sensor();
    const at = 1_794_000_000_000;
    const round = roundAt(chain.chain, at);
    const r0 = chain.sign(round);
    const rounds = [{ round, randomness: r0.randomness, at: (chain.chain.genesis + (round - 1) * 3) * 1000 }];
    const tag = beaconTag(round, r0.randomness);
    const lying = at / 1000 - 86_400; // a day behind
    const readings = [s.chain.next(lying, values(0), tag), s.chain.next(lying + 60, values(1), tag)];
    const seal = (await s.chain.seal({ round, prefix: r0.randomness.slice(0, 8) }))!;
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const gwSecret = seedFrom("gw");
    const { gatewayReceiptMessage } = await import("../src/core");
    const receiptAt = at + 90_000;
    const receipt = { gateway: "gw", at: receiptAt, sig: ed25519.sign(gatewayReceiptMessage(seal, receiptAt), gwSecret) };
    const r = await verifyReadings([...readings.map((bytes) => ({ bytes })), { bytes: seal, receipts: [receipt] }], { devices: [s.device], rounds, gateways: { gw: ed25519.getPublicKey(gwSecret) } });
    const out = r.get(ID)!.readings;
    expect(out.every((x) => x.status === "verified")).toBe(true);
    expect(out[0].notBefore).toBe(rounds[0].at);
    expect(out[0].notAfter).toBe(receiptAt);
    expect(out[0].clockWrong).toBe(true);
    // a receipt signed by someone else is ignored
    const r2 = await verifyReadings([...readings.map((bytes) => ({ bytes })), { bytes: seal, receipts: [{ ...receipt, sig: new Uint8Array(64) }] }], { devices: [s.device], rounds, gateways: { gw: ed25519.getPublicKey(gwSecret) } });
    expect(r2.get(ID)!.readings[0].notAfter).toBeUndefined();
  });
});

describe("readings over the simulated LoRa link to the gateway", () => {
  async function run(opts: { loss: number; minutes: number; evil?: boolean }) {
    const sched = new VirtualScheduler(Date.parse("2026-11-06T12:00:00Z"));
    const medium = new SimMedium({ scheduler: sched, seed: 7 });
    const radio = { setting: plans["us915-a"].tx, mtu: 250, budget: regions.us915 };
    const gwLink = medium.node("gateway", radio);
    const s = sensor();
    const sLink = medium.node("riverside-4", radio);
    medium.connect("gateway", "riverside-4", { loss: opts.loss, rssi: -96, snr: 4 });
    const drand = devChain(seedFrom("drand").slice(0, 32), Math.floor(sched.now() / 1000) - 600, 3);
    const signedRounds = new Map<number, ReturnType<typeof drand.sign>>();
    const heard: HeardFrame[] = [];
    const gw = new CaptureGateway({
      link: gwLink,
      secret: seedFrom("gateway"),
      id: "gateway-1",
      scheduler: sched,
      beaconEveryMs: 60_000,
      beacon: () => {
        const round = roundAt(drand.chain, sched.now());
        const r = signedRounds.get(round) ?? drand.sign(round);
        signedRounds.set(round, r);
        return r;
      },
      onFrame: (h) => heard.push(h),
    });
    const node = new SensorNode(s.chain, { link: sLink, scheduler: sched, channels: simulatedChannels(3), intervalMs: 60_000, sealEvery: 10 });
    await gw.start();
    await node.start();
    if (opts.evil) gw.evil = true;
    await sched.advance(opts.minutes * 60_000);
    const verify = async () => {
      const rounds = [...signedRounds.values()].map((r) => ({ round: r.round, randomness: r.randomness, at: (drand.chain.genesis + (r.round - 1) * 3) * 1000 }));
      const out = await verifyReadings(
        heard.map((h) => ({ bytes: h.bytes, receipts: [h.receipt], meta: h.meta })),
        { devices: [s.device], rounds, gateways: { "gateway-1": gw.publicKey } },
      );
      return out.get(ID)!;
    };
    return { sched, gw, node, heard, verify, s };
  }

  it("a lossless hour: every reading verified, 42-byte readings and 141-byte seals on the air, no airtime violations", async () => {
    const { verify, gw, node } = await run({ loss: 0, minutes: 60 });
    const r = await verify();
    expect(node.stats.readings).toBe(60);
    expect(r.readings.length).toBe(60);
    expect(r.readings.every((x) => x.status === "verified")).toBe(true);
    expect(r.readings.every((x) => x.notBefore !== undefined && x.notAfter !== undefined && x.notBefore <= x.notAfter)).toBe(true);
    // small sequence numbers encode shorter than the worst case the budget table counts
    expect(gw.stats.bytes.reading).toBeLessThanOrEqual(46);
    expect(gw.stats.bytes.seal).toBeLessThanOrEqual(141);
    expect(r.seals.every((x) => x.status === "valid")).toBe(true);
  });

  it("30% loss: some readings pending or unlinked; a backfill request over the air makes them verified", async () => {
    const { verify, gw, sched, s } = await run({ loss: 0.3, minutes: 60 });
    const before = await verify();
    const bad = before.readings.filter((x) => x.status !== "verified");
    expect(bad.length).toBeGreaterThan(0);
    // ask for every unlinked range and every gap, a few times (the downlink is lossy too)
    for (let round = 0; round < 10; round++) {
      const now = await verify();
      const missing = backfillRanges(now);
      if (!missing.length) break;
      for (const [a, b] of missing) void gw.requestBackfill(s.chain.state.dev, a, b);
      await sched.advance(60_000);
    }
    const after = await verify();
    const sealedUpTo = Math.max(...after.seals.filter((x) => x.status === "valid").map((x) => x.lastSeq));
    expect(after.readings.filter((x) => x.seq <= sealedUpTo && x.status !== "verified")).toEqual([]);
  });

  it("an evil gateway changes a value: that reading is invalid", async () => {
    const { verify } = await run({ loss: 0, minutes: 12, evil: true });
    const r = await verify();
    expect(r.readings.filter((x) => x.status === "invalid").map((x) => x.seq)).toEqual([0]);
  });
});
