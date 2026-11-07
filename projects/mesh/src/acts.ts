/**
 * The demo's three acts on the simulator (design §17), each a function that returns its Trace:
 *
 *   1. A guest pass checked at a door with no internet, then a replay attack.
 *   2. A Settle attestation from a cabin, over a relay node to a gateway, which posts the exact TSP
 *      bytes to a real relay; the landlord's agent accepts it.
 *   3. The gateway is down: the same kind of message leaves as a sealed bundle file, carried by hand.
 *
 * Time is virtual (VirtualScheduler), so an act runs in a fraction of a second and the same seed gives
 * the same frames. The relay is real (a WebSocket server on this machine); while a post to it is out,
 * virtual time stands still.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshGateway, MeshTransport, US915_DOWN, US915_UP, memoryGatewayStore, openBundle, postBundle, regions, type LoRaSetting } from "@zk-toip/mesh-transport";
import { SimMedium, VirtualScheduler, type SimLink, type SimRadioParams } from "@zk-toip/mesh-transport/sim";
import { startRelay, type Relay } from "@zk-toip/relay";
import { DemoClock, Endpoint, RelayTransport, StatusList, ctt1, memoryReplayStore, utf8, type Identity, type Transport } from "@zk-toip/trust-core";
import { CAST, member } from "./cast";
import { Door, Guest, OFFLINE_FRESHNESS, nextChallenge, type DoorEvent } from "./door";
import { issuePass, type DoorCache, type GuestPass } from "./pass";
import { Recorder, type RecorderHooks } from "./recorder";
import { ESCROW_ATTEST, SettleParty, attest, demoTerms } from "./settle";
import { fmtBytes, fmtMs, type Fact, type Trace } from "./trace";

/** A Friday lunchtime: inside Rosa's pass window. */
export const DEMO_START = Date.parse("2026-11-06T12:04:00.000Z");

export interface ActOptions extends RecorderHooks {
  /** Frame loss on every radio link, 0 to 0.9. */
  loss?: number;
  seed?: number;
  /** Act 1: end with the replay attack (default true). */
  replay?: boolean;
  /** Acts 2 and 3: a relay to use. By default each act starts its own on this machine. */
  relayUrl?: string;
  /** Act 3: where the "USB stick" is. By default a temporary directory, removed afterwards. */
  usbDir?: string;
  startMs?: number;
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const settingName = (s: LoRaSetting) => `${(s.frequencyHz / 1e6).toFixed(1)} MHz SF${s.spreadingFactor} ${s.bandwidthHz / 1000} kHz`;

/** A small seeded generator, for the mesh's jitter. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function until(cond: () => boolean, ms = 10_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const contains = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).indexOf(Buffer.from(needle)) >= 0;
const equalBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && Buffer.from(a).equals(Buffer.from(b));
const checkLoss = (loss: number) => {
  if (!(loss >= 0 && loss <= 0.9)) throw new RangeError("loss must be between 0 and 0.9");
  return loss;
};

// ---------------------------------------------------------------- act 0: what happened online, earlier

export interface Act0 {
  pass: GuestPass;
  cache: DoorCache;
}

/**
 * Online, earlier: the Building issues Rosa's pass key a guest pass for the Front Door, and the door caches
 * the Building's DID and its signed revocation list. `revoked` lists revoked indexes (Rosa's is 7).
 */
export function act0(o: { atMs: number; revoked?: number[]; days?: string; hours?: string; validUntil?: string; timeZone?: string }): Act0 {
  const building = member("building");
  const clock = new DemoClock(new Date(o.atMs).toISOString());
  const pass = issuePass(building, clock, {
    holder: member("rosa").did,
    door: member("door").did,
    label: "dog walker",
    household: "4B",
    days: o.days ?? "Mon-Fri",
    hours: o.hours ?? "12:00-14:00",
    validUntil: o.validUntil ?? "2026-12-31T23:59:59Z",
    statusIndex: 7,
  });
  const list = new StatusList(256);
  for (const i of o.revoked ?? [3]) list.revoke(i);
  return { pass, cache: { building: building.did, statusList: list.sign(building, clock), maxListAgeMs: 24 * 3600_000, timeZone: o.timeZone ?? "UTC" } };
}

// ---------------------------------------------------------------- act 1: the door

/** us915-b, as on the hardware: the door (the miner) sends on 923.3 MHz and listens on 904.6; nodes the other way. */
const DOOR_RADIO: SimRadioParams = { setting: { tx: US915_DOWN, rx: [US915_UP] }, mtu: 250, budget: regions.us915, turnaroundMs: 250 };
export const NODE_RADIO: SimRadioParams = { setting: { tx: US915_UP, rx: [US915_DOWN] }, mtu: 250, budget: regions.us915, turnaroundMs: 300, serialLatencyMs: 10 };
/** A listener with a receiver on both frequencies: it hears everything said near the door. */
const LISTENER_RADIO: SimRadioParams = { setting: { tx: US915_UP, rx: [US915_UP, US915_DOWN] }, mtu: 250, budget: regions.us915, turnaroundMs: 10 };

const hourBudget = (p: SimRadioParams) => p.budget.maxFraction * 3600_000;
const txOf = (p: SimRadioParams) => ("tx" in p.setting ? p.setting.tx : p.setting);

export interface DoorWorld {
  sched: VirtualScheduler;
  medium: SimMedium;
  rec: Recorder;
  setup: Act0;
  door: Door;
  doorMesh: MeshTransport;
  doorLink: SimLink;
  guest: Guest;
  guestMesh: MeshTransport;
  eve: SimLink;
  /** Frames the listener heard. */
  overheard: Uint8Array[];
  /** Restarts the door on the same radio: a new mesh (its seen list is gone) and a new Endpoint. */
  reboot(opts: { keepReplayRecord: boolean }): Promise<Door>;
  stop(): Promise<void>;
}

export async function doorWorld(o: ActOptions & { setup?: Act0 } = {}): Promise<DoorWorld> {
  const loss = checkLoss(o.loss ?? 0);
  const seed = o.seed ?? 1;
  const sched = new VirtualScheduler(o.startMs ?? DEMO_START);
  const medium = new SimMedium({ scheduler: sched, seed });
  const rec = new Recorder(sched, o);
  rec.watch(medium);
  const [building, rosa, doorId] = [member("building"), member("rosa"), member("door")];
  const setup = o.setup ?? act0({ atMs: sched.now() - 3 * 3600_000 });

  const radio = (p: SimRadioParams) => ({ budgetMsPerHour: hourBudget(p), setting: settingName(txOf(p)), maxFrameMs: p.budget.maxFrameMs });
  rec.node({ id: "rosa", label: CAST.rosa, role: "guest", x: 250, y: 360, radio: radio(NODE_RADIO), note: "pass key on her laptop, with a RAK3172" }, rosa);
  rec.node({ id: "door", label: CAST.door, role: "door", x: 700, y: 290, radio: radio(DOOR_RADIO), note: "kiosk, offline; the RAK miner is its radio" }, doorId);
  rec.node({ id: "eve", label: CAST.eve, role: "listener", x: 470, y: 520, radio: radio(LISTENER_RADIO), note: "hears both frequencies" });
  rec.node({ id: "building", label: CAST.building, role: "internet", x: 880, y: 80, note: "online this morning; not on the air" }, building);
  rec.link("rosa", "door");
  rec.link("rosa", "eve");
  rec.link("door", "eve");

  const doorLink = medium.node("door", DOOR_RADIO);
  const rosaLink = medium.node("rosa", NODE_RADIO);
  const eve = medium.node("eve", LISTENER_RADIO);
  medium.connect("rosa", "door", { loss, rssi: -64, snr: 8 });
  // The listener has a good antenna: loss is between Rosa and the door, so the replay is the same at any loss.
  medium.connect("rosa", "eve", { rssi: -91, snr: 2, both: false });
  medium.connect("door", "eve", { rssi: -86, snr: 4 });
  const overheard: Uint8Array[] = [];
  eve.onFrame((f) => overheard.push(f.bytes));
  await eve.open();

  let n = 0;
  const doorMeshOf = () =>
    new MeshTransport({ identities: [doorId], links: [doorLink], scheduler: sched, random: rng(seed * 97 + ++n), onEvent: rec.events("door", 250, doorLink.info.airtimeMs) });
  const guestMesh = new MeshTransport({
    identities: [rosa],
    links: [rosaLink],
    scheduler: sched,
    random: rng(seed * 31 + 7),
    onEvent: rec.events("rosa", 250, rosaLink.info.airtimeMs),
    // A person's device never floods: it talks to the door it heard, one hop.
    flood: { maxTtl: 0, relayShare: 0, unknown: "direct" },
  });
  // Rosa's device knows the door's DID from the pass, so it can verify the door's beacons.
  guestMesh.addContact(doorId.did);
  const doorEvent = (e: DoorEvent) => {
    if (e.type === "opened") rec.say("door", `opened: a valid pass from household ${e.household}, "${e.pass}", within its window, and the challenge signed by the pass key`, "ok");
    else if (e.type === "refused") rec.say("door", `refused: ${e.reason}`, "bad");
    else rec.say("door", `that presentation was already used (document ${e.docId.slice(9, 17)}…): its replay record says so. Not opened again`, "ok");
  };
  let replayStore = memoryReplayStore();
  let doorMesh = doorMeshOf();
  const mkDoor = () => new Door({ identity: doorId, mesh: doorMesh, clock: sched, cache: setup.cache, replayStore, onEvent: doorEvent, tap: (t) => rec.tap(t) });
  let door = mkDoor();
  const guest = new Guest({ identity: rosa, mesh: guestMesh, clock: sched, tap: (t) => rec.tap(t) });
  await doorMesh.start();
  await guestMesh.start();

  const w: DoorWorld = {
    sched,
    medium,
    rec,
    setup,
    door,
    doorMesh,
    doorLink,
    guest,
    guestMesh,
    eve,
    overheard,
    async reboot({ keepReplayRecord }) {
      door.stop();
      await doorMesh.stop();
      if (!keepReplayRecord) replayStore = memoryReplayStore();
      doorMesh = doorMeshOf();
      door = mkDoor();
      await doorMesh.start();
      w.door = door;
      w.doorMesh = doorMesh;
      door.start();
      return door;
    },
    async stop() {
      door.stop();
      guest.close();
      await doorMesh.stop();
      await guestMesh.stop();
    },
  };
  return w;
}

/** Act 1: Rosa presents her pass to the Front Door, which has no internet. Then a listener replays her frames. */
export async function act1(o: ActOptions = {}): Promise<Trace> {
  const loss = o.loss ?? 0;
  const w = await doorWorld(o);
  const { sched, rec } = w;
  const [rosa, doorId, building] = [member("rosa"), member("door"), member("building")];
  const facts: Fact[] = [];
  let ok = false;
  try {
    rec.say("building", `online, this morning: issued Rosa's pass key a guest pass: "dog walker" for household 4B, Front Door, Mon-Fri 12:00-14:00. The door cached the Building's DID and its signed revocation list.`, "step");
    rec.say("door", `offline. Plan us915-b: transmits on 923.3 MHz, listens on 904.6 MHz, SF8 at 500 kHz. ${loss ? `Frame loss ${Math.round(loss * 100)}%.` : "No frame loss."}`, "info");
    w.door.start();
    const beacon = await sched.run(nextChallenge(w.guestMesh, doorId.did, 120_000));
    const beaconFrame = w.rec.frames.find((f) => f.type === "beacon" && f.from === "door")!;
    rec.say("rosa", `heard the door's beacon: challenge ${hex(beacon.nonce!)}, signed by the Front Door (its key is in the pass)`, "info");
    const startAir = rec.airtime();
    const startFrames = rec.frames.length;
    const answer = await sched.run(w.guest.present(doorId.did, w.setup.pass, beacon.nonce!, 60_000));
    const answeredAt = rec.now;
    ok = answer.open;
    rec.say("rosa", answer.open ? "✓ door/open response {open: true}" : `✗ door/open response {open: false}: ${answer.reason}`, answer.open ? "ok" : "bad");
    // Let the last ACK go out.
    await sched.advance(1500);
    const exchange = rec.frames.slice(startFrames);
    const air = rec.airtime() - startAir + beaconFrame.airtimeMs;
    const presentation = rec.log.find((l) => l.sizes?.what === "door/open")?.sizes;
    const response = rec.log.find((l) => l.sizes?.what === "door/open response")?.sizes;
    facts.push({ label: "Beacon to answer", value: fmtMs(answeredAt - beaconFrame.at) });
    facts.push({ label: "On the air", value: `${fmtMs(air)} in ${exchange.length + 1} frames` });
    if (presentation)
      facts.push({ label: "Presentation", value: `${fmtBytes(presentation.jsonSealed)} as JSON TSP → ${fmtBytes(presentation.packet?.bytes ?? 0)} ${presentation.packet?.kind.toUpperCase()} (${presentation.packet?.frames} frames; ${presentation.jsonFrames} as JSON)` });
    if (response) facts.push({ label: "Response", value: `${fmtBytes(response.jsonSealed)} → ${fmtBytes(response.packet?.bytes ?? 0)} (${response.packet?.frames} frames)` });
    rec.say("rosa", `${fmtMs(air)} on the air, ${fmtMs(answeredAt - beaconFrame.at)} from beacon to answer. As plain JSON TSP the presentation alone would be ${presentation?.jsonFrames ?? "?"} frames.`, "info");

    // What the listener heard.
    const secrets: Uint8Array[] = [rosa, doorId, building].flatMap((i) => [utf8(i.did), i.signingPublic, i.encryptionPublic]);
    secrets.push(utf8("dog walker"), utf8("4B"), utf8(w.setup.pass.id));
    const leaked = w.overheard.filter((f) => secrets.some((s) => contains(f, s))).length;
    facts.push({ label: "A listener heard", value: `${w.overheard.length} frames, ${leaked ? `${leaked} with names or keys` : "no DIDs, keys or names"}` });
    rec.say("eve", `heard ${w.overheard.length} frames: their sizes, and random-looking 4-byte tags. ${leaked ? `${leaked} of them contain a DID, a key or a name.` : "No DIDs, no keys, no pass, no names."}`, leaked ? "bad" : "ok");
    facts.push({ label: "Retries", value: String(rec.retries) });

    if (o.replay !== false) await replayAttack(w, facts);
  } finally {
    await w.stop();
  }
  return rec.trace({
    act: 1,
    title: "A door with no internet",
    subtitle: "A guest pass, checked offline over LoRa",
    plan: "us915-b (SF8, 500 kHz)",
    loss,
    seed: o.seed ?? 1,
    startedAt: new Date(rec.t0).toISOString(),
    ok,
    facts,
  });
}

async function replayAttack(w: DoorWorld, facts: Fact[]): Promise<void> {
  const { sched, rec, medium } = w;
  const opened = () => w.door.events.filter((e) => e.type === "opened").length;
  // Everything Rosa sent that the listener recorded.
  const captured = medium
    .records()
    .filter((r) => r.from === "rosa" && r.results.some((x) => x.to === "eve" && x.ok) && r.bytes[0] === 0xa0)
    .map((r) => r.bytes);
  rec.attacker("eve");
  const play = async () => {
    for (const f of captured) await sched.run(w.eve.send(f));
    await sched.advance(8000);
  };

  await sched.advance(120_000);
  rec.say("eve", `two minutes later, replays the ${captured.length} data frames she recorded from Rosa`, "attack");
  const before = opened();
  const delivered = w.doorMesh.stats().delivered;
  await play();
  const dropped = w.doorMesh.stats().delivered === delivered && opened() === before;
  rec.say("door", dropped ? "has seen those packets: it acknowledges them again, but delivers nothing" : "delivered the replayed packet!", dropped ? "ok" : "bad");

  rec.say("door", "reboots. Its mesh forgets the packets it has seen; its replay record is kept on disk.", "step");
  const d2 = await w.reboot({ keepReplayRecord: true });
  await sched.advance(1000);
  rec.say("eve", "replays the same frames again", "attack");
  await play();
  const dup = d2.events.some((e) => e.type === "duplicate") && !d2.events.some((e) => e.type === "opened");

  rec.say("door", "reboots again, and this time its replay record is lost too.", "step");
  const d3 = await w.reboot({ keepReplayRecord: false });
  await sched.advance(1000);
  rec.say("eve", "replays the same frames a third time", "attack");
  await play();
  const stale = d3.events.some((e) => e.type === "refused" && e.code === "stale-challenge") && !d3.events.some((e) => e.type === "opened");
  facts.push({ label: "Replay attack", value: dropped && dup && stale ? "refused three ways: seen list, replay record, stale challenge" : "NOT refused" });
}

// ---------------------------------------------------------------- acts 2 and 3: the cabin

/** us915-a: one frequency, so the Ridge can relay between the cabin and the Lodge. */
const ONE_FREQ = (turnaroundMs: number): SimRadioParams => ({ setting: US915_UP, mtu: 250, budget: regions.us915, turnaroundMs });

interface CabinWorld {
  sched: VirtualScheduler;
  medium: SimMedium;
  rec: Recorder;
  relayUrl: string;
  aliceMesh: MeshTransport;
  alice: Endpoint;
  /** What Alice's Endpoint posted, in order. */
  sent: Uint8Array[];
  landlord: SettleParty;
  /** What reached the landlord's agent from the relay, in order. */
  received: Uint8Array[];
  gateway?: MeshGateway;
  /** Custody receipts Alice got. */
  custody(): number;
  /** Resolves at Alice's next custody receipt. */
  nextCustody(): Promise<void>;
  stop(): Promise<void>;
}

async function connected(t: RelayTransport): Promise<void> {
  await until(() => t.status === "connected", 10_000, "the relay connection");
}

async function cabinWorld(o: ActOptions & { lodgeUp: boolean; courier?: boolean }): Promise<CabinWorld> {
  const loss = checkLoss(o.loss ?? 0);
  const seed = o.seed ?? 1;
  const sched = new VirtualScheduler(o.startMs ?? DEMO_START);
  const medium = new SimMedium({ scheduler: sched, seed });
  const rec = new Recorder(sched, o);
  rec.watch(medium);
  const [alice, ridge, lodge, landlord, neighbor] = [member("alice"), member("ridge"), member("lodge"), member("landlord"), member("neighbor")];
  const cleanups: (() => unknown)[] = [];
  let relay: Relay | undefined;
  let relayDir: string | undefined;
  if (!o.relayUrl) {
    relayDir = mkdtempSync(join(tmpdir(), "mesh-relay-"));
    relay = await startRelay({ port: 0, dbPath: join(relayDir, "relay.db") });
  }
  const relayUrl = o.relayUrl ?? relay!.url;

  const radios = { alice: ONE_FREQ(300), ridge: ONE_FREQ(50), lodge: ONE_FREQ(250) };
  const radio = (p: SimRadioParams) => ({ budgetMsPerHour: hourBudget(p), setting: settingName(txOf(p)), maxFrameMs: p.budget.maxFrameMs });
  rec.node({ id: "alice", label: CAST.alice, role: "tenant", x: 120, y: 430, radio: radio(radios.alice), note: "at a cabin with no signal" }, alice);
  rec.node({ id: "ridge", label: CAST.ridge, role: "relay", x: 420, y: 170, radio: radio(radios.ridge), note: "a solar relay node" }, ridge);
  rec.node({ id: "lodge", label: CAST.lodge, role: "gateway", x: 700, y: 360, radio: radio(radios.lodge), note: o.lodgeUp ? "a gateway with internet" : "a gateway, down: power cut" }, lodge);
  rec.node({ id: "relay", label: CAST.relay, role: "internet", x: 880, y: 110, note: "on the internet" });
  rec.node({ id: "landlord", label: CAST.landlord, role: "party", x: 900, y: 500, note: "a Settle party, online at home" }, landlord);
  if (o.courier) rec.node({ id: "neighbor", label: CAST.neighbor, role: "courier", x: 420, y: 530, note: "driving to town" }, neighbor);
  rec.link("alice", "ridge");
  rec.link("ridge", "lodge");

  // The landlord's agent, online.
  const received: Uint8Array[] = [];
  const landlordRelay = new RelayTransport({ url: relayUrl, identity: landlord });
  const inbound: Transport = {
    attach: (vid, fn) =>
      landlordRelay.attach(vid, (wire) => {
        received.push(wire);
        rec.hop("relay", "landlord", "internet", wire.length, "delivered");
        return fn(wire);
      }),
    detach: (vid) => landlordRelay.detach(vid),
    post: (f, t, w) => landlordRelay.post(f, t, w),
  };
  const party = new SettleParty({
    identity: landlord,
    transport: inbound,
    clock: sched,
    onAccepted: (a) => rec.say("landlord", `received settle/escrow/attest from Alice, through the relay, as an ordinary TSP message. It verifies as Settle checks it: accepted "${a.claim === "complete" ? "work complete" : "not complete"}" for "${a.purpose}"`, "ok"),
    onIgnored: (why) => rec.say("landlord", `ignored ${why}`, "bad"),
  });
  landlordRelay.start();
  cleanups.push(() => party.close(), () => landlordRelay.stop());

  const links = { alice: medium.node("alice", radios.alice), ridge: medium.node("ridge", radios.ridge), lodge: medium.node("lodge", radios.lodge) };
  medium.connect("alice", "ridge", { loss, rssi: -104, snr: -3 });
  medium.connect("ridge", "lodge", { loss, rssi: -98, snr: 1 });
  const ev = (id: string) => rec.events(id, 250, links.alice.info.airtimeMs);
  let custody = 0;
  const custodyWaiters: (() => void)[] = [];
  const aliceMesh = new MeshTransport({
    identities: [alice],
    links: [links.alice],
    scheduler: sched,
    random: rng(seed * 13 + 1),
    gateways: [{ vid: lodge.did }],
    // A phone waits for a gateway rather than flooding the valley for someone it never heard.
    flood: { maxTtl: 3, relayShare: 0.3, unknown: "off" },
    onEvent: (e) => {
      if (e.type === "custody") {
        custody++;
        for (const fn of custodyWaiters.splice(0)) fn();
      }
      ev("alice")(e);
    },
  });
  const ridgeMesh = new MeshTransport({ identities: [ridge], links: [links.ridge], scheduler: sched, random: rng(seed * 13 + 2), relay: true, gateways: [{ vid: lodge.did }], onEvent: ev("ridge") });
  const lodgeMesh = new MeshTransport({ identities: [lodge], links: [links.lodge], scheduler: sched, random: rng(seed * 13 + 3), onEvent: ev("lodge") });
  await aliceMesh.start();
  await ridgeMesh.start();
  await lodgeMesh.start();
  cleanups.push(() => aliceMesh.stop(), () => ridgeMesh.stop(), () => lodgeMesh.stop());

  let gateway: MeshGateway | undefined;
  if (o.lodgeUp) {
    const lodgeRelay = new RelayTransport({ url: relayUrl, identity: lodge });
    lodgeRelay.start();
    cleanups.push(() => lodgeRelay.stop());
    await connected(lodgeRelay);
    // The gateway's post to the real relay is real I/O: virtual time waits for it.
    const relayLike = {
      url: relayUrl,
      post: async (from: string, to: string, wire: Uint8Array) => {
        rec.say("lodge", `opened the route block: from Alice to the landlord's agent. Rebuilt the exact TSP message (${fmtBytes(wire.length)}) and posts it to the relay`, "ok");
        rec.hop("lodge", "relay", "internet", wire.length, "the exact TSP bytes");
        const d = await sched.hold(lodgeRelay.post(from, to, wire));
        rec.say("relay", `took it for the landlord's agent: "${d}"`, d === "undelivered" ? "bad" : "info");
        return d;
      },
    };
    gateway = new MeshGateway({ identity: lodge, mesh: lodgeMesh, relay: relayLike, store: memoryGatewayStore(), beaconEveryMs: 60_000 });
    await gateway.start();
    cleanups.push(() => gateway!.stop());
  } else {
    medium.power("lodge", false);
  }
  await connected(landlordRelay);

  const sent: Uint8Array[] = [];
  const outbound = rec.tap(aliceMesh);
  const aliceEp = new Endpoint({
    identity: alice,
    transport: { attach: (v, fn) => outbound.attach(v, fn), detach: (v) => outbound.detach(v), post: (f, t, w) => (sent.push(w), outbound.post(f, t, w)) },
    clock: sched,
    freshness: OFFLINE_FRESHNESS,
    bodyCodecFor: (to) => (aliceMesh.supportsCompact(to) ? ctt1 : undefined),
  });
  cleanups.push(() => aliceEp.close());

  return {
    sched,
    medium,
    rec,
    relayUrl,
    aliceMesh,
    alice: aliceEp,
    sent,
    landlord: party,
    received,
    gateway,
    custody: () => custody,
    nextCustody: () => new Promise<void>((r) => custodyWaiters.push(r)),
    async stop() {
      for (const c of cleanups.reverse()) await c();
      await relay?.close();
      if (relayDir) rmSync(relayDir, { recursive: true, force: true });
    },
  };
}

async function sinkTerms(clock: { now(): number; iso(): string; date(): Date }, payment: string, purpose: string, units: bigint) {
  return demoTerms({ payment, purpose, units, payer: member("landlord"), payee: member("joe"), attester: member("alice"), arbiter: member("arbiter"), clock });
}

/** Act 2: Alice attests "work complete" from the cabin. The Lodge's gateway posts the exact TSP bytes to the relay. */
export async function act2(o: ActOptions = {}): Promise<Trace> {
  const loss = o.loss ?? 0;
  const w = await cabinWorld({ ...o, lodgeUp: true });
  const { sched, rec } = w;
  const facts: Fact[] = [];
  let ok = false;
  try {
    const terms = await sinkTerms(sched, "pay-sink-4b", "Fix kitchen sink leak, Unit 4B", 340_000_000n);
    w.landlord.know(terms);
    rec.say("landlord", `online, earlier: agreed Settle terms for "${terms.purpose}", ${terms.amount.display}, with Alice as the attester`, "step");
    rec.say("alice", `at the cabin. No internet, no cell signal. Plan us915-a: one frequency, 904.6 MHz, SF8 at 500 kHz. ${loss ? `Frame loss ${Math.round(loss * 100)}%.` : "No frame loss."}`, "info");
    // Alice's device listens until it hears a gateway (the Lodge beacons once a minute).
    const heard = await sched.run(
      new Promise<boolean>((resolve) => {
        const off = w.aliceMesh.onBeacon((b) => b.role === "gateway" && (off(), resolve(true)));
      }),
      { maxMs: 15 * 60_000 },
    ).catch(() => false);
    await sched.advance(500);
    rec.say("alice", heard ? "heard the Lodge's gateway beacon, repeated by the Ridge (one hop)" : "heard no gateway", heard ? "info" : "bad");
    const attestation = attest(member("alice"), terms, "complete", sched, "Sink fixed; dry after an hour");
    rec.say("alice", `selects "work complete": Settle's attest() signs a settle/attestation, sent as settle/escrow/attest`, "info");
    const startAt = rec.now;
    const startAir = rec.airtime();
    const delivery = await sched.run(w.alice.notify(member("landlord").did, ESCROW_ATTEST, attestation));
    if (!w.custody()) {
      rec.say("alice", `post() → "${delivery}", with no custody receipt yet: the message stays in her outbox and is sent again after a backoff`, "warn");
      await sched.run(w.nextCustody(), { maxMs: 4 * 3600_000 }).catch(() => {});
    } else rec.say("alice", `post() → "${delivery}": the Lodge holds it, and signed for it`, "ok");
    const custodyAt = rec.now;
    await until(() => w.landlord.accepted.length + w.landlord.ignored.length > 0, 10_000, "the landlord's agent");
    await sched.advance(2000);
    const exact = equalBytes(w.sent[0], w.received[0]);
    ok = delivery === "queued" && w.custody() === 1 && w.landlord.accepted.length === 1 && exact;
    rec.say("landlord", exact ? "the TSP bytes it opened are exactly the ones Alice sealed: it can't tell they crossed a radio" : "the bytes differ from what Alice sealed!", exact ? "ok" : "bad");
    const sizes = rec.log.find((l) => l.sizes?.what === "settle/escrow/attest")?.sizes;
    if (sizes) facts.push({ label: "Attestation", value: `${fmtBytes(sizes.jsonSealed)} as JSON TSP → ${fmtBytes(sizes.packet?.bytes ?? 0)} VIA (${sizes.packet?.frames} frames; ${sizes.jsonFrames} as JSON)` });
    facts.push({ label: "To custody", value: `${fmtMs(custodyAt - startAt)}, ${fmtMs(rec.airtime() - startAir)} on the air over two hops` });
    facts.push({ label: "Byte-exact at the relay", value: exact ? "yes" : "no" });
    facts.push({ label: "Accepted by the landlord's agent", value: w.landlord.accepted.length === 1 ? "yes" : "no" });
    facts.push({ label: "Retries", value: String(rec.retries) });
  } finally {
    await w.stop();
  }
  return rec.trace({
    act: 2,
    title: "An attestation from the cabin",
    subtitle: "A Settle attestation over LoRa, through a gateway, to the relay",
    plan: "us915-a (SF8, 500 kHz)",
    loss,
    seed: o.seed ?? 1,
    startedAt: new Date(rec.t0).toISOString(),
    ok,
    facts,
  });
}

/** Act 3: the Lodge is down. Alice's attestation waits in her outbox and leaves as a sealed bundle on a USB stick. */
export async function act3(o: ActOptions = {}): Promise<Trace> {
  const loss = o.loss ?? 0;
  const w = await cabinWorld({ ...o, lodgeUp: false, courier: true });
  const { sched, rec } = w;
  const facts: Fact[] = [];
  const usb = o.usbDir ?? mkdtempSync(join(tmpdir(), "mesh-usb-"));
  let ok = false;
  try {
    const terms = await sinkTerms(sched, "pay-fan-4b", "Replace bathroom fan, Unit 4B", 120_000_000n);
    w.landlord.know(terms);
    rec.say("landlord", `online, earlier: agreed Settle terms for "${terms.purpose}", ${terms.amount.display}, with Alice as the attester`, "step");
    rec.say("lodge", "is down: a power cut. No gateway beacon tonight.", "bad");
    await sched.advance(65_000);
    rec.say("alice", "listened for a minute and heard no gateway", "info");
    const attestation = attest(member("alice"), terms, "complete", sched, "New fan installed and tested");
    rec.say("alice", `selects "work complete" for the fan: Settle's attest() signs a second attestation`, "info");
    const delivery = await sched.run(w.alice.notify(member("landlord").did, ESCROW_ATTEST, attestation));
    rec.say("alice", `post() → "${delivery}": ${w.aliceMesh.pending()} message waiting in the outbox`, delivery === "queued" ? "warn" : "bad");

    const neighbor = member("neighbor");
    const bundle = await w.aliceMesh.exportBundle({ sealTo: neighbor.did });
    const file = join(usb, `alice-${new Date(sched.now()).toISOString().slice(0, 16).replace(/[:T]/g, "")}.toipbundle`);
    writeFileSync(file, bundle);
    rec.hop("alice", "neighbor", "usb", bundle.length, "sealed bundle on a USB stick");
    rec.say("alice", `exported the outbox as a bundle (${fmtBytes(bundle.length)}), sealed to the neighbor's key, onto a USB stick. The message is now marked "carried".`, "ok");
    let sealed = false;
    try {
      await openBundle(bundle);
    } catch {
      sealed = true;
    }
    rec.say("neighbor", sealed ? "takes the stick. Anyone who copies the file without the neighbor's key gets nothing." : "the bundle opened without a key!", sealed ? "info" : "bad");
    await sched.advance(45 * 60_000);
    rec.say("neighbor", "reaches town, 45 minutes later, and has internet", "step");
    const courierRelay = new RelayTransport({ url: w.relayUrl, identity: neighbor });
    courierRelay.start();
    try {
      await connected(courierRelay);
      const items = await openBundle(readFileSync(file), neighbor);
      rec.say("neighbor", `opens the bundle with her key: ${items.length} message for the landlord's agent. She posts Alice's TSP bytes, unchanged, to the relay, signed in as herself.`, "ok");
      rec.hop("neighbor", "relay", "internet", items.reduce((s, i) => s + i.wire.length, 0), "the exact TSP bytes");
      const posted = await postBundle(items, courierRelay);
      rec.say("relay", `took ${posted.posted} of ${items.length}`, posted.posted === items.length ? "info" : "bad");
      await until(() => w.landlord.accepted.length + w.landlord.ignored.length > 0, 10_000, "the landlord's agent");
    } finally {
      courierRelay.stop();
    }
    const exact = equalBytes(w.sent[0], w.received[0]);
    ok = delivery === "queued" && sealed && w.landlord.accepted.length === 1 && exact;
    rec.say("landlord", exact ? "the bytes it opened are exactly the ones Alice sealed at the cabin" : "the bytes differ from what Alice sealed!", exact ? "ok" : "bad");
    const sizes = rec.log.find((l) => l.sizes?.what === "settle/escrow/attest")?.sizes;
    facts.push({ label: "On the air", value: `${rec.frames.length} frames (no gateway, so Alice sent nothing)` });
    facts.push({ label: "Bundle", value: `${fmtBytes(bundle.length)}, sealed to the courier` });
    if (sizes) facts.push({ label: "Attestation", value: `${fmtBytes(sizes.compactSealed)} sealed with CTT1 (${fmtBytes(sizes.jsonSealed)} as JSON)` });
    facts.push({ label: "Byte-exact at the relay", value: exact ? "yes" : "no" });
    facts.push({ label: "Accepted by the landlord's agent", value: w.landlord.accepted.length === 1 ? "yes" : "no" });
  } finally {
    await w.stop();
    if (!o.usbDir) rmSync(usb, { recursive: true, force: true });
  }
  return rec.trace({
    act: 3,
    title: "By hand",
    subtitle: "The gateway is down: a sealed bundle on a USB stick",
    plan: "us915-a (SF8, 500 kHz)",
    loss,
    seed: o.seed ?? 1,
    startedAt: new Date(rec.t0).toISOString(),
    ok,
    facts,
  });
}

export const ACTS = { 1: act1, 2: act2, 3: act3 } as const;
