import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realScheduler } from "@zk-toip/mesh-transport";
import { SystemClock } from "@zk-toip/trust-core";
import {
  CameraDevice,
  chainFromJson,
  embedStore,
  encodeStore,
  httpFetcher,
  publishStore,
  verifyAsset,
  verifySensorFeed,
  withoutStore,
  type TrustEntry,
} from "../src/core";
import { openSensor, type Enrollment } from "../src/sensors/device";
import { SensorNode, simulatedChannels } from "../src/sensors/node";
import { RemoteSimLink } from "../src/sensors/remoteLink";
import { startWorld, type World } from "../src/world/world";
import { codes, jpegPhoto } from "./helpers";

let world: World;
let dir: string;
let config: { owner: { did: string; name: string }; maker: { did: string }; gateway: { id: string; publicKey: string }; drand: { chain: Parameters<typeof chainFromJson>[0] } };
let trust: TrustEntry[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capture-world-"));
  world = await startWorld({ port: 0, dataDir: dir, drand: "dev", web: "none", sensorIntervalMs: 1000, sealEvery: 3, beaconEveryMs: 1500 });
  config = await (await fetch(`${world.url}/api/config`)).json();
  trust = [
    { did: config.owner.did, name: config.owner.name, trustedFor: ["owner", "editor", "installer"] },
    { did: config.maker.did, name: "maker", trustedFor: ["maker"] },
  ];
});

afterAll(async () => {
  await world?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the world, over HTTP", () => {
  it("enrolls a camera, anchors a capture, publishes it; the verifier finds a stripped copy; the owner's rotation shows", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const cam = await CameraDevice.enroll("Test camera", { base: world.url, pair });
    expect(cam.did).toMatch(/^did:keri:E/);
    const file = jpegPhoto(256, 128, 5);
    const shot = await cam.shoot(file, { sensor: { type: "camera", pipeline: "test" }, app: { name: "capture-camera", version: "0.1.0" } });
    const a = await cam.anchor([shot]);
    expect(a.witnessed).toBe(3);
    await publishStore(world.url, encodeStore(shot.store));
    const fetcher = httpFetcher(world.url);
    const ctx = { now: Date.now(), trust, drand: [chainFromJson(config.drand.chain)], fetch: fetcher };
    const r = await verifyAsset(embedStore(file, shot.store), null, ctx);
    expect(codes(r, "fail")).toEqual([]);
    expect(r.verdict).toBe("verified");
    const stripped = await verifyAsset(withoutStore(embedStore(file, shot.store)), null, ctx);
    expect(stripped.storeSource).toBe("registry");
    expect(stripped.verdict).toBe("verified");

    // the owner rotates: the anchored photo still verifies; a new one by the old key is broken
    await sleep(3200); // a later beacon round than the rotation's receipts
    const rot = await (await fetch(`${world.url}/api/devices/${cam.saved.aid}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rotate", reason: "phone lost" }) })).json();
    expect(rot.rotatedAt).toBeGreaterThan(0);
    expect((await cam.status()).current).toBe(false);
    await sleep(3200);
    const after = await cam.shoot(jpegPhoto(256, 128, 6), { sensor: { type: "camera", pipeline: "test" }, app: { name: "capture-camera", version: "0.1.0" } });
    const a2 = await cam.anchor([after]);
    expect(a2.witnessed).toBe(0);
    const r2 = await verifyAsset(embedStore(jpegPhoto(256, 128, 6), after.store), null, { ...ctx, now: Date.now() });
    expect(r2.verdict).toBe("broken");
    expect(codes(r2, "fail")).toContain("key.usedAfterRetirement");
    const r3 = await verifyAsset(embedStore(file, shot.store), null, { ...ctx, now: Date.now() });
    expect(r3.verdict).toBe("verified");
    expect(codes(r3, "ok")).toContain("key.retiredAfter");
  });

  it("built-in sensors stream readings over the simulated radio; the dashboard's checks verify them; loss, evil and backfill work", async () => {
    await sleep(6000);
    const feed = async () => {
      const s = await (await fetch(`${world.url}/api/sensors`)).json();
      const f = await (await fetch(`${world.url}/api/sensors/frames`)).json();
      return verifySensorFeed({ sensors: s.sensors, frames: f.frames, rounds: f.rounds, gateway: s.gateway }, { chains: [chainFromJson(config.drand.chain)], keyLog: httpFetcher(world.url).keyLog, trust, now: Date.now() });
    };
    const checks = await feed();
    expect(checks.map((c) => c.sensor.label).sort()).toEqual(["Riverside 4", "Rooftop 2"]);
    for (const c of checks) {
      expect(c.keyLog).toBe("ok");
      expect(c.installation?.ok).toBe(true);
      expect(c.readings.readings.filter((x) => x.status === "verified").length).toBeGreaterThan(3);
      expect(c.readings.readings.some((x) => x.status === "invalid")).toBe(false);
    }
    // Rooftop 2's clock is a day behind
    const rooftop = checks.find((c) => c.sensor.label === "Rooftop 2")!;
    // (a reading made before the sensor heard its first beacon has no lower bound, so a slow clock can't be shown there)
    const proven = rooftop.readings.readings.filter((x) => x.status === "verified" && x.notBefore !== undefined);
    expect(proven.length).toBeGreaterThan(0);
    expect(proven.every((x) => x.clockWrong)).toBe(true);
    const riverside = checks.find((c) => c.sensor.label === "Riverside 4")!;
    expect(riverside.readings.readings.filter((x) => x.status === "verified").some((x) => x.clockWrong)).toBe(false);

    // an evil gateway: the next reading it hears becomes invalid
    await fetch(`${world.url}/api/sensors/evil`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) });
    await sleep(3500);
    const evil = await feed();
    expect(evil.some((c) => c.readings.readings.some((x) => x.status === "invalid"))).toBe(true);
  });

  it("an external sensor process joins over the radio bridge, and keeps its chain across a restart", async () => {
    const sdir = join(dir, "ext-sensor");
    const clock = new SystemClock();
    const post = async (path: string, body: unknown) => (await fetch(`${world.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const open = () =>
      openSensor({
        dir: sdir,
        name: "Harbor 1",
        clock,
        enroll: async () => (await post("/api/sensors/enroll", { name: "Harbor 1" })) as Enrollment,
        registered: async (aid) => {
          const r = await post("/api/sensors/registered", { aid, node: "harbor-1", installation: { station: "Harbor 1", location: { lat: 40.7, lon: -74.01, method: "owner-declared" }, installedAt: clock.iso(), channels: [] } });
          if (r.error) throw new Error(r.error);
        },
      });
    const harborCheck = async () => {
      const s = await (await fetch(`${world.url}/api/sensors`)).json();
      const f = await (await fetch(`${world.url}/api/sensors/frames`)).json();
      const checks = await verifySensorFeed({ sensors: s.sensors, frames: f.frames, rounds: f.rounds, gateway: s.gateway }, { chains: [chainFromJson(config.drand.chain)], keyLog: httpFetcher(world.url).keyLog, trust, now: Date.now() });
      return checks.find((c) => c.sensor.label === "Harbor 1")!;
    };
    const run = async (ms: number, during?: () => Promise<void>) => {
      const ident = await open();
      const link = new RemoteSimLink(world.url, "harbor-1");
      const node = new SensorNode(ident.chain, { link, scheduler: realScheduler, channels: simulatedChannels(9), intervalMs: 1000, startDelayMs: 300, sealEvery: 3, onChange: () => ident.save() });
      await node.start();
      await sleep(ms);
      await during?.();
      node.stop();
      await link.close();
      ident.save();
      return ident;
    };
    const first = await run(6000);
    const seqAfterFirst = first.chain.state.seq;
    expect(seqAfterFirst).toBeGreaterThan(3);
    // the second run also answers a backfill request that comes down the bridge, for frames lost to collisions
    const second = await run(4000, async () => {
      const { backfillRanges, b64 } = await import("../src/core");
      for (let i = 0; i < 3; i++) {
        const h = await harborCheck();
        const ranges = backfillRanges(h.readings);
        if (!ranges.length) break;
        await fetch(`${world.url}/api/sensors/backfill`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: b64(first.chain.state.dev), ranges }) });
        await sleep(2500);
      }
    });
    expect(second.did).toBe(first.did);
    expect(second.chain.state.seq).toBeGreaterThan(seqAfterFirst);
    const harbor = await harborCheck();
    expect(harbor.readings.readings.filter((x) => x.status === "verified").length).toBeGreaterThan(3);
    expect(harbor.readings.equivocation).toBe(false);
  });
});
