import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realScheduler } from "@toip-tools/mesh-transport";
import { SystemClock } from "@toip-tools/trust-core";
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
  type SensorCheck,
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

/** Polls until `ok` holds, or fails after `ms` with what it was waiting for. Real time on a loaded machine varies; the outcome mustn't. */
async function waitFor<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  for (;;) {
    last = await get();
    if (ok(last)) return last;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(750);
  }
}

const post = async (path: string, body: unknown) => (await fetch(`${world.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

async function feed(): Promise<SensorCheck[]> {
  const s = await (await fetch(`${world.url}/api/sensors`)).json();
  const f = await (await fetch(`${world.url}/api/sensors/frames`)).json();
  return verifySensorFeed({ sensors: s.sensors, frames: f.frames, rounds: f.rounds, gateway: s.gateway }, { chains: [chainFromJson(config.drand.chain)], keyLog: httpFetcher(world.url).keyLog, trust, now: Date.now() });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capture-world-"));
  // no collisions between the sensors, and a fixed loss seed: what's lost is decided by the test, not by timing
  world = await startWorld({ port: 0, dataDir: dir, drand: "dev", web: "none", sensorIntervalMs: 1000, sealEvery: 3, beaconEveryMs: 1500, collisions: false, radioSeed: 1 });
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
  }, 120_000);

  it("built-in sensors stream readings over the simulated radio; the dashboard's checks verify them; a dishonest gateway is caught", async () => {
    const verified = (c: SensorCheck) => c.readings.readings.filter((x) => x.status === "verified");
    const rooftopProven = (cs: SensorCheck[]) => verified(cs.find((c) => c.sensor.label === "Rooftop 2")!).filter((x) => x.notBefore !== undefined);
    const checks = await waitFor(
      "both built-in sensors to have more than 3 verified readings, and Rooftop 2 one with a beacon",
      feed,
      (cs) => cs.length === 2 && cs.every((c) => verified(c).length > 3) && rooftopProven(cs).length > 0,
    );
    expect(checks.map((c) => c.sensor.label).sort()).toEqual(["Riverside 4", "Rooftop 2"]);
    for (const c of checks) {
      expect(c.keyLog).toBe("ok");
      expect(c.installation?.ok).toBe(true);
      expect(c.readings.readings.some((x) => x.status === "invalid")).toBe(false);
      expect(c.readings.equivocation).toBe(false);
    }
    // Rooftop 2's clock is a day behind
    // (a reading made before the sensor heard its first beacon has no lower bound, so a slow clock can't be shown there)
    expect(rooftopProven(checks).every((x) => x.clockWrong)).toBe(true);
    const riverside = checks.find((c) => c.sensor.label === "Riverside 4")!;
    expect(verified(riverside).some((x) => x.clockWrong)).toBe(false);

    // a dishonest gateway: the next reading it hears is changed, and becomes invalid once its seal arrives
    await post("/api/sensors/evil", { on: true });
    await waitFor("a reading changed by the gateway to show as invalid", feed, (cs) => cs.some((c) => c.readings.readings.some((x) => x.status === "invalid")));
  }, 120_000);

  it("an external sensor process joins over the radio bridge, and keeps its chain across a restart", async () => {
    await post("/api/sensors/evil", { on: false });
    const sdir = join(dir, "ext-sensor");
    const clock = new SystemClock();
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
    const harborCheck = async () => (await feed()).find((c) => c.sensor.label === "Harbor 1");
    const start = async () => {
      const ident = await open();
      const link = new RemoteSimLink(world.url, "harbor-1");
      const node = new SensorNode(ident.chain, { link, scheduler: realScheduler, channels: simulatedChannels(9), intervalMs: 1000, startDelayMs: 300, sealEvery: 3, onChange: () => ident.save() });
      await node.start();
      const stop = async () => {
        node.stop();
        await link.close();
        ident.save();
      };
      return { ident, node, stop };
    };

    // first run: some readings, then stop (the last ones may not be sealed yet)
    const first = await start();
    await waitFor("the sensor's first run to take 6 readings", async () => first.ident.chain.state.seq, (n) => n >= 6);
    await first.stop();
    const seqAfterFirst = first.ident.chain.state.seq;

    // second run: the same identity and chain from disk; two of its readings are lost on the air, on purpose
    world.medium.inject({ kind: "drop", from: "harbor-1", match: (b) => b[0] === 1, count: 2 });
    const second = await start();
    expect(second.ident.did).toBe(first.ident.did);
    expect(second.ident.chain.state.seq).toBe(seqAfterFirst);
    const { backfillRanges, b64 } = await import("../src/core");
    // ask for backfill over the bridge until every sealed reading is linked, across the restart
    const harbor = await waitFor(
      "Harbor 1's readings on both sides of the restart to verify, with the lost ones backfilled",
      async () => {
        const h = await harborCheck();
        if (!h) return undefined;
        const ranges = backfillRanges(h.readings);
        if (ranges.length) await post("/api/sensors/backfill", { dev: b64(first.ident.chain.state.dev), ranges });
        return { h, ranges };
      },
      (x) => {
        if (!x || x.ranges.length) return false;
        const v = new Set(x.h.readings.readings.filter((r) => r.status === "verified").map((r) => r.seq));
        // the last reading before the restart and the first after it link up: one chain, no fork
        return v.size > 3 && v.has(seqAfterFirst - 1) && v.has(seqAfterFirst) && second.ident.chain.state.seq >= seqAfterFirst + 6;
      },
    );
    await second.stop();
    expect(second.node.stats.backfilled).toBeGreaterThan(0);
    expect(harbor!.h.readings.equivocation).toBe(false);
    expect(harbor!.h.readings.readings.some((r) => r.status === "invalid" || r.status === "equivocation")).toBe(false);
  }, 120_000);
});
