import { describe, expect, it } from "vitest";
import type { Delivery } from "@zk-toip/trust-core";
import { ChallengeBeacon } from "../src/beacon";
import { decodeFrame } from "../src/frame";
import { MeshGateway } from "../src/gateway";
import type { BeaconInfo } from "../src/mesh";
import { ident, meshWorld, wireOf } from "./helpers";

describe("ChallengeBeacon", () => {
  it("announces a fresh signed challenge that a guest who knows the door verifies, and keeps the last two", async () => {
    const w = await meshWorld({ names: ["rosa", "door"], links: [["rosa", "door"]] });
    const { rosa, door } = w.nodes;
    const heard: BeaconInfo[] = [];
    rosa.mesh.onBeacon((b) => heard.push(b));
    const beacon = new ChallengeBeacon({ identity: door.id, mesh: door.mesh, everyMs: 15_000 });
    beacon.start();
    await w.sched.advance(1000);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ role: "verifier", vid: door.id.did });
    expect(heard[0].nonce).toEqual(beacon.current());
    const first = heard[0].nonce!;
    await w.sched.advance(15_000);
    expect(beacon.isFresh(first)).toBe(true);
    await w.sched.advance(15_000);
    expect(beacon.isFresh(first)).toBe(false);
    expect(heard).toHaveLength(3);
    beacon.stop();
    // The beacon is the design's 82 bytes, and heard directly: the guest's first message goes one hop and is acknowledged.
    expect(w.medium.records().filter((r) => decodeFrame(r.bytes)?.type === "beacon").every((r) => r.bytes.length === 82)).toBe(true);
    expect(rosa.mesh.neighbors().map((c) => c.vid)).toEqual([door.id.did]);
    expect(await w.sched.run(rosa.mesh.post(rosa.id.did, door.id.did, await wireOf(rosa.id, door.id.did, 400)))).toBe("live");
    expect(w.medium.records().some((r) => r.from === "door" && decodeFrame(r.bytes)?.type === "ack")).toBe(true);
    expect(door.inbox).toHaveLength(1);
  });

  it("ignores beacons from keys it doesn't know", async () => {
    const w = await meshWorld({ names: ["rosa", "door"], links: [["rosa", "door"]] });
    const stranger = ident("stranger");
    const { MeshTransport } = await import("../src/mesh");
    const strangerMesh = new MeshTransport({ identities: [stranger], links: [w.medium.node("stranger", { setting: (await import("./helpers")).setting(), mtu: 250, budget: (await import("../src/airtime")).regions.none })], scheduler: w.sched });
    w.medium.connect("stranger", "rosa");
    await strangerMesh.start();
    const heard: BeaconInfo[] = [];
    w.nodes.rosa.mesh.onBeacon((b) => heard.push(b));
    await w.sched.run(strangerMesh.sendBeacon("verifier", stranger.did, new Uint8Array(8)));
    await w.sched.advance(100);
    expect(heard).toHaveLength(0);
    expect(w.nodes.rosa.mesh.stats().dropped["unknown-beacon"]).toBe(1);
  });
});

describe("act 2 on the simulator: an attestation from the cabin through a relay to the gateway", () => {
  it("hears the lodge's beacon through the ridge, sends VIA two hops, and gets a signed custody receipt back", async () => {
    const posted: { from: string; to: string; wire: Uint8Array }[] = [];
    const relay = { url: "wss://relay.example/v1", post: async (from: string, to: string, wire: Uint8Array): Promise<Delivery> => (posted.push({ from, to, wire }), "queued") };
    const lodgeId = ident("lodge");
    const w = await meshWorld({
      names: ["alice", "ridge", "lodge"],
      links: [["alice", "ridge"], ["ridge", "lodge"]],
      mesh: (n) => (n === "ridge" ? { relay: true, gateways: [{ vid: lodgeId.did }] } : n === "alice" ? { gateways: [{ vid: lodgeId.did }] } : {}),
    });
    const { alice, lodge } = w.nodes;
    const gateway = new MeshGateway({ identity: lodge.id, mesh: lodge.mesh, relay, beaconEveryMs: 60_000 });
    await gateway.start();
    await w.sched.advance(2000);
    const landlord = ident("landlord").did;
    expect(alice.mesh.estimate(landlord, 600).route).toBe("gateway");
    expect(alice.mesh.neighbors()).toHaveLength(0);
    const wire = await wireOf(alice.id, landlord, 400);
    expect(await w.sched.run(alice.mesh.post(alice.id.did, landlord, wire))).toBe("queued");
    expect(alice.events.some((e) => e.type === "custody" && e.gateway === lodge.id.did)).toBe(true);
    expect(posted).toEqual([{ from: lodge.id.did, to: landlord, wire }]);
    // The ridge repeated the beacon with one hop added.
    expect(w.medium.records().some((r) => r.from === "ridge" && decodeFrame(r.bytes)?.type === "beacon" && r.bytes.length === 83)).toBe(true);
    await gateway.stop();
  });
});
