/**
 * MeshTransport: trust-core's Transport over radio links (design §7–§12, §19.2).
 *
 * Sending: split the sealed TSP message, choose a route and a packet kind, keep it in the outbox,
 * cut it into frames, send them when the airtime budget allows, and wait for an ACK or a RECEIPT.
 * Receiving: reassemble, check the hash, drop duplicates, recognize packets by their address tags,
 * rebuild the exact TSP bytes, check the TSP signature, and hand them to the attached Endpoint.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { resolveDidKey, type Delivery, type Identity, type Transport } from "@toip-tools/trust-core";
import { AirtimeBudget, type TrafficClass } from "./airtime";
import { concat, equal, hex, Lru, utf8 } from "./bytes";
import { BEACON_BYTES, FRAME_HEADER, MAX_FRAGMENTS, ackLength, beaconSigned, decodeFrame, encodeFrame, estimate as estimateFrames, fragment, type Frame } from "./frame";
import { ackMac, addressTag, keyHint, openSender, pairKeys, receiptMac, receiptTag, sealRoute, sealSender, type PeerKeys } from "./keys";
import type { Link, ReceivedFrame } from "./link";
import { RECEIPT_CUSTODY, RECEIPT_OPENED, RECEIPT_REFUSED, custodyMessage, decodePacket, encodePacket, packetId, type Packet, type PacketKind } from "./packet";
import { realScheduler, type Scheduler } from "./scheduler";
import { joinTsp, splitTsp, tspSignatureValid, type TspParts } from "./tsp";
import { exportBundle as makeBundle } from "./bundle";

// ---------------------------------------------------------------- public types

export interface Contact {
  vid: string;
  signingKey: Uint8Array;
  encryptionKey: Uint8Array;
  /** We have heard from them, so they know us: send PAIR, not INTRO. */
  introduced: boolean;
  heard?: { atMs: number; hops: number; link: string; rssi?: number };
  /** False when the contact can't read CTT1 bodies. */
  compact?: boolean;
}

export interface ContactStore {
  load(): Promise<Contact[]>;
  save(contacts: Contact[]): Promise<void>;
}

export interface MeshOutboxItem {
  pid: string;
  to: string;
  wire: Uint8Array;
  createdMs: number;
  /** Full cycles of retries that went unanswered. */
  attempts: number;
  nextTryMs: number;
  state: "pending" | "custody" | "carried";
}

export interface MeshOutboxStore {
  load(): Promise<MeshOutboxItem[]>;
  save(items: MeshOutboxItem[]): Promise<void>;
}

export const memoryContacts = (): ContactStore => {
  let saved: Contact[] = [];
  return { load: async () => saved.map((c) => ({ ...c })), save: async (c) => void (saved = c.map((x) => ({ ...x }))) };
};

export const memoryOutbox = (): MeshOutboxStore => {
  let saved: MeshOutboxItem[] = [];
  return { load: async () => saved.map((i) => ({ ...i })), save: async (i) => void (saved = i.map((x) => ({ ...x }))) };
};

export interface MeshOptions {
  /** Every local VID. attach() must name one of them. */
  identities: Identity[];
  links: Link[];
  scheduler?: Scheduler;
  contacts?: ContactStore;
  outbox?: MeshOutboxStore;
  /** Gateways this node may use. */
  gateways?: { vid: string }[];
  /** Repeat flooded packets for others. Default false (a phone); set true for fixed nodes. */
  relay?: boolean;
  /** `unknown`: how to reach a recipient never heard: flood it (default), try one hop, or wait in the outbox. */
  flood?: { maxTtl: number; relayShare: number; unknown?: "flood" | "direct" | "off" };
  arq?: { maxRounds: number; burst: number };
  /** How long post() waits for an answer before saying "queued". */
  postWaitMs?: (bytes: number) => number;
  acceptIntros?: boolean | ((sender: string) => boolean);
  onEvent?: (e: MeshEvent) => void;
  /** Randomness for jitter. Seed it in simulations. */
  random?: () => number;
}

export type MeshEvent =
  | { type: "frame-out"; link: string; bytes: number; airtimeMs: number; summary: string }
  | { type: "frame-in"; link: string; bytes: number; rssi?: number; snr?: number; summary: string }
  | { type: "packet-in"; pid: string; kind: PacketKind; forMe: boolean }
  /** A packet built from a posted TSP message, before its first frame goes out. `wireBytes` is the TSP message's size. */
  | { type: "packet-out"; pid: string; kind: PacketKind; from: string; to: string; route: "direct" | "flood" | "gateway"; bytes: number; frames: number; wireBytes: number }
  | { type: "retry"; pid: string; round: number; missing: number[] }
  | { type: "delivered"; pid: string; to: string; route: "direct" | "flood" | "gateway" }
  | { type: "custody"; pid: string; gateway: string }
  | { type: "queued"; pid: string; reason: "no-route" | "no-airtime" | "no-answer" }
  | { type: "budget"; link: string; usedFraction: number; waitMs: number; warning?: string }
  | { type: "dropped"; reason: string };

export interface BeaconInfo {
  role: "verifier" | "gateway";
  vid: string;
  nonce?: Uint8Array;
  atMs: number;
  rssi?: number;
}

export interface MeshStats {
  framesOut: number;
  framesIn: number;
  airtimeMs: number;
  retries: number;
  delivered: number;
  dropped: Record<string, number>;
}

/** What a gateway gets for each VIA packet that names it. */
export interface ViaArrival {
  packet: Uint8Array;
  pid: Uint8Array;
  via: Extract<Packet, { kind: "via" }>;
  hops: number;
  link: string;
}

// ---------------------------------------------------------------- internals

const HEARD_FRESH_MS = 10 * 60_000;
const SEEN_MS = 3600_000;
const RELAY_MEMORY_MS = 10 * 60_000;
const BACKOFF_START_MS = 30_000;
/** How long a beacon counts as already heard: longer than relays take to repeat it, shorter than a beacon period. */
const BEACON_SEEN_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const MAX_BUFFERS = 64;
const BEACON_LABEL = utf8("zk-toip/mesh/beacon/v1");

const PRIO = { control: 0, beacon: 1, own: 2, retry: 3, relay: 4, bulk: 5 } as const;

interface QueuedFrame {
  frame: Uint8Array;
  prio: number;
  cls: TrafficClass;
  ms: number;
  tries: number;
  /** The packet this frame belongs to: its frames are dropped from the queue when it is done. */
  owner?: Outgoing;
  /** Runs right after the frame is sent, before the next one is picked. */
  after?: () => void;
  done: (sent: boolean) => void;
}

interface Slot {
  link: Link;
  label: string;
  mtu: number;
  budget: AirtimeBudget;
  queue: QueuedFrame[];
  sending: boolean;
  /** A direct packet whose ACK we are listening for: nothing but control frames go out meanwhile. */
  listening?: Outgoing;
  wake?: unknown;
  frameMs: number;
  ifMs: number;
  ackAirMs: number;
  ackMs: number;
  unsub: () => void;
}

type Route = { route: "direct" | "flood" | "gateway"; slots: Slot[]; ttl: number; gateway?: Contact };

interface Outgoing {
  pidHex: string;
  pid: Uint8Array;
  packet: Uint8Array;
  kind: PacketKind;
  from: Identity;
  to: string;
  route: Route;
  attempt: number;
  round: number;
  acked: Set<number>;
  count: number;
  /** k(R→S): R's ACKs and receipts are MACed under it. R is the gateway on gateway routes. */
  kIn: Uint8Array;
  rtagHex: string;
  gatewayKey?: Uint8Array;
  timer?: unknown;
  item: MeshOutboxItem;
  finished: boolean;
  waiters: ((d: Delivery) => void)[];
}

type ForMe =
  | { kind: "pair"; local: Identity; candidates: Contact[] }
  | { kind: "intro"; local: Identity; sender: string; refused: boolean }
  | { kind: "via"; local: Identity }
  | { kind: "receipt"; out: Outgoing };

interface Decision {
  forMe?: ForMe;
}

interface Buffer {
  pidHex: string;
  pid: Uint8Array;
  count: number;
  frags: (Uint8Array | undefined)[];
  have: number;
  direct: boolean;
  maxTtl: number;
  hops: number;
  minHops: number;
  attempt: number;
  slot: Slot;
  lastAt: number;
  rssi?: number;
  timer?: unknown;
  decision?: Promise<Decision>;
}

interface Seen {
  at: number;
  mine: boolean;
  /** Set when we acknowledge this packet: so a resend gets the ACK again. */
  ack?: { slot: Slot; count: number; key: Uint8Array };
  /** Kept for relays, so a later attempt can be repeated. */
  packet?: Uint8Array;
  receipt?: { packet: Uint8Array; ttl: number; slot: Slot; attempt: number };
  /** A VIA packet for our gateway: a resend (a new attempt) goes to the gateway again, which answers from its record. */
  via?: { arrival: ViaArrival; vid: string; attempt: number };
}

const isDirect = (f: { ttl: number; hops: number }) => f.ttl === 0 && f.hops === 0;

export class MeshTransport implements Transport {
  private readonly opts: MeshOptions;
  private readonly sched: Scheduler;
  private readonly rnd: () => number;
  private readonly locals = new Map<string, { identity: Identity; deliver?: (wire: Uint8Array) => Promise<void> }>();
  private readonly contacts = new Map<string, Contact>();
  private readonly slots: Slot[] = [];
  private readonly keyCache = new Map<string, { out: Uint8Array; in: Uint8Array }>();
  private hintIndex?: Map<string, string[]>;
  private outbox: MeshOutboxItem[] = [];
  private readonly active = new Map<string, Outgoing>();
  private readonly activeByItem = new Map<MeshOutboxItem, Outgoing>();
  private readonly byReceiptTag = new Map<string, Outgoing>();
  private readonly retryTimers = new Map<MeshOutboxItem, unknown>();
  private readonly buffers = new Map<string, Buffer>();
  private readonly ignored = new Lru<string, number>(2000);
  private readonly seen = new Lru<string, Seen>(10_000);
  private readonly relays = new Lru<string, { at: number; heard: number; timer?: unknown; done: boolean }>(2000);
  private readonly beaconsSeen = new Lru<string, number>(500);
  private readonly pendingAcks = new Map<string, { timer: unknown; bitmap: Uint8Array }>();
  private readonly viaHandlers = new Map<string, (v: ViaArrival) => Promise<void>>();
  private readonly beaconListeners = new Set<(b: BeaconInfo) => void>();
  private readonly timers = new Set<unknown>();
  private readonly statsData: MeshStats = { framesOut: 0, framesIn: 0, airtimeMs: 0, retries: 0, delivered: 0, dropped: {} };
  private inbound: Promise<void> = Promise.resolve();
  private started?: Promise<void>;
  private stopped = false;

  constructor(opts: MeshOptions) {
    if (!opts.identities.length) throw new Error("MeshTransport needs at least one identity");
    if (!opts.links.length) throw new Error("MeshTransport needs at least one link");
    this.opts = opts;
    this.sched = opts.scheduler ?? realScheduler;
    this.rnd = opts.random ?? Math.random;
    for (const identity of opts.identities) this.locals.set(identity.did, { identity });
  }

  /** The clock and timers this transport runs on. */
  get scheduler(): Scheduler {
    return this.sched;
  }

  private get maxTtl(): number {
    return Math.min(7, this.opts.flood?.maxTtl ?? 3);
  }
  private get maxRounds(): number {
    return this.opts.arq?.maxRounds ?? 4;
  }
  private get burst(): number {
    return this.opts.arq?.burst ?? 8;
  }
  private get relayOn(): boolean {
    return this.opts.relay ?? false;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): Promise<void> {
    this.started ??= (async () => {
      for (const c of (await this.opts.contacts?.load()) ?? []) this.contacts.set(c.vid, c);
      for (const g of this.opts.gateways ?? []) this.ensureContact(g.vid);
      this.outbox = (await this.opts.outbox?.load()) ?? [];
      for (const link of this.opts.links) {
        const info = link.info;
        const capped = this.cappedMtu(link, info.mtu);
        const frameMs = info.airtimeMs(capped);
        const ackAirMs = info.airtimeMs(ackLength(8));
        const ifMs = 2 * frameMs + info.turnaroundMs;
        const slot: Slot = {
          link,
          label: info.label,
          mtu: capped,
          budget: new AirtimeBudget(info.budget, this.opts.flood?.relayShare ?? 0.3),
          queue: [],
          sending: false,
          frameMs,
          ifMs,
          ackAirMs,
          ackMs: ifMs + 2 * info.turnaroundMs + 2 * ackAirMs,
          unsub: () => {},
        };
        const offFrame = link.onFrame((f) => this.onFrame(slot, f));
        const offState = link.onState((s) => s === "open" && this.pump(slot));
        slot.unsub = () => {
          offFrame();
          offState();
        };
        this.slots.push(slot);
        if (link.state !== "open") await link.open();
      }
      for (const item of this.outbox) if (item.state === "pending") this.scheduleRetry(item, Math.max(0, item.nextTryMs - this.sched.now()));
    })();
    return this.started;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) this.sched.clearTimeout(t);
    this.timers.clear();
    for (const s of this.slots) {
      s.unsub();
      for (const q of s.queue) q.done(false);
      s.queue = [];
      await s.link.close();
    }
    for (const o of this.active.values()) for (const w of o.waiters) w("queued");
  }

  /** The largest frame the link may send: its MTU, capped by its dwell limit. */
  private cappedMtu(link: Link, mtu: number): number {
    const cap = link.info.budget.maxFrameMs;
    if (cap === undefined) return mtu;
    let n = mtu;
    while (n > FRAME_HEADER + 1 && link.info.airtimeMs(n) > cap) n--;
    return n;
  }

  private after(ms: number, fn: () => void): unknown {
    const h = this.sched.setTimeout(() => {
      this.timers.delete(h);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(h);
    return h;
  }

  private cancel(h: unknown): void {
    if (h === undefined) return;
    this.sched.clearTimeout(h);
    this.timers.delete(h);
  }

  private emit(e: MeshEvent): void {
    this.opts.onEvent?.(e);
  }

  private drop(reason: string): void {
    this.statsData.dropped[reason] = (this.statsData.dropped[reason] ?? 0) + 1;
    this.emit({ type: "dropped", reason });
  }

  // ---------------------------------------------------------------- Transport

  attach(vid: string, deliver: (wire: Uint8Array) => Promise<void>): void {
    const l = this.locals.get(vid);
    if (!l) throw new Error(`${vid} is not one of this mesh node's identities`);
    l.deliver = deliver;
  }

  detach(vid: string): void {
    const l = this.locals.get(vid);
    if (l) l.deliver = undefined;
  }

  async post(from: string, to: string, wire: Uint8Array): Promise<Delivery> {
    await this.start();
    if (!this.locals.has(from)) return "undelivered";
    let parts: TspParts;
    try {
      parts = splitTsp(wire);
    } catch {
      // Not a Direct TSP message we can rebuild. The raw form would name both VIDs on the air: refused.
      return "undelivered";
    }
    if (parts.senderVid !== from || parts.receiverVid !== to) return "undelivered";
    if (!this.ensureContact(to) && !(this.opts.gateways ?? []).length) return "undelivered";
    const packetMax = Math.min(...this.slots.map((s) => MAX_FRAGMENTS * (s.mtu - FRAME_HEADER)));
    if (wire.length - 61 > packetMax) return "undelivered";
    const item: MeshOutboxItem = { pid: "", to, wire, createdMs: this.sched.now(), attempts: 0, nextTryMs: this.sched.now(), state: "pending" };
    this.outbox.push(item);
    await this.persistOutbox();
    return this.dispatch(item);
  }

  // ---------------------------------------------------------------- contacts

  addContact(vid: string): void {
    if (!this.ensureContact(vid)) throw new Error(`can't resolve ${vid}; use addContactKeys`);
  }

  addContactKeys(c: Omit<Contact, "introduced">): void {
    const prior = this.contacts.get(c.vid);
    this.contacts.set(c.vid, { introduced: prior?.introduced ?? false, ...prior, ...c });
    this.contactsChanged();
  }

  private ensureContact(vid: string): Contact | undefined {
    const known = this.contacts.get(vid);
    if (known) return known;
    try {
      const k = resolveDidKey(vid);
      const c: Contact = { vid, signingKey: k.signingKey, encryptionKey: k.encryptionKey, introduced: false };
      this.contacts.set(vid, c);
      this.contactsChanged();
      return c;
    } catch {
      return undefined;
    }
  }

  private contactsChanged(): void {
    this.hintIndex = undefined;
    void this.opts.contacts?.save([...this.contacts.values()]);
  }

  /** `knowsUs`: what we heard shows they know us (an ACK, a receipt, a message), so PAIR works. A beacon doesn't. */
  private heard(c: Contact, hops: number, slot: Slot, rssi?: number, knowsUs = true): void {
    const wasFresh = c.heard && this.sched.now() - c.heard.atMs < HEARD_FRESH_MS;
    const changed = knowsUs && !c.introduced;
    if (knowsUs) c.introduced = true;
    c.heard = { atMs: this.sched.now(), hops, link: slot.label, ...(rssi !== undefined ? { rssi } : {}) };
    if (changed) this.contactsChanged();
    if (!wasFresh) this.retryWaiting(c.vid);
  }

  supportsCompact(vid: string): boolean {
    return this.contacts.get(vid)?.compact !== false;
  }

  neighbors(): Contact[] {
    const now = this.sched.now();
    return [...this.contacts.values()].filter((c) => c.heard && c.heard.hops === 0 && now - c.heard.atMs < HEARD_FRESH_MS);
  }

  private keys(local: Identity, peer: PeerKeys & { vid: string }) {
    const k = `${local.did}|${peer.vid}`;
    let v = this.keyCache.get(k);
    if (!v) {
      v = pairKeys(local, peer);
      this.keyCache.set(k, v);
    }
    return v;
  }

  // ---------------------------------------------------------------- estimates

  estimate(to: string, bytes: number): { frames: number; airtimeMs: number; route: string } {
    const r = this.chooseRoute(to);
    const slot = r?.slots[0] ?? this.slots[0];
    const kind = r?.route === "gateway" ? 20 : this.contacts.get(to)?.introduced ? 139 : 61;
    const e = estimateFrames(Math.max(1, bytes - kind), { mtu: slot.mtu, airtimeMs: slot.link.info.airtimeMs });
    return { ...e, route: r?.route ?? "outbox" };
  }

  private roundMs(route: Route["route"], ttl: number, packetMs: number, slot: Slot): number {
    return route === "direct" ? packetMs + slot.ackMs : Math.max(5000, (ttl + 1) * (packetMs + slot.ackMs) * 2);
  }

  /** A request timeout for an Endpoint on this mesh: every round there and back. */
  suggestedTimeoutMs(to: string, bytes: number): number {
    const e = this.estimate(to, bytes);
    const r = this.chooseRoute(to);
    const slot = r?.slots[0] ?? this.slots[0];
    const per = this.roundMs(r?.route ?? "flood", r?.ttl ?? this.maxTtl, e.airtimeMs, slot);
    return Math.max(5000, Math.round(2 * this.maxRounds * per + 2000));
  }

  pending(): number {
    return this.outbox.filter((i) => i.state === "pending").length;
  }

  stats(): MeshStats {
    return { ...this.statsData, dropped: { ...this.statsData.dropped } };
  }

  onBeacon(fn: (b: BeaconInfo) => void): () => void {
    this.beaconListeners.add(fn);
    return () => this.beaconListeners.delete(fn);
  }

  // ---------------------------------------------------------------- routes and sending

  private chooseRoute(to: string): Route | null {
    const now = this.sched.now();
    const fresh = (c?: Contact) => !!c?.heard && now - c.heard.atMs < HEARD_FRESH_MS;
    const slotFor = (label: string) => this.slots.find((s) => s.label === label) ?? this.slots[0];
    const c = this.contacts.get(to);
    if (c && fresh(c)) {
      if (c.heard!.hops === 0) return { route: "direct", slots: [slotFor(c.heard!.link)], ttl: 0 };
      if (this.maxTtl > 0) return { route: "flood", slots: this.slots, ttl: Math.min(c.heard!.hops + 1, this.maxTtl) };
    }
    for (const g of this.opts.gateways ?? []) {
      if (g.vid === to) continue;
      const gc = this.contacts.get(g.vid);
      if (gc && fresh(gc)) {
        const hops = gc.heard!.hops;
        return hops === 0
          ? { route: "gateway", slots: [slotFor(gc.heard!.link)], ttl: 0, gateway: gc }
          : { route: "gateway", slots: this.slots, ttl: Math.min(hops + 1, this.maxTtl), gateway: gc };
      }
    }
    if (!c) return null;
    const unknown = this.opts.flood?.unknown ?? "flood";
    if (unknown === "flood" && this.maxTtl > 0) return { route: "flood", slots: this.slots, ttl: this.maxTtl };
    if (unknown === "direct" || (unknown === "flood" && this.maxTtl === 0)) return { route: "direct", slots: [this.slots[0]], ttl: 0 };
    return null;
  }

  private async dispatch(item: MeshOutboxItem): Promise<Delivery> {
    if (item.state !== "pending" || this.stopped) return "queued";
    const running = this.activeByItem.get(item);
    if (running) return new Promise((res) => running.waiters.push(res));
    const parts = splitTsp(item.wire);
    const local = this.locals.get(parts.senderVid)!.identity;
    const route = this.chooseRoute(item.to);
    if (!route) {
      this.emit({ type: "queued", pid: item.pid, reason: "no-route" });
      return "queued";
    }
    let packet: Packet;
    let peer: Contact;
    if (route.route === "gateway") {
      peer = route.gateway!;
      const routeBlock = await sealRoute(parts.senderVid, parts.receiverVid, peer.encryptionKey, parts.enc);
      packet = { kind: "via", gatewayHint: keyHint(peer.signingKey), routeBlock, enc: parts.enc, ct: parts.ct, signature: parts.signature };
    } else {
      peer = this.contacts.get(item.to)!;
      packet = peer.introduced
        ? { kind: "pair", tag: addressTag(this.keys(local, peer).out, parts.enc), enc: parts.enc, ct: parts.ct, signature: parts.signature }
        : { kind: "intro", sealedSender: await sealSender(parts.senderVid, peer.encryptionKey, parts.enc), enc: parts.enc, ct: parts.ct, signature: parts.signature };
    }
    const bytes = encodePacket(packet);
    const pid = packetId(bytes);
    const count = Math.ceil(bytes.length / (route.slots[0].mtu - FRAME_HEADER));
    if (route.slots.some((s) => Math.ceil(bytes.length / (s.mtu - FRAME_HEADER)) > MAX_FRAGMENTS)) {
      await this.removeItem(item);
      return "undelivered";
    }
    const kIn = this.keys(local, peer).in;
    const o: Outgoing = {
      pidHex: hex(pid),
      pid,
      packet: bytes,
      kind: packet.kind,
      from: local,
      to: item.to,
      route,
      attempt: 0,
      round: 0,
      acked: new Set(),
      count,
      kIn,
      rtagHex: hex(receiptTag(kIn, pid)),
      gatewayKey: route.route === "gateway" ? peer.signingKey : undefined,
      item,
      finished: false,
      waiters: [],
    };
    item.pid = o.pidHex;
    this.emit({ type: "packet-out", pid: o.pidHex, kind: packet.kind, from: local.did, to: item.to, route: route.route, bytes: bytes.length, frames: count, wireBytes: item.wire.length });
    this.active.set(o.pidHex, o);
    this.activeByItem.set(item, o);
    this.byReceiptTag.set(o.rtagHex, o);
    this.seen.set(o.pidHex, { at: this.sched.now(), mine: true });
    const slot = route.slots[0];
    const est = estimateFrames(bytes.length, { mtu: slot.mtu, airtimeMs: slot.link.info.airtimeMs });
    const budgetHour = slot.budget.capMs * (3600_000 / slot.link.info.budget.windowMs);
    if (est.airtimeMs > budgetHour / 4) {
      this.emit({ type: "budget", link: slot.label, usedFraction: slot.budget.usedFraction(this.sched.now()), waitMs: 0, warning: `one packet takes ${Math.round(est.airtimeMs)} ms, over a quarter of the hourly budget` });
    }
    const waitMs =
      this.opts.postWaitMs?.(item.wire.length) ??
      Math.min(60_000, Math.max(2000, Math.round(this.maxRounds * this.roundMs(route.route, route.ttl, est.airtimeMs, slot) * 2)));
    const result = new Promise<Delivery>((resolve) => {
      let settled = false;
      const t = this.after(waitMs, () => {
        if (settled) return;
        settled = true;
        if (!o.finished) this.emit({ type: "queued", pid: o.pidHex, reason: o.round === 0 && o.acked.size === 0 && this.queuedFor(o) ? "no-airtime" : "no-answer" });
        resolve("queued");
      });
      o.waiters.push((d) => {
        if (settled) return;
        settled = true;
        this.cancel(t);
        resolve(d);
      });
    });
    void this.persistOutbox();
    void this.sendRound(o, false);
    return result;
  }

  private queuedFor(o: Outgoing): boolean {
    return o.route.slots.some((s) => s.queue.length > 0);
  }

  /** `silent`: the last round got no ACK at all. */
  private async sendRound(o: Outgoing, retry: boolean, silent = false): Promise<void> {
    if (o.finished) return;
    const direct = o.route.route === "direct";
    // One hop: a burst of at most `burst` fragments, then listen for the ACK. Other routes have no ACKs, so all of it.
    const limit = direct ? this.burst : o.count;
    const missing: number[] = [];
    for (let i = 0; i < o.count && missing.length < limit; i++) if (!o.acked.has(i)) missing.push(i);
    if (retry) {
      this.statsData.retries++;
      this.emit({ type: "retry", pid: o.pidHex, round: o.round, missing });
    }
    // Without fragment 0 a receiver can't tell the packet is for it, so it can't name the gaps.
    // After a silent round, fragment 0 goes twice.
    const order = silent && direct && missing[0] === 0 && o.count > 1 ? [0, ...missing] : missing;
    const sends: Promise<boolean>[] = [];
    for (const slot of o.route.slots) {
      const frames = fragment(o.packet, slot.mtu, { ttl: o.route.ttl, hops: 0, attempt: o.attempt });
      order.forEach((i, n) => {
        const last = n === order.length - 1;
        sends.push(
          this.enqueue(slot, frames[i], retry ? PRIO.retry : PRIO.own, "normal", last && direct ? () => (slot.listening = o) : undefined, o),
        );
      });
    }
    await Promise.all(sends);
    if (o.finished) {
      this.release(o);
      return;
    }
    const slot = o.route.slots[0];
    const packetMs = estimateFrames(o.packet.length, { mtu: slot.mtu, airtimeMs: slot.link.info.airtimeMs }).airtimeMs;
    const wait = direct ? slot.ackMs : this.roundMs(o.route.route, o.route.ttl, packetMs, slot);
    this.cancel(o.timer);
    o.timer = this.after(wait, () => this.onTimeout(o));
  }

  private release(o: Outgoing): void {
    for (const s of o.route.slots) {
      if (s.listening === o) {
        s.listening = undefined;
        this.pump(s);
      }
    }
  }

  private onTimeout(o: Outgoing): void {
    if (o.finished) return;
    this.release(o);
    o.round++;
    if (o.round >= this.maxRounds) return void this.backoff(o);
    if (o.route.route !== "direct") o.attempt = (o.attempt + 1) & 3;
    void this.sendRound(o, true, true);
  }

  private onAckFor(o: Outgoing, bitmap: Uint8Array): void {
    this.cancel(o.timer);
    this.release(o);
    let progress = false;
    for (let i = 0; i < o.count; i++) {
      if (bitmap[i >> 3] & (1 << (i & 7)) && !o.acked.has(i)) {
        o.acked.add(i);
        progress = true;
      }
    }
    if (o.acked.size === o.count) return void this.finish(o, "live");
    if (!progress) o.round++;
    if (o.round >= this.maxRounds) return void this.backoff(o);
    void this.sendRound(o, true);
  }

  private forget(o: Outgoing): void {
    o.finished = true;
    this.cancel(o.timer);
    this.release(o);
    this.active.delete(o.pidHex);
    this.activeByItem.delete(o.item);
    this.byReceiptTag.delete(o.rtagHex);
    // Frames of this packet still waiting for airtime are no longer needed.
    for (const s of o.route.slots) {
      const stale = s.queue.filter((q) => q.owner === o);
      if (!stale.length) continue;
      s.queue = s.queue.filter((q) => q.owner !== o);
      for (const q of stale) q.done(false);
    }
  }

  private async backoff(o: Outgoing): Promise<void> {
    this.forget(o);
    const item = o.item;
    item.attempts++;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (item.attempts - 1));
    item.nextTryMs = this.sched.now() + wait;
    this.emit({ type: "queued", pid: o.pidHex, reason: "no-answer" });
    for (const w of o.waiters) w("queued");
    await this.persistOutbox();
    this.scheduleRetry(item, wait);
  }

  private scheduleRetry(item: MeshOutboxItem, ms: number): void {
    this.cancel(this.retryTimers.get(item));
    this.retryTimers.set(
      item,
      this.after(ms, () => {
        this.retryTimers.delete(item);
        void this.dispatch(item);
      }),
    );
  }

  /** Someone was heard: try what waits for them (or, for a gateway, anything) at once. */
  private retryWaiting(vid: string): void {
    const isGateway = (this.opts.gateways ?? []).some((g) => g.vid === vid);
    for (const item of this.outbox) {
      if (item.state !== "pending" || this.activeByItem.has(item)) continue;
      if (item.to === vid || isGateway) this.scheduleRetry(item, 0);
    }
  }

  private async finish(o: Outgoing, d: Delivery, custodyOf?: string): Promise<void> {
    if (o.finished) return;
    this.forget(o);
    if (d === "live") {
      this.statsData.delivered++;
      this.emit({ type: "delivered", pid: o.pidHex, to: o.to, route: o.route.route });
    }
    if (custodyOf) {
      o.item.state = "custody";
      this.emit({ type: "custody", pid: o.pidHex, gateway: custodyOf });
      await this.persistOutbox();
    } else await this.removeItem(o.item);
    for (const w of o.waiters) w(d);
  }

  private async removeItem(item: MeshOutboxItem): Promise<void> {
    this.cancel(this.retryTimers.get(item));
    this.retryTimers.delete(item);
    this.outbox = this.outbox.filter((i) => i !== item);
    await this.persistOutbox();
  }

  private persistOutbox(): Promise<void> {
    return this.opts.outbox?.save(this.outbox) ?? Promise.resolve();
  }

  /** Sends a packet nobody acknowledges frame by frame (receipts, custody receipts). For gateways. */
  sendPacket(packet: Uint8Array, opts: { ttl: number; link?: string; control?: boolean }): Promise<void> {
    const pidHex = hex(packetId(packet));
    this.seen.set(pidHex, { at: this.sched.now(), mine: true });
    const slots = opts.link ? this.slots.filter((s) => s.label === opts.link) : this.slots;
    return Promise.all(
      slots.flatMap((s) => fragment(packet, s.mtu, { ttl: Math.min(opts.ttl, 7), hops: 0, attempt: 0 }).map((f) => this.enqueue(s, f, opts.control === false ? PRIO.own : PRIO.control, opts.control === false ? "normal" : "control"))),
    ).then(() => {});
  }

  /** Lets a gateway receive the VIA packets that name `vid` (one of this node's identities). */
  onVia(vid: string, fn: (v: ViaArrival) => Promise<void>): () => void {
    if (!this.locals.has(vid)) throw new Error(`${vid} is not one of this mesh node's identities`);
    this.viaHandlers.set(vid, fn);
    return () => this.viaHandlers.delete(vid);
  }

  /** Sends a signed BEACON from one of this node's identities (a door or a gateway). */
  sendBeacon(role: "verifier" | "gateway", vid: string, body: Uint8Array): Promise<void> {
    const local = this.locals.get(vid)?.identity;
    if (!local) throw new Error(`${vid} is not one of this mesh node's identities`);
    if (body.length !== 8) throw new Error("a beacon body is 8 bytes");
    const hint = keyHint(local.signingPublic);
    const signature = ed25519.sign(concat(BEACON_LABEL, beaconSigned(role, hint, body)), local.signingSecret);
    const frame = encodeFrame({ type: "beacon", role, keyHint: hint, body, signature, hops: 0 });
    this.beaconsSeen.set(hex(frame.subarray(0, BEACON_BYTES)), this.sched.now());
    return Promise.all(this.slots.map((s) => this.enqueue(s, frame, PRIO.beacon, "normal"))).then(() => {});
  }

  /** Copies of the mesh's outbox messages for a courier (design §14.12); they are marked carried. */
  async exportBundle(opts: { sealTo?: string; to?: string[] } = {}): Promise<Uint8Array> {
    await this.start();
    const items = this.outbox.filter((i) => i.state === "pending" && (!opts.to || opts.to.includes(i.to)));
    for (const item of items) {
      const o = this.activeByItem.get(item);
      if (o) {
        this.forget(o);
        for (const w of o.waiters) w("queued");
      }
      this.cancel(this.retryTimers.get(item));
      this.retryTimers.delete(item);
      item.state = "carried";
    }
    await this.persistOutbox();
    const sealTo = opts.sealTo ? { vid: opts.sealTo, encryptionKey: resolveDidKey(opts.sealTo).encryptionKey } : undefined;
    return makeBundle(items.map((i) => ({ to: i.to, wire: i.wire })), sealTo ? { sealTo } : {});
  }

  // ---------------------------------------------------------------- the link queue

  private enqueue(slot: Slot, frame: Uint8Array, prio: number, cls: TrafficClass, after?: () => void, owner?: Outgoing): Promise<boolean> {
    return new Promise<boolean>((done) => {
      slot.queue.push({ frame, prio, cls, ms: slot.link.info.airtimeMs(frame.length), tries: 0, after, done, owner });
      this.pump(slot);
    });
  }

  private pick(slot: Slot): QueuedFrame | undefined {
    let best: QueuedFrame | undefined;
    for (const q of slot.queue) {
      if (slot.listening && q.cls !== "control") continue;
      if (!best || q.prio < best.prio) best = q;
    }
    return best;
  }

  private pump(slot: Slot): void {
    if (slot.sending || this.stopped || slot.link.state !== "open") return;
    this.cancel(slot.wake);
    slot.wake = undefined;
    const q = this.pick(slot);
    if (!q) return;
    const now = this.sched.now();
    const wait = slot.budget.waitMs(now, q.ms, q.cls);
    if (wait === Infinity) {
      slot.queue.splice(slot.queue.indexOf(q), 1);
      this.drop("over-cap");
      q.done(false);
      return this.pump(slot);
    }
    if (wait > 0) {
      this.emit({ type: "budget", link: slot.label, usedFraction: slot.budget.usedFraction(now), waitMs: wait });
      slot.wake = this.after(wait, () => this.pump(slot));
      return;
    }
    if (slot.link.channelBusy?.() && q.tries < 40) {
      q.tries++;
      slot.wake = this.after(5 + this.rnd() * 2 * slot.ackAirMs, () => this.pump(slot));
      return;
    }
    slot.queue.splice(slot.queue.indexOf(q), 1);
    slot.budget.record(now, q.ms, q.cls);
    slot.sending = true;
    slot.link.send(q.frame).then(
      () => {
        this.statsData.framesOut++;
        this.statsData.airtimeMs += q.ms;
        if (this.opts.onEvent) this.emit({ type: "frame-out", link: slot.label, bytes: q.frame.length, airtimeMs: q.ms, summary: summarize(q.frame) });
        slot.sending = false;
        q.after?.();
        q.done(true);
        this.pump(slot);
      },
      (e) => {
        slot.sending = false;
        this.drop(e?.name === "RegulatoryViolation" ? "regulatory" : "send-failed");
        q.done(false);
        // A broken rule is a bug: surface it through the scheduler (VirtualScheduler rethrows it).
        if (e?.name === "RegulatoryViolation") this.sched.setTimeout(() => {
          throw e;
        }, 0);
        this.pump(slot);
      },
    );
  }

  // ---------------------------------------------------------------- receiving

  private onFrame(slot: Slot, rx: ReceivedFrame): void {
    if (this.stopped) return;
    this.statsData.framesIn++;
    const f = decodeFrame(rx.bytes);
    if (!f) return this.drop("junk");
    if (this.opts.onEvent) this.emit({ type: "frame-in", link: slot.label, bytes: rx.bytes.length, rssi: rx.rssi, snr: rx.snr, summary: summarize(rx.bytes) });
    if (f.type === "data") this.onData(slot, f, rx);
    else if (f.type === "ack") this.onAck(slot, f);
    else this.onBeaconFrame(slot, f, rx);
  }

  private onAck(slot: Slot, a: Extract<Frame, { type: "ack" }>): void {
    const o = this.active.get(hex(a.pid));
    if (!o || o.route.route !== "direct" || a.count !== o.count) return;
    if (!equal(a.mac, ackMac(o.kIn, o.pid, a.bitmap))) return this.drop("ack-mac");
    const c = this.contacts.get(o.to);
    if (c) this.heard(c, 0, slot);
    this.onAckFor(o, a.bitmap);
  }

  private ackDelay(slot: Slot, index: number, count: number): number {
    return Math.min((count - 1 - index) * slot.frameMs, slot.ifMs) + slot.link.info.turnaroundMs + this.rnd() * slot.ackAirMs;
  }

  private scheduleAck(slot: Slot, pid: Uint8Array, count: number, key: Uint8Array, bitmap: Uint8Array, delay: number, copies = 1): void {
    const k = hex(pid);
    const prior = this.pendingAcks.get(k);
    if (prior) this.cancel(prior.timer);
    const timer = this.after(delay, () => {
      this.pendingAcks.delete(k);
      const frame = encodeFrame({ type: "ack", pid, count, bitmap, mac: ackMac(key, pid, bitmap) });
      for (let i = 0; i < copies; i++) void this.enqueue(slot, frame, PRIO.control, "control");
    });
    this.pendingAcks.set(k, { timer, bitmap });
  }

  private fullBitmap(count: number): Uint8Array {
    const b = new Uint8Array(Math.ceil(count / 8));
    for (let i = 0; i < count; i++) b[i >> 3] |= 1 << (i & 7);
    return b;
  }

  private onData(slot: Slot, d: Extract<Frame, { type: "data" }>, rx: ReceivedFrame): void {
    const pidHex = hex(d.pid);
    const now = this.sched.now();
    const s = this.seen.peek(pidHex);
    if (s && now - s.at < SEEN_MS) return this.onSeenAgain(slot, s, d);
    if (this.ignored.has(pidHex)) return;
    let buf = this.buffers.get(pidHex);
    if (!buf) {
      if (this.buffers.size >= MAX_BUFFERS) {
        let oldest: Buffer | undefined;
        for (const b of this.buffers.values()) if (!oldest || b.lastAt < oldest.lastAt) oldest = b;
        if (oldest) this.dropBuffer(oldest, "buffers-full");
      }
      buf = { pidHex, pid: d.pid, count: d.count, frags: new Array(d.count), have: 0, direct: false, maxTtl: d.ttl, hops: d.hops, minHops: d.hops, attempt: d.attempt, slot, lastAt: now, rssi: rx.rssi };
      this.buffers.set(pidHex, buf);
    }
    if (d.count !== buf.count) return;
    if (!buf.frags[d.index]) {
      buf.frags[d.index] = d.chunk;
      buf.have++;
    }
    buf.lastAt = now;
    if (isDirect(d)) buf.direct = true;
    if (d.ttl > buf.maxTtl) {
      buf.maxTtl = d.ttl;
      buf.hops = d.hops;
    }
    buf.minHops = Math.min(buf.minHops, d.hops);
    if (!buf.decision) this.tryDecide(buf);
    this.cancel(buf.timer);
    const b = buf;
    if (b.have === b.count) return void this.complete(b, d.index);
    b.timer = this.after(slot.ifMs, () => void this.onGap(b));
  }

  private onSeenAgain(slot: Slot, s: Seen, d: Extract<Frame, { type: "data" }>): void {
    // A resend of a packet we have means our ACK was lost: answer with two.
    if (s.ack && isDirect(d)) this.scheduleAck(s.ack.slot, d.pid, s.ack.count, s.ack.key, this.fullBitmap(s.ack.count), this.ackDelay(slot, d.index, d.count), 2);
    const key = `${hex(d.pid)}:${d.attempt}`;
    const r = this.relays.peek(key);
    if (r && !r.done && d.index === 0) {
      r.heard++;
      if (r.heard >= 2) {
        this.cancel(r.timer);
        r.done = true;
        this.drop("relay-suppressed");
      }
    } else if (!r && this.relayOn && d.ttl > 0 && s.packet && !s.mine && d.index === 0) {
      this.scheduleRelay(s.packet, d.pid, d.ttl - 1, d.hops + 1, d.attempt, slot);
    }
    if (s.via && d.index === 0 && d.attempt !== s.via.attempt) {
      s.via.attempt = d.attempt;
      this.viaHandlers.get(s.via.vid)?.(s.via.arrival).catch(() => this.drop("gateway-failed"));
    }
    if (s.receipt && d.index === 0 && d.attempt !== s.receipt.attempt) {
      s.receipt.attempt = d.attempt;
      void this.sendPacket(s.receipt.packet, { ttl: s.receipt.ttl, link: s.receipt.ttl === 0 ? s.receipt.slot.label : undefined });
    }
  }

  private dropBuffer(b: Buffer, reason?: string): void {
    this.cancel(b.timer);
    this.buffers.delete(b.pidHex);
    if (reason) this.drop(reason);
  }

  private prefix(b: Buffer): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const f of b.frags) {
      if (!f) break;
      parts.push(f);
    }
    return concat(...parts);
  }

  private tryDecide(b: Buffer): void {
    const p = this.prefix(b);
    if (!p.length) return;
    const need = p[0] === 1 ? 21 : p[0] === 2 ? (p.length >= 2 ? 2 + p[1] + 32 : 2) : p[0] === 3 ? 10 : p[0] === 5 ? 9 : 1;
    if (p.length < need) return;
    b.decision = this.classify(p);
    b.decision.then((dec) => {
      if (!dec.forMe && !(this.relayOn && b.maxTtl > 0) && this.buffers.get(b.pidHex) === b) {
        this.dropBuffer(b);
        this.ignored.set(b.pidHex, this.sched.now());
      }
    });
  }

  /** Is this packet for one of our identities? Decided from its first bytes. */
  private async classify(p: Uint8Array): Promise<Decision> {
    switch (p[0]) {
      case 1: {
        const tag = p.subarray(1, 5);
        const enc = p.subarray(5, 21);
        for (const { identity } of this.locals.values()) {
          const candidates = [...this.contacts.values()].filter((c) => equal(addressTag(this.keys(identity, c).in, enc), tag));
          if (candidates.length) return { forMe: { kind: "pair", local: identity, candidates } };
        }
        return {};
      }
      case 2: {
        const n = p[1];
        const sealed = p.subarray(2, 2 + n);
        const enc = p.subarray(2 + n, 2 + n + 32);
        for (const { identity } of this.locals.values()) {
          const sender = await openSender(sealed, identity.encryptionSecret, enc);
          if (sender) {
            const accept = this.opts.acceptIntros ?? true;
            const refused = typeof accept === "function" ? !accept(sender) : !accept;
            return { forMe: { kind: "intro", local: identity, sender, refused } };
          }
        }
        return {};
      }
      case 3: {
        const hint = p.subarray(1, 9);
        for (const vid of this.viaHandlers.keys()) {
          const identity = this.locals.get(vid)!.identity;
          if (equal(keyHint(identity.signingPublic), hint)) return { forMe: { kind: "via", local: identity } };
        }
        return {};
      }
      case 5: {
        const out = this.byReceiptTag.get(hex(p.subarray(1, 5)));
        return out ? { forMe: { kind: "receipt", out } } : {};
      }
      default:
        return {};
    }
  }

  private async onGap(b: Buffer): Promise<void> {
    if (this.buffers.get(b.pidHex) !== b) return;
    const dec = b.decision ? await b.decision : {};
    const ack = b.direct ? await this.ackKey(dec) : undefined;
    if (ack && this.buffers.get(b.pidHex) === b) {
      const bitmap = new Uint8Array(Math.ceil(b.count / 8));
      b.frags.forEach((f, i) => f && (bitmap[i >> 3] |= 1 << (i & 7)));
      this.scheduleAck(b.slot, b.pid, b.count, ack, bitmap, b.slot.link.info.turnaroundMs + this.rnd() * b.slot.ackAirMs);
    }
    // Give up on a packet that stops arriving.
    b.timer = this.after(4 * b.slot.ackMs, () => {
      if (this.buffers.get(b.pidHex) === b && this.sched.now() - b.lastAt >= 4 * b.slot.ackMs - 1) this.dropBuffer(b, "incomplete");
    });
  }

  /** k(us→sender) for packets we acknowledge frame by frame: PAIR and accepted INTROs, sent one hop. */
  private async ackKey(dec: Decision): Promise<Uint8Array | undefined> {
    const f = dec.forMe;
    if (f?.kind === "pair") return this.keys(f.local, f.candidates[0]).out;
    if (f?.kind === "intro" && !f.refused) {
      const peer = this.peerKeys(f.sender);
      return peer ? this.keys(f.local, peer).out : undefined;
    }
    return undefined;
  }

  private peerKeys(vid: string): (PeerKeys & { vid: string }) | undefined {
    const c = this.contacts.get(vid);
    if (c) return c;
    try {
      return { vid, ...resolveDidKey(vid) };
    } catch {
      return undefined;
    }
  }

  private async complete(b: Buffer, lastIndex: number): Promise<void> {
    this.dropBuffer(b);
    const packet = concat(...(b.frags as Uint8Array[]));
    const dec = b.decision ? await b.decision : await this.classify(packet);
    const ack = b.direct ? await this.ackKey(dec) : undefined;
    if (!equal(packetId(packet), b.pid)) {
      this.drop("bad-hash");
      if (ack) this.scheduleAck(b.slot, b.pid, b.count, ack, new Uint8Array(Math.ceil(b.count / 8)), this.ackDelay(b.slot, lastIndex, b.count));
      return;
    }
    const relay = this.relayOn && b.maxTtl > 0;
    const seen: Seen = { at: this.sched.now(), mine: false, ...(relay ? { packet } : {}) };
    if (ack) seen.ack = { slot: b.slot, count: b.count, key: ack };
    this.seen.set(b.pidHex, seen);
    if (ack) this.scheduleAck(b.slot, b.pid, b.count, ack, this.fullBitmap(b.count), this.ackDelay(b.slot, lastIndex, b.count));
    const p = decodePacket(packet);
    if (!p) return this.drop("bad-packet");
    this.emit({ type: "packet-in", pid: b.pidHex, kind: p.kind, forMe: !!dec.forMe });
    const consumed = dec.forMe ? await this.handleForMe(dec.forMe, p, b, seen) : false;
    if (relay && !consumed) this.scheduleRelay(packet, b.pid, b.maxTtl - 1, b.hops + 1, b.attempt, b.slot);
  }

  private scheduleRelay(packet: Uint8Array, pid: Uint8Array, ttl: number, hops: number, attempt: number, slot: Slot): void {
    const key = `${hex(pid)}:${attempt}`;
    if (this.relays.has(key)) return;
    const r = { at: this.sched.now(), heard: 0, done: false, timer: undefined as unknown };
    this.relays.set(key, r);
    r.timer = this.after(slot.ifMs + this.rnd() * 2 * slot.ifMs, () => {
      r.done = true;
      for (const s of this.slots) {
        if (!s.link.info.broadcast) continue;
        for (const f of fragment(packet, s.mtu, { ttl, hops: Math.min(hops, 7), attempt })) void this.enqueue(s, f, PRIO.relay, "relay");
      }
    });
    // Forget relay records after 10 minutes.
    this.after(RELAY_MEMORY_MS, () => this.relays.delete(key));
  }

  private async handleForMe(f: ForMe, p: Packet, b: Buffer, seen: Seen): Promise<boolean> {
    switch (f.kind) {
      case "pair": {
        if (p.kind !== "pair") return false;
        for (const c of f.candidates) {
          const parts: TspParts = { senderVid: c.vid, receiverVid: f.local.did, enc: p.enc, ct: p.ct, signature: p.signature };
          if (tspSignatureValid(parts, c.signingKey)) {
            this.deliverTsp(f.local, c, joinTsp(parts), b, seen);
            return true;
          }
        }
        this.drop("signature");
        return false;
      }
      case "intro": {
        if (p.kind !== "intro") return false;
        const peer = this.peerKeys(f.sender);
        if (!peer) return void this.drop("unknown-sender"), false;
        const parts: TspParts = { senderVid: f.sender, receiverVid: f.local.did, enc: p.enc, ct: p.ct, signature: p.signature };
        if (!tspSignatureValid(parts, peer.signingKey)) return void this.drop("signature"), false;
        if (f.refused) {
          this.sendReceipt(f.local, peer, b, RECEIPT_REFUSED, seen);
          this.drop("intro-refused");
          return true;
        }
        const c = this.contacts.get(f.sender) ?? (this.addContactKeys({ vid: peer.vid, signingKey: peer.signingKey, encryptionKey: peer.encryptionKey }), this.contacts.get(f.sender)!);
        this.deliverTsp(f.local, c, joinTsp(parts), b, seen);
        return true;
      }
      case "via": {
        if (p.kind !== "via") return false;
        const handler = this.viaHandlers.get(f.local.did);
        if (!handler) return false;
        const packet = encodePacket(p);
        const arrival: ViaArrival = { packet, pid: b.pid, via: p, hops: b.minHops, link: b.slot.label };
        seen.via = { arrival, vid: f.local.did, attempt: b.attempt };
        handler(arrival).catch(() => this.drop("gateway-failed"));
        return true;
      }
      case "receipt": {
        if (p.kind !== "receipt") return false;
        this.onReceipt(f.out, p, b);
        return true;
      }
    }
  }

  private onReceipt(o: Outgoing, p: Extract<Packet, { kind: "receipt" }>, b: Buffer): void {
    if (o.finished || !equal(p.pid, o.pid)) return;
    if (p.status === RECEIPT_CUSTODY) {
      if (!o.gatewayKey || !ed25519.verify(p.proof, custodyMessage(o.packet, RECEIPT_CUSTODY), o.gatewayKey)) return this.drop("custody-signature");
    } else if (!equal(p.proof, receiptMac(o.kIn, o.pid, p.status))) return this.drop("receipt-mac");
    const who = o.route.route === "gateway" ? o.route.gateway! : this.contacts.get(o.to);
    if (who) this.heard(who, b.minHops, b.slot, b.rssi);
    if (p.status === RECEIPT_OPENED) void this.finish(o, "live");
    else if (p.status === RECEIPT_CUSTODY) void this.finish(o, "queued", o.route.gateway!.vid);
    else void this.finish(o, "undelivered");
  }

  private sendReceipt(local: Identity, peer: PeerKeys & { vid: string }, b: Buffer, status: number, seen: Seen): void {
    const k = this.keys(local, peer).out;
    const packet = encodePacket({ kind: "receipt", tag: receiptTag(k, b.pid), pid: b.pid, status: status as 0 | 2, proof: receiptMac(k, b.pid, status) });
    const ttl = b.direct ? 0 : Math.min(b.minHops + 1, this.maxTtl);
    seen.receipt = { packet, ttl, slot: b.slot, attempt: b.attempt };
    void this.sendPacket(packet, { ttl, link: ttl === 0 ? b.slot.label : undefined });
  }

  private deliverTsp(local: Identity, c: Contact, wire: Uint8Array, b: Buffer, seen: Seen): void {
    this.heard(c, b.minHops, b.slot, b.rssi);
    // One hop: the frame ACKs confirmed it. Otherwise the sender waits for a receipt.
    if (!b.direct) this.sendReceipt(local, c, b, RECEIPT_OPENED, seen);
    const deliver = this.locals.get(local.did)?.deliver;
    if (!deliver) return this.drop("detached");
    this.statsData.delivered++;
    this.inbound = this.inbound.then(() => deliver(wire)).catch(() => {});
  }

  private hints(): Map<string, string[]> {
    if (!this.hintIndex) {
      this.hintIndex = new Map();
      for (const c of this.contacts.values()) {
        const k = hex(keyHint(c.signingKey));
        this.hintIndex.set(k, [...(this.hintIndex.get(k) ?? []), c.vid]);
      }
    }
    return this.hintIndex;
  }

  private onBeaconFrame(slot: Slot, f: Extract<Frame, { type: "beacon" }>, rx: ReceivedFrame): void {
    const signed = beaconSigned(f.role, f.keyHint, f.body);
    const key = hex(concat(signed, f.signature));
    // Relayed copies of one beacon arrive within seconds. A gateway's beacon is the same bytes every
    // minute (same body, deterministic signature), so "seen" must expire, or it is heard only once ever.
    const seenAt = this.beaconsSeen.peek(key);
    if (seenAt !== undefined && this.sched.now() - seenAt < BEACON_SEEN_MS) return;
    const vids = this.hints().get(hex(f.keyHint)) ?? [];
    const vid = vids.find((v) => {
      const c = this.contacts.get(v)!;
      try {
        return ed25519.verify(f.signature, concat(BEACON_LABEL, signed), c.signingKey);
      } catch {
        return false;
      }
    });
    if (!vid) return this.drop("unknown-beacon");
    this.beaconsSeen.set(key, this.sched.now());
    const c = this.contacts.get(vid)!;
    // A beacon is a broadcast: it gives a route, not an introduction. The door may never have heard of us.
    this.heard(c, f.hops, slot, rx.rssi, false);
    const info: BeaconInfo = { role: f.role, vid, atMs: this.sched.now(), ...(f.role === "verifier" ? { nonce: f.body } : {}), ...(rx.rssi !== undefined ? { rssi: rx.rssi } : {}) };
    for (const fn of [...this.beaconListeners]) fn(info);
    if (this.relayOn && f.role === "gateway" && f.hops + 1 <= this.maxTtl) {
      const frame = encodeFrame({ ...f, hops: f.hops + 1 });
      this.after(slot.ifMs + this.rnd() * 2 * slot.ifMs, () => {
        for (const s of this.slots) if (s.link.info.broadcast) void this.enqueue(s, frame, PRIO.relay, "relay");
      });
    }
  }
}

function summarize(bytes: Uint8Array): string {
  const f = decodeFrame(bytes);
  if (!f) return "junk";
  if (f.type === "data") return `DATA ${f.index + 1}/${f.count} pid ${hex(f.pid)}${f.ttl || f.hops ? ` ttl ${f.ttl} hops ${f.hops}` : ""}`;
  if (f.type === "ack") return `ACK pid ${hex(f.pid)}`;
  return `BEACON ${f.role}${f.hops ? ` hops ${f.hops}` : ""}`;
}
