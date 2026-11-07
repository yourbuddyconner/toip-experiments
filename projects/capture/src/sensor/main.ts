/**
 * npm run sensor --workspace @toip-tools/capture -- [--name "Harbor 1"] [--lat 40.70 --lon -74.01]
 *        [--world http://localhost:4350] [--interval 5] [--seal-every 6] [--clock-skew-hours -24]
 *
 * A sensor in its own process, with a software key file (key class S). It enrolls with the world's owner
 * the first time, then streams signed readings over the world's simulated LoRa medium to the gateway.
 * Its key, key log and reading chain are kept in projects/capture/.data/sensor-<name>/, so a restart
 * continues the same chain.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SystemClock } from "@toip-tools/trust-core";
import { realScheduler } from "@toip-tools/mesh-transport";
import { openSensor, type Enrollment } from "../sensors/device";
import { SensorNode, simulatedChannels } from "../sensors/node";
import { RemoteSimLink } from "../sensors/remoteLink";

const { values: a } = parseArgs({
  options: {
    name: { type: "string", default: "Harbor 1" },
    lat: { type: "string", default: "40.7003" },
    lon: { type: "string", default: "-74.0122" },
    world: { type: "string", default: process.env.CAPTURE_WORLD ?? `http://localhost:${process.env.CAPTURE_PORT ?? 4350}` },
    interval: { type: "string", default: "5" },
    "seal-every": { type: "string", default: "6" },
    "clock-skew-hours": { type: "string", default: "0" },
    data: { type: "string" },
  },
});
const name = a.name!;
const world = a.world!.replace(/\/$/, "");
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${world}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
  return j;
};

try {
  await fetch(`${world}/api/config`);
} catch {
  console.error(`Can't reach the Capture world at ${world}. Start it first: npm run app --workspace @toip-tools/capture`);
  process.exit(1);
}

const clock = new SystemClock();
const ident = await openSensor({
  dir: a.data ?? join(import.meta.dirname, "..", "..", ".data", `sensor-${slug}`),
  name,
  clock,
  enroll: async () => (await post("/api/sensors/enroll", { name })) as Enrollment,
  registered: async (aid) => {
    await post("/api/sensors/registered", {
      aid,
      node: slug,
      installation: { station: name, location: { lat: Number(a.lat), lon: Number(a.lon), accuracyM: 10, method: "owner-declared" }, installedAt: clock.iso(), channels: [] },
    });
  },
  log: console.log,
});
const link = new RemoteSimLink(world, slug);
const node = new SensorNode(ident.chain, {
  link,
  scheduler: realScheduler,
  channels: simulatedChannels(Math.floor(Math.random() * 1e6)),
  intervalMs: Number(a.interval) * 1000,
  startDelayMs: Math.floor(Math.random() * Number(a.interval) * 1000),
  sealEvery: Number(a["seal-every"]),
  clockSkewMs: Number(a["clock-skew-hours"]) * 3_600_000,
  onChange: () => ident.save(),
  log: (s) => console.log(`  ${s}`),
});
await node.start();
console.log(`
  Sensor "${name}" (${ident.did})
  sending to ${world} over the simulated LoRa link, a reading every ${a.interval} s, a seal every ${a["seal-every"]}.
  Its next reading is #${ident.chain.state.seq}. Stop with Ctrl-C.
`);
let last = 0;
setInterval(() => {
  if (node.stats.readings !== last) console.log(`  readings ${node.stats.readings}, seals ${node.stats.seals}, beacons heard ${node.stats.beaconsHeard}, backfilled ${node.stats.backfilled}`);
  last = node.stats.readings;
}, 30_000).unref();
const stop = async () => {
  node.stop();
  ident.save();
  await link.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
