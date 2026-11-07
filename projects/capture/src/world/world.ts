/**
 * A whole Capture network in one process (design §6, §17): three witnesses, the owner and maker who
 * issue device credentials, the registry, a drand client, the simulated LoRa medium with a gateway and two
 * sensors, and the web app. Every check the web app shows is redone in the browser; this process only
 * carries and finds data, and issues the demo owner's credentials.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { httpWitnessClient, verifyKel, type WitnessClient } from "@toip-tools/eventlog";
import { startWitness } from "@toip-tools/eventlog/node";
import { StatusRegistry, type StatusRegistryState } from "@toip-tools/mandates";
import { plans, realScheduler, regions } from "@toip-tools/mesh-transport";
import { SimMedium, type SimLink } from "@toip-tools/mesh-transport/sim";
import { identityFromSeed, SystemClock, type Clock, type Credential, type Identity } from "@toip-tools/trust-core";
import {
  b64,
  chainJson,
  compactFromStream,
  contentHash,
  decodeStore,
  deviceData,
  deviceDid,
  deviceModelCredential,
  deviceOwnerCredential,
  editorCredential,
  fromB64,
  hex,
  ownerRotate,
  parseManifest,
  recoveryKeys,
  sensorInstallationCredential,
  type Installation,
} from "../core";
import { cameraMandate, sensorMandate } from "../core/mandate";
import { CaptureGateway, heardJson, type HeardFrame } from "../sensors/gateway";
import { openSensor, type Enrollment } from "../sensors/device";
import { SensorNode, simulatedChannels } from "../sensors/node";
import { startDrand, type DrandService } from "./drand";

export const WEB_DIR = join(import.meta.dirname, "..", "..", "web");

export interface WorldOptions {
  /** The web app and API. 0 picks a free port. Default 4350. */
  port?: number;
  /** The witnesses' ports; default port+1, +2, +3 (0 when port is 0). */
  witnessPorts?: number[];
  host?: string;
  web?: "dev" | "static" | "none";
  dataDir: string;
  drand?: "live" | "dev";
  /** Built-in simulated sensors. Default true. */
  sensors?: boolean;
  /** Sensor reading interval (default 5 s) and readings per seal (default 6). */
  sensorIntervalMs?: number;
  sealEvery?: number;
  beaconEveryMs?: number;
  /** Simulated frame collisions between sensors (default true). */
  collisions?: boolean;
  radioSeed?: number;
  log?: (line: string) => void;
}

export interface World {
  url: string;
  appUrl: string;
  witnessUrls: string[];
  dataDir: string;
  drand: DrandService;
  owner: Identity;
  maker: Identity;
  gateway: CaptureGateway;
  medium: SimMedium;
  setLoss(loss: number): void;
  close(): Promise<void>;
}

interface Secrets {
  owner: string;
  maker: string;
  gateway: string;
  drand: string;
  witnesses: string[];
}

interface DeviceRecord {
  aid: string;
  did: string;
  kind: "camera" | "sensor";
  label: string;
  nonce: string;
  rotations: number;
  enrolledAt: string;
  credentials: Credential[];
  mandate?: Record<string, unknown>;
  ownerStatus?: { type: "BitstringStatusListEntry"; statusListIndex: number; statusListCredential: string };
  installation?: Installation;
  retired?: { at: string; reason: string };
  sensorNode?: string;
}

const OWNER_NAME = "Daily Planet photo desk";
const MAKER_NAME = "Capture Labs (demo)";
const MAX_BODY = 8 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json" };

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Routes under /api; ":" is a parameter, passed as parts[1], parts[2]… */
const ROUTES = [
  "GET /config",
  "POST /devices/enroll",
  "POST /devices/:",
  "GET /devices",
  "POST /editors",
  "GET /keylogs/:",
  "GET /status/:",
  "POST /stores",
  "GET /stores/by-hash/:",
  "GET /manifests/:",
  "GET /drand/latest",
  "GET /drand/:/:",
  "GET /sensors",
  "GET /sensors/frames",
  "POST /sensors/loss",
  "POST /sensors/evil",
  "POST /sensors/backfill",
  "POST /sensors/enroll",
  "POST /sensors/registered",
  "POST /air/:/tx",
  "GET /air/:/rx",
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function startWorld(opts: WorldOptions): Promise<World> {
  const log = opts.log ?? (() => {});
  const clock: Clock = new SystemClock();
  const host = opts.host ?? "127.0.0.1";
  const loopbackOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const dir = opts.dataDir;
  mkdirSync(join(dir, "stores"), { recursive: true });
  const p = (name: string) => join(dir, name);

  // ---------------------------------------------------------------- secrets and identities
  const rand = () => hex(crypto.getRandomValues(new Uint8Array(32)));
  const secrets = readJson<Secrets>(p("secrets.json"), { owner: rand(), maker: rand(), gateway: rand(), drand: rand(), witnesses: [rand(), rand(), rand()] });
  writeFileSync(p("secrets.json"), JSON.stringify(secrets, null, 2), { mode: 0o600 });
  const seed = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
  const owner = identityFromSeed(seed(secrets.owner));
  const maker = identityFromSeed(seed(secrets.maker));
  const ownerSeed = seed(secrets.owner);
  const status = new StatusRegistry(owner, clock, readJson<StatusRegistryState | undefined>(p("status.json"), undefined));
  const saveStatus = () => writeJson(p("status.json"), status.save());
  const devices = readJson<Record<string, DeviceRecord>>(p("devices.json"), {});
  const saveDevices = () => writeJson(p("devices.json"), devices);
  const editors = readJson<Record<string, Credential>>(p("editors.json"), {});
  const registry = readJson<{ byHash: Record<string, string>; byManifest: Record<string, string> }>(p("registry.json"), { byHash: {}, byManifest: {} });
  const saveRegistry = () => writeJson(p("registry.json"), registry);

  // ---------------------------------------------------------------- witnesses
  const base = opts.port ?? 4350;
  const wPorts = opts.witnessPorts ?? (base === 0 ? [0, 0, 0] : [base + 1, base + 2, base + 3]);
  const witnesses = await Promise.all(secrets.witnesses.map((s, i) => startWitness({ seed: seed(s), dataPath: p(`witness-${i}.json`), port: wPorts[i], host: "127.0.0.1", clock })));
  const witnessClients: WitnessClient[] = witnesses.map((w) => httpWitnessClient(w.url, w.aid));
  const BT = 2;
  log(`witnesses: ${witnesses.map((w) => w.url).join(", ")}`);

  // ---------------------------------------------------------------- drand
  const drand = await startDrand({ mode: opts.drand ?? "live", devKey: seed(secrets.drand), cachePath: p("drand-cache.json"), log });

  // ---------------------------------------------------------------- key logs, fresh from a witness
  async function streamOf(aid: string): Promise<string> {
    for (const w of witnessClients) {
      try {
        const s = await w.query({ logId: aid });
        if (s) return s;
      } catch {
        // try the next one
      }
    }
    throw new HttpError(404, "no witness holds that key log");
  }
  async function compactLog(aid: string): Promise<Uint8Array> {
    return (await compactFromStream(await streamOf(aid))).bytes;
  }

  // ---------------------------------------------------------------- enrollment and credentials
  function enroll(kind: "camera" | "sensor", label: string): Enrollment {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(12)));
    const rec = recoveryKeys(ownerSeed, nonce);
    pendingEnrollments.set(rec.digest(0), { nonce, kind, label });
    return { nonce, next: rec.digest(0), witnesses: witnesses.map((w, i) => ({ aid: w.aid, url: kind === "camera" ? `/witness/${i}` : w.url })), bt: BT };
  }
  const pendingEnrollments = new Map<string, { nonce: string; kind: "camera" | "sensor"; label: string }>();

  async function register(aid: string, extra: { installation?: Installation; sensorNode?: string } = {}): Promise<DeviceRecord> {
    const known = devices[aid];
    if (known) return known;
    const kel = await verifyKel(await streamOf(aid));
    if (!kel.ok) throw new HttpError(400, `the key log doesn't verify: ${kel.problems.map((x) => x.message).join("; ")}`);
    const st = kel.states[0];
    const pending = pendingEnrollments.get(st.next[0]);
    if (!pending || st.next.length !== 1) throw new HttpError(403, "this key log doesn't commit to a recovery key the owner gave out");
    if (st.witnesses.length < 3 || st.bt < BT || !witnesses.every((w) => st.witnesses.includes(w.aid))) throw new HttpError(400, "the key log must name the world's witnesses");
    pendingEnrollments.delete(st.next[0]);
    const data = deviceData(kel);
    const did = deviceDid(aid);
    const keyClass = String(data.keyClass ?? (pending.kind === "camera" ? "B" : "S")) as "B" | "S";
    const ownerStatus = status.allocate();
    const until = new Date(clock.now() + 365 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
    const credentials: Credential[] = [
      deviceModelCredential(maker, clock, {
        id: did,
        maker: MAKER_NAME,
        model: pending.kind === "camera" ? "Capture Web Camera 0.1" : "Capture Sensor Node 0.1",
        keyClass,
        keyClassEvidence: "self-reported",
      }),
      deviceOwnerCredential(owner, clock, { id: did, ownerName: OWNER_NAME, label: pending.label, scope: [pending.kind === "camera" ? "photo" : "reading"], validUntil: until }, ownerStatus),
    ];
    if (extra.installation) credentials.push(sensorInstallationCredential(owner, clock, did, extra.installation, status.allocate()));
    const mandate =
      pending.kind === "camera"
        ? cameraMandate(owner, clock, status, did, { validUntil: until, purpose: `Photos for ${OWNER_NAME}.` })
        : sensorMandate(owner, clock, status, did, { validUntil: until, quantities: (extra.installation?.channels ?? []).map((c) => c.quantity) });
    saveStatus();
    const rec: DeviceRecord = {
      aid,
      did,
      kind: pending.kind,
      label: pending.label,
      nonce: pending.nonce,
      rotations: 0,
      enrolledAt: clock.iso(),
      credentials,
      mandate: mandate as unknown as Record<string, unknown>,
      ownerStatus,
      ...(extra.installation ? { installation: extra.installation } : {}),
      ...(extra.sensorNode ? { sensorNode: extra.sensorNode } : {}),
    };
    devices[aid] = rec;
    saveDevices();
    log(`enrolled ${pending.kind} "${pending.label}" as ${did}`);
    return rec;
  }

  // ---------------------------------------------------------------- the radio: medium, gateway, sensors
  const sched = realScheduler;
  // collisions: two nodes that transmit at once lose the weaker frame, as on a real channel. Tests turn them off, so what they check doesn't depend on timing luck.
  const medium = new SimMedium({ scheduler: sched, seed: opts.radioSeed ?? Date.now() & 0xffff, captureDb: opts.collisions === false ? -1e9 : 6 });
  const radio = { setting: plans["us915-a"].tx, mtu: 250, budget: regions.us915 };
  const gwSecret = seed(secrets.gateway);
  const gatewayId = `gateway:${hex(sha256(ed25519.getPublicKey(gwSecret))).slice(0, 12)}`;
  const heard: (HeardFrame & { node?: string })[] = [];
  const framesPath = p("frames.jsonl");
  if (existsSync(framesPath)) {
    for (const line of readFileSync(framesPath, "utf8").split("\n")) {
      if (!line) continue;
      const j = JSON.parse(line);
      heard.push({ type: j.type, bytes: fromB64(j.frame), receipt: { gateway: j.receipt.gateway, at: j.receipt.at, sig: fromB64(j.receipt.sig) }, meta: j.meta });
    }
  }
  const broadcastRounds = readJson<Record<string, string>>(p("broadcast-rounds.json"), {});
  let lossNow = 0;
  const nodes = new Set<string>();
  const connect = (name: string) => {
    nodes.add(name);
    medium.connect("gateway", name, { loss: lossNow, rssi: -88 - nodes.size * 7, snr: 7 - nodes.size });
  };
  const gateway = new CaptureGateway({
    link: medium.node("gateway", radio),
    secret: gwSecret,
    id: gatewayId,
    scheduler: sched,
    beaconEveryMs: opts.beaconEveryMs ?? 15_000,
    beacon: () => {
      const b = drand.latest();
      if (!b) return null;
      broadcastRounds[`${b.kind}:${b.round}`] = hex(b.signature);
      return b;
    },
    onFrame: (h) => {
      heard.push(h);
      writeFileSync(framesPath, JSON.stringify(heardJson(h)) + "\n", { flag: "a" });
      if (heard.length > 20_000) heard.splice(0, heard.length - 20_000);
    },
    log,
  });
  await gateway.start();
  const roundsTimer = setInterval(() => writeJson(p("broadcast-rounds.json"), Object.fromEntries(Object.entries(broadcastRounds).slice(-3000))), 10_000);
  roundsTimer.unref?.();

  const running: SensorNode[] = [];
  async function startSimSensor(o: { name: string; installation: Installation; clockSkewMs?: number; seed: number; offset: number; base?: { tempC: number; rh: number; pm: number } }) {
    const node = slug(o.name);
    const ident = await openSensor({
      dir: p(`sensors/${node}`),
      name: o.name,
      clock,
      enroll: async () => enroll("sensor", o.name),
      registered: async (aid) => {
        await register(aid, { installation: o.installation, sensorNode: node });
      },
      log,
    });
    connect(node);
    const sn = new SensorNode(ident.chain, {
      link: medium.node(node, radio),
      scheduler: sched,
      channels: simulatedChannels(o.seed, o.base),
      intervalMs: opts.sensorIntervalMs ?? 5000,
      sealEvery: opts.sealEvery ?? 6,
      clockSkewMs: o.clockSkewMs,
      startDelayMs: Math.round((opts.sensorIntervalMs ?? 5000) * o.offset),
      onChange: () => ident.save(),
      log: (s) => log(`${o.name}: ${s}`),
    });
    await sn.start();
    running.push(sn);
    log(`sensor "${o.name}" on the simulated LoRa link${o.clockSkewMs ? ` (its clock is ${Math.round(o.clockSkewMs / 3_600_000)} h off)` : ""}`);
  }
  const channels = [
    { kind: 1, quantity: "air temperature", unit: "Cel", scale: 0.01, model: "BME280 (simulated)", calibration: { at: "2026-11-01", offset: -0.4, by: owner.did } },
    { kind: 2, quantity: "relative humidity", unit: "%RH", scale: 0.1, model: "BME280 (simulated)" },
    { kind: 4, quantity: "PM2.5", unit: "ug/m3", scale: 0.1, model: "PMS5003 (simulated)" },
  ];
  if (opts.sensors !== false) {
    await startSimSensor({
      name: "Riverside 4",
      seed: 4,
      offset: 0.1,
      installation: { station: "Riverside 4", location: { lat: 40.7128, lon: -74.006, elevationM: 12, accuracyM: 5, method: "owner-surveyed" }, installedAt: "2026-11-06T09:00:00Z", channels },
    });
    await startSimSensor({
      name: "Rooftop 2",
      seed: 2,
      offset: 0.55,
      clockSkewMs: -86_400_000,
      base: { tempC: 11, rh: 55, pm: 14 },
      installation: { station: "Rooftop 2", location: { lat: 40.7306, lon: -73.9866, elevationM: 48, accuracyM: 10, method: "owner-surveyed" }, installedAt: "2026-11-06T09:30:00Z", channels },
    });
  }

  // remote radios (npm run sensor): one SimLink per name, bridged over HTTP
  const remote = new Map<string, { link: SimLink; listeners: Set<ServerResponse> }>();
  function remoteNode(name: string) {
    const node = slug(name);
    if (!node || node === "gateway" || (nodes.has(node) && !remote.has(node))) throw new HttpError(409, "that radio name is taken");
    let r = remote.get(node);
    if (!r) {
      const link = medium.node(node, radio);
      void link.open();
      connect(node);
      const listeners = new Set<ServerResponse>();
      link.onFrame((f) => {
        const data = JSON.stringify({ frame: b64(f.bytes), rssi: f.rssi, snr: f.snr, at: f.atMs });
        for (const res of listeners) res.write(`data: ${data}\n\n`);
      });
      r = { link, listeners };
      remote.set(node, r);
    }
    return r;
  }

  // ---------------------------------------------------------------- HTTP
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  const bin = (res: ServerResponse, body: Uint8Array, type = "application/octet-stream") => res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(Buffer.from(body));

  async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const b = await readBody(req);
    try {
      const v = JSON.parse(b.toString("utf8") || "{}");
      if (!v || typeof v !== "object") throw new Error();
      return v;
    } catch {
      throw new HttpError(400, "expected a JSON object");
    }
  }

  const config = () => ({
    owner: { did: owner.did, name: OWNER_NAME },
    maker: { did: maker.did, name: MAKER_NAME },
    gateway: { id: gatewayId, publicKey: hex(ed25519.getPublicKey(gwSecret)) },
    witnesses: witnesses.map((w, i) => ({ aid: w.aid, url: `/witness/${i}` })),
    bt: BT,
    drand: { mode: drand.mode, chain: chainJson(drand.chain) },
  });

  function sensorList() {
    return Object.values(devices)
      .filter((d) => d.kind === "sensor")
      .map((d) => ({ did: d.did, aid: d.aid, label: d.label, node: d.sensorNode, installation: d.installation, credentials: d.credentials, mandate: d.mandate }));
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<unknown> {
    const segs = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
    let parts: string[] = [];
    let route = "";
    for (const r of ROUTES) {
      const [method, pattern] = r.split(" ");
      const ps = pattern.split("/").filter(Boolean);
      if (method !== req.method || ps.length !== segs.length) continue;
      const params: string[] = [];
      if (ps.every((x, i) => (x === ":" ? params.push(decodeURIComponent(segs[i])) > 0 : x === segs[i]))) {
        route = r;
        parts = [segs[0], ...params];
        break;
      }
    }
    if (req.method === "POST" && !url.pathname.startsWith("/api/air/")) {
      const origin = req.headers.origin;
      if (origin) {
        let same = false;
        try {
          same = new URL(origin).host === req.headers.host;
        } catch {
          same = false;
        }
        if (!same) throw new HttpError(403, "cross-site request refused");
      }
    }
    switch (route) {
      case "GET /config":
        return json(res, 200, config());
      case "POST /devices/enroll": {
        const b = await jsonBody(req);
        const label = String(b.label ?? "").trim().slice(0, 80);
        if (!label) throw new HttpError(400, "give the device a label");
        const kind = b.kind === "sensor" ? "sensor" : "camera";
        return json(res, 200, enroll(kind, label));
      }
      case "POST /devices/:": {
        // /devices/<aid>  with {action}
        const aid = parts[1];
        const b = await jsonBody(req);
        if (b.action === "incepted") {
          const d = await register(aid);
          return json(res, 200, { record: d, statusList: status.sign() });
        }
        const d = devices[aid];
        if (!d) throw new HttpError(404, "unknown device");
        if (b.action === "rotate") {
          const rec = recoveryKeys(ownerSeed, d.nonce);
          const { rot } = await ownerRotate({ aid, stream: await streamOf(aid), recovery: rec.signer(d.rotations), nextRecovery: rec.digest(d.rotations + 1), clock, witnesses: witnessClients });
          d.rotations++;
          d.retired = { at: clock.iso(), reason: String(b.reason ?? "rotated by the owner").slice(0, 200) };
          saveDevices();
          log(`owner rotated ${d.label} (${d.did}) at event ${rot.s}: ${d.retired.reason}`);
          return json(res, 200, { record: d, rotatedAt: rot.s });
        }
        if (b.action === "revoke") {
          if (d.ownerStatus) status.revoke(d.ownerStatus);
          saveStatus();
          return json(res, 200, { record: d, statusList: status.sign() });
        }
        throw new HttpError(400, "unknown action");
      }
      case "GET /devices":
        return json(res, 200, {
          devices: await Promise.all(
            Object.values(devices).map(async (d) => {
              let events: { s: number; t: string; receipts: number; at?: string }[] = [];
              try {
                const kel = await verifyKel(await streamOf(d.aid));
                events = kel.events.filter((e) => e.status === "valid").map((e) => ({ s: e.s, t: e.t, receipts: e.receipts.length, at: e.earliestReceipt }));
              } catch {
                events = [];
              }
              return { ...d, events };
            }),
          ),
        });
      case "POST /editors": {
        const b = await jsonBody(req);
        const did = String(b.did ?? "");
        const name = String(b.name ?? "").trim().slice(0, 80);
        if (!did.startsWith("did:key:") || !name) throw new HttpError(400, "send a did:key and a name");
        const vc = editorCredential(owner, clock, { id: did, name, role: "photo editor", ownerName: OWNER_NAME }, status.allocate());
        saveStatus();
        editors[did] = vc;
        writeJson(p("editors.json"), editors);
        log(`owner vouched for editor ${name} (${did})`);
        return json(res, 200, { credential: vc, statusList: status.sign() });
      }
      case "GET /keylogs/:": {
        const did = parts[1];
        if (!did.startsWith("did:keri:")) throw new HttpError(400, "not a device identifier");
        return bin(res, await compactLog(did.slice("did:keri:".length)));
      }
      case "GET /status/:": {
        const did = parts[1];
        if (did !== owner.did) throw new HttpError(404, "no status list for that issuer here");
        return json(res, 200, status.sign());
      }
      case "POST /stores": {
        const body = new Uint8Array(await readBody(req));
        let store;
        try {
          store = decodeStore(body);
        } catch {
          throw new HttpError(400, "not a capture store");
        }
        const m = store.manifests[store.active];
        const pm = m && parseManifest(m);
        if (!pm || "error" in pm || pm.idText !== store.active) throw new HttpError(400, "the store's active manifest is missing or doesn't match its id");
        const h = hex(pm.claim.content.hash);
        const file = `${h}.capture`;
        writeFileSync(join(dir, "stores", file), body);
        registry.byHash[h] = file;
        for (const id of Object.keys(store.manifests)) registry.byManifest[id] = file;
        saveRegistry();
        log(`registry: published ${store.active} (content ${h.slice(0, 16)}…)`);
        return json(res, 200, { hash: h, id: store.active });
      }
      case "GET /stores/by-hash/:": {
        const h = (parts[1] ?? "").toLowerCase();
        const file = /^[0-9a-f]{64}$/.test(h) ? registry.byHash[h] : undefined;
        if (!file) throw new HttpError(404, "no store for that fingerprint");
        return bin(res, readFileSync(join(dir, "stores", file)));
      }
      case "GET /manifests/:": {
        const id = parts[1];
        const file = registry.byManifest[id];
        if (!file) throw new HttpError(404, "unknown manifest");
        const s = decodeStore(readFileSync(join(dir, "stores", file)));
        return bin(res, s.manifests[id]);
      }
      case "GET /drand/latest": {
        const b = drand.latest();
        if (!b) throw new HttpError(503, "no beacon yet");
        return json(res, 200, { kind: b.kind, round: b.round, randomness: hex(b.randomness), signature: hex(b.signature) });
      }
      case "GET /drand/:/:": {
        const [kind, round] = [parts[1], Number(parts[2])];
        if (kind !== drand.chain.kind || !Number.isSafeInteger(round)) throw new HttpError(404, "unknown chain");
        const r = await drand.round(round);
        if (!r) throw new HttpError(404, "no such round");
        return json(res, 200, { kind, round, signature: hex(r.signature) });
      }
      case "GET /sensors":
        return json(res, 200, { sensors: sensorList(), gateway: config().gateway, loss: lossNow, evil: gateway.evil, nodes: [...nodes], stats: gateway.stats });
      case "GET /sensors/frames": {
        const since = Number(url.searchParams.get("since") ?? 0);
        const out = heard.slice(Math.max(0, since)).map(heardJson);
        return json(res, 200, { next: heard.length, frames: out, rounds: Object.entries(broadcastRounds).map(([k, sig]) => ({ kind: k.split(":")[0], round: Number(k.split(":")[1]), signature: sig })) });
      }
      case "POST /sensors/loss": {
        const b = await jsonBody(req);
        const loss = Math.max(0, Math.min(0.9, Number(b.loss)));
        if (!Number.isFinite(loss)) throw new HttpError(400, "loss is a number between 0 and 0.9");
        setLoss(loss);
        return json(res, 200, { loss });
      }
      case "POST /sensors/evil": {
        const b = await jsonBody(req);
        gateway.evil = !!b.on;
        log(`gateway: evil mode ${gateway.evil ? "on (it will change the next reading it hears)" : "off"}`);
        return json(res, 200, { evil: gateway.evil });
      }
      case "POST /sensors/backfill": {
        const b = await jsonBody(req);
        const dev = fromB64(String(b.dev ?? ""));
        const ranges = (Array.isArray(b.ranges) ? b.ranges : []).slice(0, 8) as [number, number][];
        if (dev.length !== 4) throw new HttpError(400, "dev is 4 bytes, base64");
        for (const [a, z] of ranges) if (Number.isSafeInteger(a) && Number.isSafeInteger(z) && z >= a) void gateway.requestBackfill(dev, a, z);
        log(`gateway: backfill requested for ${ranges.map(([a, z]) => `${a}–${z}`).join(", ")}`);
        return json(res, 200, { requested: ranges.length });
      }
      case "POST /sensors/enroll": {
        const b = await jsonBody(req);
        const name = String(b.name ?? "").trim().slice(0, 60);
        if (!name) throw new HttpError(400, "name the sensor");
        return json(res, 200, enroll("sensor", name));
      }
      case "POST /sensors/registered": {
        const b = await jsonBody(req);
        const inst = b.installation as Installation | undefined;
        if (!inst?.station || typeof inst.location?.lat !== "number") throw new HttpError(400, "send the installation");
        const d = await register(String(b.aid), { installation: { ...inst, channels }, sensorNode: slug(String(b.node ?? inst.station)) });
        return json(res, 200, { record: d });
      }
      case "POST /air/:/tx": {
        const node = remoteNode(parts[1]);
        const b = await jsonBody(req);
        const frame = fromB64(String(b.frame ?? ""));
        if (!frame.length || frame.length > 250) throw new HttpError(400, "a frame is 1 to 250 bytes");
        try {
          await node.link.send(frame);
        } catch (e) {
          throw new HttpError(429, (e as Error).message);
        }
        return json(res, 200, { ok: true });
      }
      case "GET /air/:/rx": {
        const node = remoteNode(parts[1]);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        node.listeners.add(res);
        req.on("close", () => node.listeners.delete(res));
        return;
      }
    }
    throw new HttpError(404, "no such endpoint");
  }

  function setLoss(loss: number) {
    lossNow = loss;
    for (const n of nodes) medium.connect("gateway", n, { loss, rssi: -95, snr: 4 });
    log(`radio: frame loss now ${Math.round(loss * 100)}%`);
  }

  function proxyWitness(req: IncomingMessage, res: ServerResponse, url: URL) {
    const m = url.pathname.match(/^\/witness\/(\d)(\/.*)$/);
    const w = m ? witnesses[Number(m[1])] : undefined;
    if (!m || !w) return json(res, 404, { error: "no such witness" });
    const target = new URL(m[2] + url.search, w.url);
    const pr = httpRequest(target, { method: req.method, headers: { "content-type": String(req.headers["content-type"] ?? "text/plain") } }, (up) => {
      res.writeHead(up.statusCode ?? 502, { "content-type": String(up.headers["content-type"] ?? "application/octet-stream"), "cache-control": "no-store" });
      up.pipe(res);
    });
    pr.on("error", () => json(res, 502, { error: "witness unreachable" }));
    req.pipe(pr);
  }

  let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; close(): Promise<void> } | undefined;
  const distDir = join(WEB_DIR, "dist");
  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(distDir, path);
    if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/witness/")) return proxyWitness(req, res, url);
    if (url.pathname.startsWith("/api/")) {
      try {
        await handleApi(req, res, url);
      } catch (e) {
        const st = e instanceof HttpError ? e.status : 500;
        if (st === 500) log(`error on ${url.pathname}: ${String((e as Error)?.stack ?? e)}`);
        if (!res.headersSent) json(res, st, { error: String((e as Error)?.message ?? e) });
      }
      return;
    }
    if (vite) return vite.middlewares(req, res, () => res.writeHead(404).end());
    if (opts.web === "static") return serveStatic(req, res);
    res.writeHead(404).end("no web app here");
  });
  if (opts.web === "dev") {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), appType: "spa", server: { middlewareMode: true, hmr: { server } }, logLevel: "warn" });
  } else if (opts.web === "static" && !existsSync(join(distDir, "index.html"))) {
    throw new Error("the web app isn't built: run `npm run build:web --workspace @toip-tools/capture`");
  }
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(opts.port ?? 4350, host, () => resolve()));
  const port = (server.address() as { port: number }).port;
  // passkeys and the camera need a secure context; http://localhost is one. Answer on ::1 too, so localhost never reaches another server.
  let server6: Server | undefined;
  if (loopbackOnly && host !== "::1") {
    const s6 = createServer((req, res) => server.emit("request", req, res));
    s6.on("upgrade", (...a) => server.emit("upgrade", ...a));
    const ok = await new Promise<boolean>((resolve) => s6.once("error", () => resolve(false)).listen(port, "::1", () => resolve(true)));
    if (ok) server6 = s6;
    else log(`couldn't also listen on [::1]:${port}; if http://localhost:${port} doesn't open Capture, use http://127.0.0.1:${port}`);
  }
  const appUrl = loopbackOnly ? `http://localhost:${port}` : `http://${host}:${port}`;

  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    appUrl,
    witnessUrls: witnesses.map((w) => w.url),
    dataDir: dir,
    drand,
    owner,
    maker,
    gateway,
    medium,
    setLoss,
    close: async () => {
      clearInterval(roundsTimer);
      for (const s of running) s.stop();
      gateway.stop();
      drand.stop();
      for (const r of remote.values()) for (const l of r.listeners) l.end();
      await vite?.close();
      for (const s of [server, server6]) {
        if (!s) continue;
        s.closeAllConnections?.();
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
      for (const w of witnesses) await w.close();
      writeJson(p("broadcast-rounds.json"), broadcastRounds);
    },
  };
}

export { contentHash };
