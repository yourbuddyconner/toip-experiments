/**
 * The CLI's long-running roles on a real link (or a simulated one in real time): the door, the guest,
 * the gateway, Alice attesting, the landlord's agent receiving, and the two ends of a bundle.
 * Each keeps its state in a directory (contacts, outbox, replay record, custody record), so a restart
 * picks up where it left off.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeshGateway, MeshTransport, exportBundle, openBundle, postBundle, realScheduler, type Link, type MeshEvent } from "@toip-tools/mesh-transport";
import { fileContacts, fileGatewayStore, fileOutbox, fileReplayStore } from "@toip-tools/mesh-transport/node";
import { SimMedium } from "@toip-tools/mesh-transport/sim";
import { Endpoint, RelayTransport, SystemClock, ctt1, resolveDidKey, type Identity } from "@toip-tools/trust-core";
import { act0, hex, until } from "./acts";
import { member, nameOf } from "./cast";
import { Door, Guest, OFFLINE_FRESHNESS, nextChallenge, type DoorAnswer } from "./door";
import { planFor } from "./links";
import { ESCROW_ATTEST, PAYMENTS, SettleParty, attest, demoPayment } from "./settle";
import { fmtBytes, fmtMs } from "./trace";

export type Log = (line: string) => void;

const stamp = () => new Date().toISOString().slice(11, 23);

/** The mesh's events, one line each. */
export function eventPrinter(log: Log): (e: MeshEvent) => void {
  return (e) => {
    switch (e.type) {
      case "frame-out":
        return log(`${stamp()}  ▲ ${e.summary}  ${e.bytes} B  ${fmtMs(e.airtimeMs)}`);
      case "frame-in":
        return log(`${stamp()}  ▼ ${e.summary}  ${e.bytes} B${e.rssi !== undefined ? `  RSSI ${e.rssi} dBm  SNR ${e.snr} dB` : ""}`);
      case "packet-out":
        return log(`${stamp()}  packet ${e.kind.toUpperCase()} ${fmtBytes(e.bytes)} in ${e.frames} frames to ${nameOf(e.to)} (${e.route}), pid ${e.pid}`);
      case "retry":
        return log(`${stamp()}  resends ${e.missing.length} fragment(s) of pid ${e.pid} (round ${e.round + 1})`);
      case "delivered":
        return log(`${stamp()}  delivered pid ${e.pid} to ${nameOf(e.to)} (${e.route})`);
      case "custody":
        return log(`${stamp()}  custody receipt for pid ${e.pid} from ${nameOf(e.gateway)}`);
      case "queued":
        return log(`${stamp()}  pid ${e.pid || "(none)"} waits in the outbox: ${e.reason}`);
      case "budget":
        return e.warning ? log(`${stamp()}  budget: ${e.warning}`) : undefined;
      case "dropped":
        return log(`${stamp()}  dropped: ${e.reason}`);
      default:
        return;
    }
  };
}

const aborted = (signal?: AbortSignal) => new Promise<void>((r) => (signal?.aborted ? r() : signal?.addEventListener("abort", () => r(), { once: true })));

/** The pass and the door's cached state, made the same way in both processes (act 0). */
export function passSetup(o: { days: string; hours: string; timeZone: string }) {
  const now = Date.now();
  return act0({ atMs: now - 3600_000, days: o.days, hours: o.hours, timeZone: o.timeZone, validUntil: new Date(now + 60 * 86400_000).toISOString() });
}

export interface PassWindow {
  days: string;
  hours: string;
  timeZone: string;
}

// ---------------------------------------------------------------- act 1

export async function runDoor(o: { link: Link; stateDir: string; window: PassWindow; log: Log; signal?: AbortSignal; once?: boolean; beaconEveryMs?: number }): Promise<void> {
  const id = member("door");
  const mesh = new MeshTransport({ identities: [id], links: [o.link], contacts: fileContacts(join(o.stateDir, "contacts.json")), onEvent: eventPrinter(o.log) });
  const setup = passSetup(o.window);
  let done!: () => void;
  let decided = false;
  const first = new Promise<void>((r) => (done = r));
  const door = new Door({
    identity: id,
    mesh,
    clock: new SystemClock(),
    cache: setup.cache,
    replayStore: fileReplayStore(join(o.stateDir, "door-replay.json")),
    beaconEveryMs: o.beaconEveryMs ?? 15_000,
    // With --once, stop after the first answer has gone out (and been acknowledged), not when it is decided.
    tap: (t) => ({ attach: (v, fn) => t.attach(v, fn), detach: (v) => t.detach(v), post: async (f, to, w) => { const d = await t.post(f, to, w); if (decided) done(); return d; } }),
    onEvent: (e) => {
      if (e.type === "opened") o.log(`${stamp()}  OPENED: a valid pass from household ${e.household}, "${e.pass}"`);
      else if (e.type === "refused") o.log(`${stamp()}  REFUSED: ${e.reason}`);
      else o.log(`${stamp()}  refused a replay: that presentation was already used`);
      if (e.type !== "duplicate") decided = true;
    },
  });
  await mesh.start();
  door.start();
  o.log(`The Front Door is up: ${id.did}. It beacons a signed challenge every ${Math.round((o.beaconEveryMs ?? 15_000) / 1000)} s. Ctrl-C stops it.`);
  await Promise.race([aborted(o.signal), ...(o.once ? [first] : [])]);
  door.stop();
  await mesh.stop();
}

export async function runGuest(o: { link: Link; window: PassWindow; waitMs: number; log: Log }): Promise<DoorAnswer> {
  const id = member("rosa");
  const doorDid = member("door").did;
  const mesh = new MeshTransport({ identities: [id], links: [o.link], onEvent: eventPrinter(o.log), flood: { maxTtl: 0, relayShare: 0, unknown: "direct" } });
  mesh.addContact(doorDid);
  const setup = passSetup(o.window);
  const guest = new Guest({ identity: id, mesh, clock: new SystemClock() });
  await mesh.start();
  try {
    o.log(`Rosa's pass key: ${id.did}. Waiting up to ${Math.round(o.waitMs / 1000)} s for the Front Door's beacon…`);
    const beacon = await nextChallenge(mesh, doorDid, o.waitMs);
    o.log(`${stamp()}  heard the door's challenge ${hex(beacon.nonce!)}${beacon.rssi !== undefined ? ` at ${beacon.rssi} dBm` : ""}; presenting the pass`);
    const t0 = Date.now();
    const answer = await guest.present(doorDid, setup.pass, beacon.nonce!);
    o.log(`${stamp()}  ${answer.open ? "✓ the door opened" : `✗ refused: ${answer.reason}`} (${fmtMs(Date.now() - t0)} after the beacon)`);
    return answer;
  } finally {
    guest.close();
    await mesh.stop();
  }
}

// ---------------------------------------------------------------- act 2

function relayLogger(t: RelayTransport, log: Log, what: string) {
  t.onStatus((s) => log(`${stamp()}  ${what}: relay ${s}`));
}

export async function runGateway(o: { link: Link; relayUrl: string; stateDir: string; log: Log; signal?: AbortSignal; beaconEveryMs?: number }): Promise<void> {
  const id = member("lodge");
  const mesh = new MeshTransport({ identities: [id], links: [o.link], contacts: fileContacts(join(o.stateDir, "contacts.json")), onEvent: eventPrinter(o.log) });
  const relay = new RelayTransport({ url: o.relayUrl, identity: id });
  relayLogger(relay, o.log, "gateway");
  relay.start();
  const relayLike = {
    url: o.relayUrl,
    post: async (from: string, to: string, wire: Uint8Array) => {
      const d = await relay.post(from, to, wire);
      o.log(`${stamp()}  posted ${fmtBytes(wire.length)} of TSP from ${nameOf(from === id.did ? to : from)} to ${nameOf(to)}: ${d}`);
      return d;
    },
  };
  const gateway = new MeshGateway({ identity: id, mesh, relay: relayLike, store: fileGatewayStore(join(o.stateDir, "custody.json")), beaconEveryMs: o.beaconEveryMs ?? 60_000 });
  await gateway.start();
  o.log(`The Lodge's gateway is up: ${id.did}, posting to ${o.relayUrl}. It beacons every ${Math.round((o.beaconEveryMs ?? 60_000) / 1000)} s. Ctrl-C stops it.`);
  await aborted(o.signal);
  await gateway.stop();
  await mesh.stop();
  relay.stop();
}

/**
 * `mesh gateway --link sim`: the Lodge on a simulated radio in real time, with a simulated cabin next
 * to it that sends one Settle attestation. The relay is real. Resolves after the custody receipt.
 */
export async function runGatewaySim(o: { relayUrl: string; stateDir: string; log: Log; signal?: AbortSignal }): Promise<{ custody: boolean }> {
  const medium = new SimMedium({ scheduler: realScheduler, seed: Date.now() & 0xffff });
  const p = planFor("us915-a", "node");
  const radio = { setting: p.tx, mtu: 250, budget: p.budget, turnaroundMs: 50 };
  const [alice, lodge] = [member("alice"), member("lodge")];
  const lodgeLink = medium.node("lodge", radio);
  const aliceLink = medium.node("alice", radio);
  medium.connect("alice", "lodge", { rssi: -97, snr: 2 });
  const log = (who: string) => (s: string) => o.log(`[${who}] ${s}`);
  const gatewayDone = new AbortController();
  const stop = () => gatewayDone.abort();
  o.signal?.addEventListener("abort", stop, { once: true });
  const gw = runGateway({ link: lodgeLink, relayUrl: o.relayUrl, stateDir: o.stateDir, log: log("lodge"), signal: gatewayDone.signal, beaconEveryMs: 10_000 });
  let custody = false;
  const mesh = new MeshTransport({
    identities: [alice],
    links: [aliceLink],
    gateways: [{ vid: lodge.did }],
    flood: { maxTtl: 3, relayShare: 0.3, unknown: "off" },
    onEvent: (e) => {
      if (e.type === "custody") custody = true;
      eventPrinter(log("alice (simulated)"))(e);
    },
  });
  const ep = new Endpoint({ identity: alice, transport: mesh, clock: new SystemClock(), freshness: OFFLINE_FRESHNESS, bodyCodecFor: () => ctt1 });
  try {
    await mesh.start();
    await until(() => mesh.neighbors().some((c) => c.vid === lodge.did) || !!o.signal?.aborted, 30_000, "the Lodge's beacon");
    if (o.signal?.aborted) return { custody };
    const terms = await demoPayment("sink");
    const d = await ep.notify(member("landlord").did, ESCROW_ATTEST, attest(alice, terms, "complete", new SystemClock(), PAYMENTS.sink.note));
    log("alice (simulated)")(`attested "work complete" for "${terms.purpose}": post() → "${d}"${custody ? ", with the Lodge's signed custody receipt" : ""}`);
    return { custody };
  } finally {
    ep.close();
    await mesh.stop();
    stop();
    await gw;
  }
}

/** Alice attests from wherever she is. With no gateway in range, the message waits in her outbox file. */
export async function runAttest(o: { link: Link; stateDir: string; waitMs: number; which: keyof typeof PAYMENTS; log: Log }): Promise<{ delivery: string; custody: boolean; pending: number }> {
  const alice = member("alice");
  const lodge = member("lodge");
  let custody = false;
  const mesh = new MeshTransport({
    identities: [alice],
    links: [o.link],
    gateways: [{ vid: lodge.did }],
    contacts: fileContacts(join(o.stateDir, "contacts.json")),
    outbox: fileOutbox(join(o.stateDir, "outbox.json")),
    flood: { maxTtl: 3, relayShare: 0.3, unknown: "off" },
    onEvent: (e) => {
      if (e.type === "custody") custody = true;
      eventPrinter(o.log)(e);
    },
  });
  const ep = new Endpoint({ identity: alice, transport: mesh, clock: new SystemClock(), freshness: OFFLINE_FRESHNESS, bodyCodecFor: () => ctt1 });
  try {
    await mesh.start();
    if (o.waitMs > 0) {
      o.log(`Listening up to ${Math.round(o.waitMs / 1000)} s for the Lodge's gateway beacon…`);
      await until(() => mesh.estimate(member("landlord").did, 1000).route === "gateway", o.waitMs, "a gateway").catch(() => o.log("no gateway heard"));
    }
    const terms = await demoPayment(o.which);
    const delivery = await ep.notify(member("landlord").did, ESCROW_ATTEST, attest(alice, terms, "complete", new SystemClock(), PAYMENTS[o.which].note));
    const pending = mesh.pending();
    o.log(`attested "work complete" for "${terms.purpose}": post() → "${delivery}"${custody ? " (the Lodge signed for it)" : ""}`);
    if (pending) o.log(`${pending} message(s) wait in ${join(o.stateDir, "outbox.json")}. To carry them by hand: mesh bundle export --state ${o.stateDir}`);
    return { delivery, custody, pending };
  } finally {
    ep.close();
    await mesh.stop();
  }
}

/** The landlord's agent, online: accepts Alice's attestations for the demo payments. */
export async function runReceive(o: { relayUrl: string; log: Log; signal?: AbortSignal; once?: boolean }): Promise<number> {
  const landlord = member("landlord");
  const relay = new RelayTransport({ url: o.relayUrl, identity: landlord });
  relayLogger(relay, o.log, "landlord's agent");
  let done!: () => void;
  const first = new Promise<void>((r) => (done = r));
  const party = new SettleParty({
    identity: landlord,
    transport: relay,
    clock: new SystemClock(),
    onAccepted: (a) => {
      o.log(`${stamp()}  accepted from ${nameOf(a.sender)}: "${a.claim}" for "${a.purpose}"${a.note ? ` (${a.note})` : ""}`);
      done();
    },
    onIgnored: (why) => o.log(`${stamp()}  ignored ${why}`),
  });
  for (const k of Object.keys(PAYMENTS) as (keyof typeof PAYMENTS)[]) party.know(await demoPayment(k));
  relay.start();
  o.log(`The landlord's agent (${landlord.did}) is listening on ${o.relayUrl}. Ctrl-C stops it.`);
  await Promise.race([aborted(o.signal), ...(o.once ? [first] : [])]);
  party.close();
  relay.stop();
  return party.accepted.length;
}

// ---------------------------------------------------------------- act 3

/** A courier's key: a cast name, or a did:key (for sealing only). */
export function courierKey(s: string): { vid: string; encryptionKey: Uint8Array } {
  const vid = s.startsWith("did:") ? s : member(s).did;
  return { vid, encryptionKey: resolveDidKey(vid).encryptionKey };
}

export async function bundleExport(o: { stateDir: string; sealTo?: string; out: string; log: Log; nowMs?: number }): Promise<{ count: number; bytes: number }> {
  const store = fileOutbox(join(o.stateDir, "outbox.json"));
  const items = await store.load();
  const pending = items.filter((i) => i.state === "pending");
  if (!pending.length) throw new Error(`nothing waits in ${join(o.stateDir, "outbox.json")}`);
  const sealTo = o.sealTo ? courierKey(o.sealTo) : undefined;
  const bundle = await exportBundle(pending.map((i) => ({ to: i.to, wire: i.wire })), { ...(sealTo ? { sealTo } : {}), ...(o.nowMs ? { nowMs: o.nowMs } : {}) });
  writeFileSync(o.out, bundle);
  for (const i of pending) i.state = "carried";
  await store.save(items);
  o.log(`wrote ${o.out}: ${pending.length} message(s), ${fmtBytes(bundle.length)}${sealTo ? `, sealed to ${nameOf(sealTo.vid)}` : ", NOT sealed (anyone holding the file learns who it is for)"}. They are marked "carried" in the outbox.`);
  return { count: pending.length, bytes: bundle.length };
}

export async function bundleImport(o: { file: string; relayUrl: string; as: string; log: Log; connectMs?: number }): Promise<{ posted: number; refused: number }> {
  const courier: Identity = member(o.as);
  const items = await openBundle(readFileSync(o.file), courier);
  o.log(`opened ${o.file}: ${items.length} message(s), for ${[...new Set(items.map((i) => nameOf(i.to)))].join(", ")}`);
  const relay = new RelayTransport({ url: o.relayUrl, identity: courier });
  relay.start();
  try {
    await until(() => relay.status === "connected", o.connectMs ?? 10_000, `the relay at ${o.relayUrl}`);
    const r = await postBundle(items, relay);
    o.log(`posted ${r.posted} to ${o.relayUrl}, signed in as ${nameOf(courier.did)}${r.refused ? `; ${r.refused} refused` : ""}`);
    return r;
  } finally {
    relay.stop();
  }
}
