import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Endpoint, RelayTransport, SystemClock, ctt1, ourSpec, type Identity } from "@toip-tools/trust-core";
import { startRelay, type Relay } from "@toip-tools/relay";
import { regions } from "../src/airtime";
import { decodeFrame } from "../src/frame";
import { decodePacket } from "../src/packet";
import { MeshGateway, memoryGatewayStore, type GatewayStore } from "../src/gateway";
import { MeshTransport, type MeshEvent } from "../src/mesh";
import { VirtualScheduler, realScheduler } from "../src/scheduler";
import { SimMedium } from "../src/sim";
import { exportBundle, openBundle, postBundle } from "../src/bundle";
import { ident, setting, wireOf } from "./helpers";

const relays: Relay[] = [];
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const r of relays.splice(0)) await r.close();
});

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function relay() {
  const r = await startRelay({ port: 0, dbPath: join(mkdtempSync(join(tmpdir(), "mesh-relay-")), "relay.db") });
  relays.push(r);
  return r;
}

/** An online party: an Endpoint on a RelayTransport, recording the exact wires it receives. */
function online(url: string, who: Identity) {
  const transport = new RelayTransport({ url, identity: who });
  const clock = new SystemClock();
  const endpoint = new Endpoint({ identity: who, transport, clock });
  const wires: Uint8Array[] = [];
  transport.attach(who.did, async (w) => {
    wires.push(w);
    await endpoint.ingest(w);
  });
  transport.start();
  stops.push(() => transport.stop());
  return { transport, endpoint, wires };
}

/** A cabin and a lodge on a fast simulated radio, in real time. */
async function cabinAndLodge(url: string, store: GatewayStore = memoryGatewayStore()) {
  const medium = new SimMedium({ scheduler: realScheduler, seed: 3 });
  const radio = { setting: setting(7, 500000), mtu: 250, budget: regions.none, turnaroundMs: 5 };
  const alice = ident("cabin/alice");
  const lodge = ident("lodge");
  const aliceEvents: MeshEvent[] = [];
  const aliceMesh = new MeshTransport({ identities: [alice], links: [medium.node("alice", radio)], gateways: [{ vid: lodge.did }], onEvent: (e) => aliceEvents.push(e) });
  const lodgeMesh = new MeshTransport({ identities: [lodge], links: [medium.node("lodge", radio)] });
  medium.connect("alice", "lodge");
  const lodgeRelay = new RelayTransport({ url, identity: lodge });
  lodgeRelay.start();
  const gateway = new MeshGateway({ identity: lodge, mesh: lodgeMesh, relay: lodgeRelay, store, beaconEveryMs: 60_000 });
  await aliceMesh.start();
  await gateway.start();
  await until(() => aliceMesh.neighbors().some((c) => c.vid === lodge.did));
  stops.push(() => aliceMesh.stop(), () => gateway.stop(), () => lodgeMesh.stop(), () => lodgeRelay.stop());
  return { medium, alice, lodge, aliceMesh, lodgeMesh, gateway, aliceEvents, lodgeRelay };
}

describe("MeshGateway", () => {
  it("bridges a mesh message to the real relay byte for byte, and the recipient opens it as from the sender", async () => {
    const r = await relay();
    const landlord = ident("landlord");
    const land = online(r.url, landlord);
    const w = await cabinAndLodge(r.url);
    const sent: Uint8Array[] = [];
    const tap = { attach: w.aliceMesh.attach.bind(w.aliceMesh), detach: w.aliceMesh.detach.bind(w.aliceMesh), post: (f: string, t: string, x: Uint8Array) => (sent.push(x), w.aliceMesh.post(f, t, x)) };
    const aliceEp = new Endpoint({ identity: w.alice, transport: tap, clock: new SystemClock(), bodyCodecFor: (to) => (w.aliceMesh.supportsCompact(to) ? ctt1 : undefined) });
    const attest = ourSpec("settle/escrow/attest");
    const got: { sender: string; claim: string }[] = [];
    land.endpoint.handle<{ claim: string }, void>(attest, (doc, ctx) => void got.push({ sender: ctx.sender, claim: doc.payload.claim }));
    expect(await aliceEp.notify(landlord.did, attest, { claim: "complete" })).toBe("queued");
    expect(w.aliceEvents.some((e) => e.type === "custody" && e.gateway === w.lodge.did)).toBe(true);
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ sender: w.alice.did, claim: "complete" });
    expect(land.wires).toHaveLength(1);
    expect(land.wires[0]).toEqual(sent[0]);
    // On the air it went as a VIA packet: no VIDs in clear.
    const kinds = w.medium.records().map((x) => decodeFrame(x.bytes)).filter((f) => f?.type === "data" && f.index === 0).map((f) => f?.type === "data" && decodePacket(f.chunk)?.kind);
    expect(kinds).toContain("via");
    expect(w.gateway.stats()).toEqual({ forwarded: 1, duplicates: 0, failed: 0 });
    aliceEp.close();
  });

  it("answers a resent VIA packet with the same custody receipt, posts it once, and remembers across a restart", async () => {
    const r = await relay();
    const landlord = ident("landlord-2");
    const land = online(r.url, landlord);
    const store = memoryGatewayStore();
    const w = await cabinAndLodge(r.url, store);
    // The first custody receipt is lost on the air: Alice resends.
    w.medium.inject({ kind: "drop", from: "lodge", match: (b) => decodeFrame(b)?.type === "data", count: 1 });
    const wire = await wireOf(w.alice, landlord.did, 300);
    expect(await w.aliceMesh.post(w.alice.did, landlord.did, wire)).toBe("queued");
    await until(() => w.aliceEvents.some((e) => e.type === "custody"), 15_000);
    expect(w.gateway.stats()).toMatchObject({ forwarded: 1, duplicates: 1 });
    await until(() => land.wires.length === 1);

    // The gateway restarts (a new mesh node, so a new seen list) with the same store,
    // and an attacker replays Alice's frames to it.
    const captured = w.medium.records().filter((x) => x.from === "alice" && decodeFrame(x.bytes)?.type === "data").map((x) => x.bytes);
    await w.gateway.stop();
    await w.lodgeMesh.stop();
    const radio = { setting: setting(7, 500000), mtu: 250, budget: regions.none };
    // Nothing here needs real time: a virtual radio keeps it deterministic.
    const sched = new VirtualScheduler();
    const medium2 = new SimMedium({ scheduler: sched, seed: 5 });
    const lodgeMesh2 = new MeshTransport({ identities: [w.lodge], links: [medium2.node("lodge2", radio)], scheduler: sched });
    const fresh = new MeshGateway({ identity: w.lodge, mesh: lodgeMesh2, relay: w.lodgeRelay, store, beaconEveryMs: 60_000 });
    await fresh.start();
    stops.push(() => fresh.stop(), () => lodgeMesh2.stop());
    const replayer = medium2.node("replayer", radio);
    await replayer.open();
    medium2.connect("replayer", "lodge2");
    // Let lodge2's first beacon finish, then replay Alice's first burst (all its fragments).
    await sched.advance(1000);
    const first = decodeFrame(captured[0]);
    const count = first?.type === "data" ? first.count : 0;
    expect(count).toBeGreaterThan(1);
    for (const f of captured.slice(0, count)) await sched.run(replayer.send(f));
    await sched.advance(5000);
    expect(fresh.stats().duplicates).toBe(1);
    await new Promise((res) => setTimeout(res, 300));
    expect(land.wires).toHaveLength(1);
    expect(fresh.stats().forwarded).toBe(0);
  }, 20_000);
});

describe("sneakernet bundles", () => {
  it("exports the outbox sealed to a courier, opens only for the courier, and posts through a relay", async () => {
    const r = await relay();
    const landlord = ident("landlord-3");
    const courier = ident("courier");
    const land = online(r.url, landlord);
    // Alice is alone: nothing hears her.
    const medium = new SimMedium({ scheduler: realScheduler, seed: 1 });
    const alice = ident("cabin/alice-3");
    const mesh = new MeshTransport({ identities: [alice], links: [medium.node("alice", { setting: setting(7, 500000), mtu: 250, budget: regions.none })], flood: { maxTtl: 3, relayShare: 0.3, unknown: "off" } });
    stops.push(() => mesh.stop());
    const aliceEp = new Endpoint({ identity: alice, transport: mesh, clock: new SystemClock(), bodyCodecFor: () => ctt1 });
    const note = ourSpec("settle/escrow/attest");
    const got: string[] = [];
    land.endpoint.handle<{ claim: string }, void>(note, (doc, ctx) => void got.push(`${ctx.sender}:${doc.payload.claim}`));
    expect(await aliceEp.notify(landlord.did, note, { claim: "complete" })).toBe("queued");
    expect(mesh.pending()).toBe(1);

    const bundle = await mesh.exportBundle({ sealTo: courier.did });
    expect(mesh.pending()).toBe(0);
    await expect(openBundle(bundle)).rejects.toThrow(/sealed/);
    await expect(openBundle(bundle, ident("nosy"))).rejects.toThrow(/someone else/);
    const items = await openBundle(bundle, courier);
    expect(items.map((i) => i.to)).toEqual([landlord.did]);

    const courierRelay = new RelayTransport({ url: r.url, identity: courier });
    courierRelay.start();
    stops.push(() => courierRelay.stop());
    await until(() => courierRelay.status === "connected");
    expect(await postBundle(items, courierRelay)).toEqual({ posted: 1, refused: 0 });
    await until(() => got.length === 1);
    expect(got).toEqual([`${alice.did}:complete`]);
    expect(land.wires[0]).toEqual(items[0].wire);
    aliceEp.close();
  });

  it("round-trips an unsealed bundle", async () => {
    const a = ident("b/a");
    const b = ident("b/b");
    const items = [
      { to: b.did, wire: await wireOf(a, b.did, 50) },
      { to: b.did, wire: await wireOf(a, b.did, 70) },
    ];
    expect(await openBundle(await exportBundle(items))).toEqual(items);
    await expect(openBundle(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
