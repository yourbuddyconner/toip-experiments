import { describe, expect, it } from "vitest";
import { loraAirtimeMs, regions, type LoRaSetting } from "../src/airtime";
import { VirtualScheduler } from "../src/scheduler";
import { RegulatoryViolation, SimMedium, type SimRadioParams } from "../src/sim";
import type { ReceivedFrame } from "../src/link";

const S = (frequencyHz = 904_600_000, sf: LoRaSetting["spreadingFactor"] = 8, bw: LoRaSetting["bandwidthHz"] = 500000): LoRaSetting => ({
  frequencyHz, spreadingFactor: sf, bandwidthHz: bw, codingRate: 5, preambleSymbols: 8, syncWord: "public", invertIq: false, txPowerDbm: 20,
});
const radio = (over: Partial<SimRadioParams> = {}): SimRadioParams => ({ setting: S(), mtu: 250, budget: regions.none, ...over });

async function world(names: string[], params: SimRadioParams = radio(), seed = 1) {
  const sched = new VirtualScheduler();
  const medium = new SimMedium({ scheduler: sched, seed });
  const got: Record<string, ReceivedFrame[]> = {};
  const links = Object.fromEntries(names.map((n) => [n, medium.node(n, params)]));
  for (const n of names) {
    got[n] = [];
    links[n].onFrame((f) => got[n].push(f));
    await links[n].open();
  }
  return { sched, medium, links, got };
}
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);

describe("VirtualScheduler", () => {
  it("runs timers in time order and jumps the clock between them", async () => {
    const s = new VirtualScheduler(1000);
    const seen: string[] = [];
    s.setTimeout(() => seen.push(`b@${s.now()}`), 200);
    s.setTimeout(() => seen.push(`a@${s.now()}`), 100);
    const h = s.setTimeout(() => seen.push("never"), 150);
    s.clearTimeout(h);
    await s.advance(150);
    expect(seen).toEqual(["a@1100"]);
    await s.runUntilIdle();
    expect(seen).toEqual(["a@1100", "b@1200"]);
    expect(s.iso()).toBe(new Date(1200).toISOString());
  });

  it("advances virtual time until a promise settles", async () => {
    const s = new VirtualScheduler(0);
    const p = new Promise<number>((resolve) => s.setTimeout(() => resolve(s.now()), 3_600_000));
    expect(await s.run(p)).toBe(3_600_000);
    await expect(s.run(new Promise(() => {}), { realIdleMs: 20 })).rejects.toThrow(/idle/);
  });

  it("freezes virtual time while held real I/O is out", async () => {
    const s = new VirtualScheduler(0);
    const seen: string[] = [];
    // A sender's timeout, 5 virtual seconds away.
    s.setTimeout(() => seen.push(`timeout@${s.now()}`), 5000);
    // Real I/O (30 real ms) that answers 10 virtual ms after it returns.
    const io = s.hold(new Promise<void>((r) => setTimeout(r, 30))).then(() => s.setTimeout(() => seen.push(`answer@${s.now()}`), 10));
    expect(s.holding()).toBe(true);
    await s.runUntilIdle();
    await io;
    expect(seen).toEqual(["answer@10", "timeout@5000"]);
    expect(s.holding()).toBe(false);

    // The same under run() and advance().
    const t = new VirtualScheduler(0);
    const order: string[] = [];
    t.setTimeout(() => order.push("late"), 1000);
    const answer = t.hold(new Promise<string>((r) => setTimeout(() => r("io"), 20))).then((v) => (order.push(v), v));
    expect(await t.run(answer)).toBe("io");
    await t.advance(2000);
    expect(order).toEqual(["io", "late"]);
  });
});

describe("SimMedium", () => {
  it("delivers a frame after its airtime to nodes in range, not to others", async () => {
    const { sched, medium, links, got } = await world(["a", "b", "c"]);
    medium.connect("a", "b");
    const t0 = sched.now();
    await sched.run(links.a.send(bytes(250)));
    expect(sched.now() - t0).toBeCloseTo(loraAirtimeMs(250, S()), 2);
    expect(got.b).toHaveLength(1);
    expect(got.b[0].bytes).toEqual(bytes(250));
    expect(got.c).toHaveLength(0);
    expect(medium.records()[0].results).toEqual([{ to: "b", ok: true }]);
  });

  it("is half-duplex: a node transmitting hears nothing", async () => {
    const { sched, medium, links, got } = await world(["a", "b"]);
    medium.connect("a", "b");
    await sched.run(Promise.all([links.a.send(bytes(250)), links.b.send(bytes(40))]));
    expect(got.a).toHaveLength(0);
    expect(got.b).toHaveLength(0);
    expect(medium.records().find((r) => r.from === "a")!.results[0]).toEqual({ to: "b", ok: false, reason: "half-duplex" });
  });

  it("loses overlapping frames at a receiver, unless one is 6 dB stronger (hidden terminals, capture)", async () => {
    const { sched, medium, links, got } = await world(["a", "b", "c"]);
    medium.connect("a", "b", { rssi: -80 });
    medium.connect("c", "b", { rssi: -82 });
    await sched.run(Promise.all([links.a.send(bytes(100, 1)), links.c.send(bytes(100, 2))]));
    expect(got.b).toHaveLength(0);
    medium.connect("c", "b", { rssi: -100 });
    await sched.run(Promise.all([links.a.send(bytes(100, 1)), links.c.send(bytes(100, 2))]));
    expect(got.b.map((f) => f.bytes[0])).toEqual([1]);
  });

  it("models a gateway: several receive settings at once, never hearing itself, others tuned elsewhere", async () => {
    const sched = new VirtualScheduler();
    const medium = new SimMedium({ scheduler: sched, seed: 1 });
    const up = S(904_600_000);
    const down = S(923_300_000);
    const gw = medium.node("gw", { setting: { tx: down, rx: [up, S(903_900_000, 7, 125000)] }, mtu: 250, budget: regions.none });
    const n1 = medium.node("n1", { setting: { tx: up, rx: [down] }, mtu: 250, budget: regions.none });
    const n2 = medium.node("n2", { setting: { tx: S(903_900_000, 7, 125000), rx: [down] }, mtu: 250, budget: regions.none });
    const heard: Record<string, number> = { gw: 0, n1: 0, n2: 0 };
    for (const [n, l] of Object.entries({ gw, n1, n2 })) {
      l.onFrame(() => heard[n]++);
      await l.open();
    }
    for (const a of ["gw", "n1", "n2"]) for (const b of ["gw", "n1", "n2"]) if (a < b) medium.connect(a, b);
    await sched.run(n1.send(bytes(50)));
    await sched.run(n2.send(bytes(50)));
    expect(heard).toEqual({ gw: 2, n1: 0, n2: 0 });
    await sched.run(gw.send(bytes(50)));
    expect(heard).toEqual({ gw: 2, n1: 1, n2: 1 });
  });

  it("enforces the per-frame dwell cap and the airtime budget, and the MTU", async () => {
    const { sched, links } = await world(["a"], radio({ setting: S(904_600_000, 10, 500000), budget: regions.us915 }));
    await expect(links.a.send(bytes(250))).rejects.toBeInstanceOf(RegulatoryViolation);
    await sched.run(links.a.send(bytes(170)));
    const w2 = await world(["a"], radio({ budget: { windowMs: 10_000, maxFraction: 0.05 } }));
    await w2.sched.run(w2.links.a.send(bytes(250)));
    await w2.sched.run(w2.links.a.send(bytes(250)));
    await expect(w2.links.a.send(bytes(250))).rejects.toBeInstanceOf(RegulatoryViolation);
    await w2.sched.advance(10_000);
    await w2.sched.run(w2.links.a.send(bytes(250)));
    await expect(w2.links.a.send(bytes(251))).rejects.toThrow(/MTU/);
  });

  it("injects faults: drops, duplicates, reordering and corruption", async () => {
    const { sched, medium, links, got } = await world(["a", "b"]);
    medium.connect("a", "b");
    medium.inject({ kind: "drop", from: "a", count: 1 });
    medium.inject({ kind: "duplicate", from: "a", count: 1 });
    medium.inject({ kind: "delay", from: "a", delayMs: 1000, count: 1 });
    medium.inject({ kind: "corrupt", from: "a", passCrc: true, count: 1 });
    medium.inject({ kind: "corrupt", from: "a", count: 1 });
    for (let i = 1; i <= 6; i++) await sched.run(links.a.send(bytes(20, i)));
    await sched.runUntilIdle();
    const firsts = got.b.map((f) => f.bytes[0]);
    // 1 dropped, 2 twice, 3 delayed past 4 and 5, 4 corrupted in the chunk, 5 lost to the CRC.
    expect(firsts).toEqual([2, 2, 4, 6, 3]);
    expect(got.b[2].bytes).not.toEqual(bytes(20, 4));
    expect(medium.records()[4].results[0].reason).toBe("crc");
  });

  it("repeats the same losses for the same seed", async () => {
    const run = async (seed: number) => {
      const { sched, medium, links, got } = await world(["a", "b"], radio(), seed);
      medium.connect("a", "b", { loss: 0.3 });
      for (let i = 0; i < 50; i++) await sched.run(links.a.send(bytes(20, i)));
      return got.b.map((f) => f.bytes[0]).join(",");
    };
    expect(await run(4)).toBe(await run(4));
    expect(await run(4)).not.toBe(await run(5));
  });

  it("models bursty loss and powered-off nodes", async () => {
    const { sched, medium, links, got } = await world(["a", "b"]);
    medium.connect("a", "b", { burst: { pGoodToBad: 0.1, pBadToGood: 0.3, lossGood: 0, lossBad: 1 } });
    for (let i = 0; i < 200; i++) await sched.run(links.a.send(bytes(20, i)));
    expect(got.b.length).toBeGreaterThan(100);
    expect(got.b.length).toBeLessThan(195);
    medium.power("b", false);
    const before = got.b.length;
    await sched.run(links.a.send(bytes(20)));
    expect(got.b.length).toBe(before);
    expect(medium.records().at(-1)!.results[0].reason).toBe("off");
  });
});
