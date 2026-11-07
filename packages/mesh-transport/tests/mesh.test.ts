import { describe, expect, it } from "vitest";
import { Endpoint, ctt1, ourSpec, type Identity } from "@toip-tools/trust-core";
import { regions } from "../src/airtime";
import { utf8 } from "../src/bytes";
import { decodeFrame } from "../src/frame";
import { decodePacket } from "../src/packet";
import { RegulatoryViolation } from "../src/sim";
import type { MeshEvent } from "../src/mesh";
import { contains, meshWorld, setting, wireOf, type Node } from "./helpers";

type World = Awaited<ReturnType<typeof meshWorld>>;

/** b sends a to a first, so each has heard the other directly. */
async function introduce(w: World, a: string, b: string) {
  const na = w.nodes[a];
  const nb = w.nodes[b];
  const d = await w.sched.run(nb.mesh.post(nb.id.did, na.id.did, await wireOf(nb.id, na.id.did, 20)));
  await w.sched.runUntilIdle({ maxMs: 60_000 });
  na.inbox.length = 0;
  return d;
}

const dataFrames = (w: World, from: string) =>
  w.medium.records().filter((r) => r.from === from).map((r) => ({ r, f: decodeFrame(r.bytes) })).filter((x) => x.f?.type === "data");

describe("MeshTransport between two nodes", () => {
  it("carries a real Trust Task request and response between two Endpoints, in CTT1", async () => {
    const w = await meshWorld({ names: ["rosa", "door"], links: [["rosa", "door"]] });
    const { rosa, door } = w.nodes;
    const clock = w.sched;
    // Endpoints attach themselves to the transport; the helper's inbox handlers are replaced.
    const mk = (n: Node) => new Endpoint({ identity: n.id, transport: n.mesh, clock, bodyCodecFor: (to) => (n.mesh.supportsCompact(to) ? ctt1 : undefined) });
    const rosaEp = mk(rosa);
    const doorEp = mk(door);
    const open = ourSpec("mesh-demo/door/open");
    doorEp.handle<{ challenge: string }, { open: boolean }>(open, (doc) => ({ open: doc.payload.challenge === "9f3a" }));
    const timeoutMs = rosa.mesh.suggestedTimeoutMs(door.id.did, 600);
    expect(timeoutMs).toBeGreaterThan(2000);
    const res = await w.sched.run(rosaEp.request<{ challenge: string }, { open: boolean }>(door.id.did, open, { challenge: "9f3a" }, { timeoutMs: 60_000 }));
    expect(res.payload.open).toBe(true);
    expect(res.issuer).toBe(door.id.did);

    // What a listener heard: frames with no DIDs and no payload text.
    for (const r of w.medium.records()) {
      expect(r.bytes.length).toBeLessThanOrEqual(250);
      for (const did of [rosa.id.did, door.id.did]) expect(contains(r.bytes, utf8(did))).toBe(false);
      expect(contains(r.bytes, utf8("9f3a"))).toBe(false);
    }
    // The second exchange goes direct: the request is acknowledged frame by frame.
    const res2 = await w.sched.run(rosaEp.request<{ challenge: string }, { open: boolean }>(door.id.did, open, { challenge: "nope" }, { timeoutMs: 60_000 }));
    expect(res2.payload.open).toBe(false);
    expect(w.medium.records().some((r) => decodeFrame(r.bytes)?.type === "ack")).toBe(true);
    rosaEp.close();
    doorEp.close();
  });

  it("rebuilds the exact TSP bytes, once each, under 20% loss, reordering and duplicates", async () => {
    let firstCycle = 0;
    const runs = 40;
    for (let seed = 1; seed <= runs; seed++) {
      const w = await meshWorld({ names: ["a", "b"], seed, links: [["a", "b", { loss: 0.2 }]] });
      const { a, b } = w.nodes;
      await introduce(w, "a", "b");
      w.medium.inject({ kind: "duplicate", from: "a", count: 2 });
      w.medium.inject({ kind: "delay", from: "a", delayMs: 400, count: 1 });
      const wire = await wireOf(a.id, b.id.did, 450, seed);
      const d = await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire));
      if (d === "live") firstCycle++;
      await w.sched.runUntilIdle({ maxMs: 3600_000 });
      expect(b.inbox).toHaveLength(1);
      expect(b.inbox[0]).toEqual(wire);
    }
    expect(firstCycle / runs).toBeGreaterThanOrEqual(0.95);
  });

  it("meets the design's bar: at 20% frame loss, 99% of 3-frame packets arrive within 4 rounds", async () => {
    const runs = 200;
    let within = 0;
    let airtime = 0;
    let ideal = 0;
    for (let seed = 1000; seed < 1000 + runs; seed++) {
      // post() answers only when the 4 rounds are over (or the packet is through), not on a timer.
      const w = await meshWorld({ names: ["a", "b"], seed, links: [["a", "b", { loss: 0.2 }]], mesh: { postWaitMs: () => 3600_000 } });
      const { a, b } = w.nodes;
      await introduce(w, "a", "b");
      const start = a.mesh.stats().airtimeMs + b.mesh.stats().airtimeMs;
      const wire = await wireOf(a.id, b.id.did, 450, seed);
      const d = await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire));
      if (d === "live" && b.inbox.length === 1) within++;
      airtime += a.mesh.stats().airtimeMs + b.mesh.stats().airtimeMs - start;
      ideal += dataFrames(w, "a").slice(-3).reduce((s, x) => s + x.r.airtimeMs, 0);
    }
    expect(within / runs).toBeGreaterThanOrEqual(0.99);
    // Airtime overhead over a lossless single burst: reported, and bounded.
    const overhead = airtime / ideal;
    console.log(`20% loss: ${within}/${runs} within 4 rounds; airtime ${overhead.toFixed(2)}x a lossless burst`);
    expect(overhead).toBeLessThan(2.5);
  });

  it("sends a burst back to back, then resends only the gaps the ACK names", async () => {
    const w = await meshWorld({ names: ["a", "b"], links: [["a", "b"]] });
    const { a, b } = w.nodes;
    await introduce(w, "a", "b");
    const before = w.medium.records().length;
    let dropped = false;
    w.medium.inject({
      kind: "drop",
      from: "a",
      match: (bytes) => {
        const f = decodeFrame(bytes);
        if (f?.type === "data" && f.index === 1 && f.count === 3 && !dropped) return (dropped = true);
        return false;
      },
    });
    const wire = await wireOf(a.id, b.id.did, 450);
    expect(await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire))).toBe("live");
    const recs = w.medium.records().slice(before);
    const kinds = recs.map((r) => {
      const f = decodeFrame(r.bytes)!;
      return f.type === "data" ? `${r.from}:d${f.index}` : `${r.from}:${f.type}`;
    });
    expect(kinds).toEqual(["a:d0", "a:d1", "a:d2", "b:ack", "a:d1", "b:ack"]);
    // Back to back: each fragment starts when the one before ends.
    expect(recs[1].atMs).toBeCloseTo(recs[0].atMs + recs[0].airtimeMs, 6);
    expect(recs[2].atMs).toBeCloseTo(recs[1].atMs + recs[1].airtimeMs, 6);
    const gapAck = decodeFrame(recs[3].bytes);
    expect(gapAck?.type === "ack" && gapAck.bitmap[0]).toBe(0b101);
    expect(b.inbox).toEqual([wire]);
    expect(a.events.some((e) => e.type === "retry" && e.missing.join() === "1")).toBe(true);
  });

  it("resends when ACKs are lost, and the receiver acknowledges again without delivering twice", async () => {
    const w = await meshWorld({ names: ["a", "b"], links: [["a", "b"]] });
    const { a, b } = w.nodes;
    await introduce(w, "a", "b");
    w.medium.inject({ kind: "drop", from: "b", match: (x) => decodeFrame(x)?.type === "ack", count: 2 });
    const wire = await wireOf(a.id, b.id.did, 300);
    expect(await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire))).toBe("live");
    expect(b.inbox).toEqual([wire]);
    expect(w.medium.records().filter((r) => r.from === "b" && decodeFrame(r.bytes)?.type === "ack").length).toBe(3);
  });

  it("catches corruption that slips past the radio's CRC with the packet hash", async () => {
    const w = await meshWorld({ names: ["a", "b"], links: [["a", "b"]] });
    const { a, b } = w.nodes;
    await introduce(w, "a", "b");
    w.medium.inject({ kind: "corrupt", from: "a", passCrc: true, match: (x) => decodeFrame(x)?.type === "data" });
    const wire = await wireOf(a.id, b.id.did, 300);
    expect(await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire))).toBe("live");
    expect(b.inbox).toEqual([wire]);
    expect(b.mesh.stats().dropped["bad-hash"]).toBe(1);
  });

  it("drops replayed frames as duplicates", async () => {
    const w = await meshWorld({ names: ["a", "b", "mallory"], links: [["a", "b"], ["mallory", "b"]] });
    const { a, b } = w.nodes;
    await introduce(w, "a", "b");
    const before = w.medium.records().length;
    await w.sched.run(a.mesh.post(a.id.did, b.id.did, await wireOf(a.id, b.id.did, 300)));
    const captured = w.medium.records().slice(before).filter((r) => r.from === "a").map((r) => r.bytes);
    await w.sched.advance(120_000);
    const mallory = w.medium.node("mallory-radio", { setting: setting(), mtu: 250, budget: regions.none });
    await mallory.open();
    w.medium.connect("mallory-radio", "b");
    for (const f of captured) await w.sched.run(mallory.send(f));
    await w.sched.runUntilIdle({ maxMs: 60_000 });
    expect(b.inbox).toHaveLength(1);
  });

  it("refuses a message that needs more than 64 fragments, and never sends a frame over the MTU", async () => {
    const w = await meshWorld({ names: ["a", "b"], radio: { mtu: 24 }, budget: regions.none, links: [["a", "b"]] });
    const { a, b } = w.nodes;
    expect(await w.sched.run(a.mesh.post(a.id.did, b.id.did, await wireOf(a.id, b.id.did, 2000)))).toBe("undelivered");
    const ok = await wireOf(a.id, b.id.did, 600);
    await w.sched.run(a.mesh.post(a.id.did, b.id.did, ok));
    await w.sched.runUntilIdle({ maxMs: 3600_000 });
    expect(b.inbox).toEqual([ok]);
    for (const r of w.medium.records()) expect(r.bytes.length).toBeLessThanOrEqual(24);
  });

  it("keeps US frames under the 400 ms dwell limit by shrinking the MTU", async () => {
    const w = await meshWorld({ names: ["a", "b"], radio: { setting: setting(10, 500000) }, budget: regions.us915, links: [["a", "b"]] });
    const { a, b } = w.nodes;
    const wire = await wireOf(a.id, b.id.did, 500);
    await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire));
    await w.sched.runUntilIdle({ maxMs: 3600_000 });
    expect(b.inbox).toEqual([wire]);
    for (const r of w.medium.records()) {
      expect(r.bytes.length).toBeLessThanOrEqual(174);
      expect(r.airtimeMs).toBeLessThanOrEqual(400);
    }
  });

  it("keeps to a 1% duty cycle under heavy traffic, queues when the budget is spent, and resumes on its own", async () => {
    const w = await meshWorld({ names: ["a", "b"], radio: { setting: setting(7, 125000, 868_100_000) }, budget: regions["eu868-g1"], links: [["a", "b"]] });
    const { a, b } = w.nodes;
    await introduce(w, "a", "b");
    const wires = await Promise.all(Array.from({ length: 45 }, (_, i) => wireOf(a.id, b.id.did, 450, i)));
    const results = await w.sched.run(Promise.all(wires.map((x) => a.mesh.post(a.id.did, b.id.did, x))));
    expect(results).toContain("queued");
    await w.sched.runUntilIdle({ maxMs: 12 * 3600_000 });
    expect(a.events.some((e) => e.type === "budget" && e.waitMs > 0)).toBe(true);
    expect(b.inbox).toHaveLength(45);
    expect(new Set(b.inbox.map((x) => Buffer.from(x).toString("hex")))).toEqual(new Set(wires.map((x) => Buffer.from(x).toString("hex"))));
    // At most 1% of any hour.
    const recs = w.medium.records().filter((r) => r.from === "a");
    for (const r of recs) {
      const inHour = recs.filter((x) => x.atMs > r.atMs - 3600_000 && x.atMs <= r.atMs).reduce((s, x) => s + x.airtimeMs, 0);
      expect(inHour).toBeLessThanOrEqual(36_000 + 1e-6);
    }
  });

  it("never sends with a broken budget: a RegulatoryViolation would surface here", async () => {
    const w = await meshWorld({ names: ["a", "b"], budget: { windowMs: 60_000, maxFraction: 0.02, maxFrameMs: 400 }, links: [["a", "b"]] });
    const { a, b } = w.nodes;
    const errors: unknown[] = [];
    const posts = [];
    for (let i = 0; i < 10; i++) posts.push(a.mesh.post(a.id.did, b.id.did, await wireOf(a.id, b.id.did, 400, i)).catch((e) => errors.push(e)));
    await w.sched.run(Promise.all(posts));
    await w.sched.runUntilIdle({ maxMs: 3600_000 });
    expect(errors.filter((e) => e instanceof RegulatoryViolation)).toEqual([]);
    expect(b.inbox).toHaveLength(10);
  });
});

describe("addressing", () => {
  it("uses fresh tags that only the addressee recognizes; a bystander with both as contacts delivers nothing", async () => {
    const w = await meshWorld({ names: ["a", "b", "eve"], links: [["a", "b"], ["a", "eve"], ["b", "eve"]] });
    const { a, b, eve } = w.nodes;
    await introduce(w, "a", "b");
    for (let i = 0; i < 5; i++) await w.sched.run(a.mesh.post(a.id.did, b.id.did, await wireOf(a.id, b.id.did, 100, i)));
    await w.sched.runUntilIdle({ maxMs: 60_000 });
    expect(b.inbox).toHaveLength(5);
    expect(eve.inbox).toHaveLength(0);
    const tags = new Set<string>();
    for (const { f } of dataFrames(w, "a")) {
      if (f?.type !== "data" || f.index !== 0) continue;
      const p = decodePacket(f.chunk);
      if (p?.kind === "pair") tags.add(Buffer.from(p.tag).toString("hex"));
    }
    expect(tags.size).toBeGreaterThanOrEqual(5);
  });

  it("introduces a first contact with a sealed sender, and a node that refuses intros says so", async () => {
    const w = await meshWorld({ names: ["guest", "door"], links: [["guest", "door"]], mesh: (n) => (n === "door" ? { acceptIntros: () => false } : {}) });
    const { guest, door } = w.nodes;
    const d = await w.sched.run(guest.mesh.post(guest.id.did, door.id.did, await wireOf(guest.id, door.id.did, 100)));
    expect(d).toBe("undelivered");
    expect(door.inbox).toHaveLength(0);
    const first = dataFrames(w, "guest")[0].f;
    expect(first?.type === "data" && decodePacket(first.chunk)?.kind).toBe("intro");
  });

  it("reports each packet it builds: kind, route, size and frames, before the first frame", async () => {
    const w = await meshWorld({ names: ["guest", "door"], links: [["guest", "door"]] });
    const { guest, door } = w.nodes;
    const wire = await wireOf(guest.id, door.id.did, 450);
    expect(await w.sched.run(guest.mesh.post(guest.id.did, door.id.did, wire))).toBe("live");
    const out = guest.events.filter((e) => e.type === "packet-out");
    expect(out).toHaveLength(1);
    const e = out[0] as Extract<MeshEvent, { type: "packet-out" }>;
    // Never heard from, so flooded (the default for unknown recipients).
    expect(e).toMatchObject({ kind: "intro", from: guest.id.did, to: door.id.did, route: "flood", wireBytes: wire.length });
    const frames = dataFrames(w, "guest").filter((x) => x.f?.type === "data" && Buffer.from(x.f.pid).toString("hex") === e.pid);
    expect(new Set(frames.map((x) => x.f?.type === "data" && x.f.index)).size).toBe(e.frames);
    expect(frames.reduce((n, x, i, all) => (all.findIndex((y) => y.r.bytes.length === x.r.bytes.length && y.f?.type === "data" && x.f?.type === "data" && y.f.index === x.f.index) === i ? n + x.r.bytes.length - 8 : n), 0)).toBe(e.bytes);
    expect(guest.events.findIndex((x) => x.type === "packet-out")).toBeLessThan(guest.events.findIndex((x) => x.type === "frame-out"));
  });

  it("keeps a message in the outbox while nobody answers, and delivers it on a later try", async () => {
    const w = await meshWorld({ names: ["a", "b"], links: [] });
    const { a, b } = w.nodes;
    const wire = await wireOf(a.id, b.id.did, 100);
    expect(await w.sched.run(a.mesh.post(a.id.did, b.id.did, wire))).toBe("queued");
    expect(a.mesh.pending()).toBe(1);
    expect(a.events.some((e) => e.type === "queued" && e.reason === "no-answer")).toBe(true);
    w.medium.connect("a", "b");
    await w.sched.runUntilIdle({ maxMs: 3 * 3600_000 });
    expect(b.inbox).toEqual([wire]);
    expect(a.mesh.pending()).toBe(0);
  });

  it("with flooding of unknown recipients off, waits for a route", async () => {
    const w = await meshWorld({ names: ["a", "b"], links: [["a", "b"]], mesh: { flood: { maxTtl: 3, relayShare: 0.3, unknown: "off" } } });
    const { a, b } = w.nodes;
    expect(await w.sched.run(a.mesh.post(a.id.did, b.id.did, await wireOf(a.id, b.id.did, 100)))).toBe("queued");
    expect(a.events.some((e) => e.type === "queued" && e.reason === "no-route")).toBe(true);
    expect(b.inbox).toHaveLength(0);
  });
});

describe("flooding", () => {
  const line = (maxTtl: number) =>
    meshWorld({
      names: ["n0", "n1", "n2", "n3"],
      links: [["n0", "n1"], ["n1", "n2"], ["n2", "n3"]],
      mesh: { relay: true, flood: { maxTtl, relayShare: 0.3, unknown: "flood" } },
    });

  it("reaches the end of a line of 4 nodes with ttl 3, and the receipt comes back", async () => {
    const w = await line(3);
    const { n0, n3 } = w.nodes;
    const wire = await wireOf(n0.id, n3.id.did, 300);
    expect(await w.sched.run(n0.mesh.post(n0.id.did, n3.id.did, wire))).toBe("live");
    expect(n3.inbox).toEqual([wire]);
    for (const n of ["n1", "n2"]) expect(w.nodes[n].inbox).toHaveLength(0);
  });

  it("stops where the ttl runs out", async () => {
    const w = await line(1);
    const { n0, n3 } = w.nodes;
    const d = await w.sched.run(n0.mesh.post(n0.id.did, n3.id.did, await wireOf(n0.id, n3.id.did, 300)));
    expect(d).toBe("queued");
    await w.sched.runUntilIdle({ maxMs: 120_000 });
    expect(n3.inbox).toHaveLength(0);
    const relayedBy = new Set(w.medium.records().filter((r) => decodeFrame(r.bytes)?.type === "data").map((r) => r.from));
    expect(relayedBy.has("n2")).toBe(false);
  });

  it("transmits a packet at most once per node on a 10-node grid", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `g${i}`);
    const links: [string, string][] = [];
    for (let i = 0; i < 10; i++) {
      if (i % 5 < 4) links.push([`g${i}`, `g${i + 1}`]);
      if (i + 5 < 10) links.push([`g${i}`, `g${i + 5}`]);
    }
    const w = await meshWorld({ names, links, mesh: { relay: true, flood: { maxTtl: 3, relayShare: 0.3, unknown: "flood" } } });
    const { g0, g8 } = w.nodes;
    const wire = await wireOf(g0.id, g8.id.did, 100);
    await w.sched.run(g0.mesh.post(g0.id.did, g8.id.did, wire));
    await w.sched.runUntilIdle({ maxMs: 120_000 });
    expect(g8.inbox).toEqual([wire]);
    const first = dataFrames(w, "g0")[0].f;
    const pid = first?.type === "data" ? Buffer.from(first.pid).toString("hex") : "";
    const sends = w.medium.records().filter((r) => {
      const f = decodeFrame(r.bytes);
      return f?.type === "data" && f.index === 0 && f.attempt === 0 && Buffer.from(f.pid).toString("hex") === pid;
    });
    expect(sends.length).toBeLessThanOrEqual(10);
    expect(new Set(sends.map((r) => r.from)).size).toBe(sends.length);
  });
});

export type { Identity };
