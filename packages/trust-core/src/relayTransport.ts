/**
 * The device side of the relay (design v2 §4.2): a Transport over a WebSocket.
 *
 * It authenticates as the identity's did:key, reconnects with backoff, keeps an outbox of
 * sealed messages it couldn't hand to the relay yet, and acknowledges each delivered message
 * only after it has been processed, so nothing is lost if the device stops mid-way.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { fromB64u, toB64u, utf8 } from "./encoding";
import type { Identity } from "./identity";
import type { Delivery, Transport } from "./transport";

export type RelayStatus = "connecting" | "connected" | "offline";

export interface OutboxItem {
  cid: string;
  from: string;
  to: string;
  wire: string;
}

/** Where the outbox survives a restart. The default keeps it in memory. */
export interface OutboxStore {
  load(): Promise<OutboxItem[]>;
  save(items: OutboxItem[]): Promise<void>;
}

const SENT_TIMEOUT_MS = 10_000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 15_000;
const QUEUE_FULL_RETRY_MS = 30_000;
/** The relay's per-message limit. A larger message is refused here rather than kept in the outbox forever. */
export const MAX_WIRE_BYTES = 256 * 1024;

export class RelayTransport implements Transport {
  status: RelayStatus = "offline";
  private ws?: WebSocket;
  private ready = false;
  private stopped = true;
  private backoff = BACKOFF_START_MS;
  private retry?: ReturnType<typeof setTimeout>;
  private retryFull?: ReturnType<typeof setTimeout>;
  private readonly deliverers = new Map<string, (wire: Uint8Array) => Promise<void>>();
  private outbox: OutboxItem[] = [];
  private loaded: Promise<void>;
  private readonly waiting = new Map<string, (d: Delivery) => void>();
  private readonly statusListeners = new Set<(s: RelayStatus) => void>();
  private seq = 0;
  private inbound: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      url: string;
      identity: Identity;
      outbox?: OutboxStore;
      /** A WebSocket implementation, when the global one isn't suitable (e.g. under jsdom in tests). */
      webSocket?: typeof WebSocket;
    },
  ) {
    this.loaded = (opts.outbox?.load() ?? Promise.resolve([])).then((items) => {
      this.outbox = [...items, ...this.outbox];
    });
  }

  get url(): string {
    return this.opts.url;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.retryFull);
    this.ready = false;
    this.ws?.close();
    this.ws = undefined;
    for (const [cid, resolve] of this.waiting) {
      this.waiting.delete(cid);
      resolve("queued");
    }
    this.setStatus("offline");
  }

  onStatus(fn: (s: RelayStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Messages waiting to be handed to the relay. */
  pending(): number {
    return this.outbox.length;
  }

  attach(vid: string, deliver: (wire: Uint8Array) => Promise<void>): void {
    this.deliverers.set(vid, deliver);
  }

  detach(vid: string): void {
    this.deliverers.delete(vid);
  }

  /** Hands a sealed message to the relay, or keeps it in the outbox until the relay is reachable. */
  async post(from: string, to: string, wire: Uint8Array): Promise<Delivery> {
    await this.loaded;
    if (wire.length > MAX_WIRE_BYTES) return "undelivered";
    const item: OutboxItem = { cid: `${Date.now().toString(36)}-${++this.seq}-${Math.random().toString(36).slice(2, 8)}`, from, to, wire: toB64u(wire) };
    this.outbox.push(item);
    await this.persist();
    if (!this.ready) return "queued";
    return new Promise<Delivery>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(item.cid);
        resolve("queued");
      }, SENT_TIMEOUT_MS);
      this.waiting.set(item.cid, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
      this.transmit(item);
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new (this.opts.webSocket ?? WebSocket)(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // Delivered messages are handled strictly one at a time, in relay order (review I1). Control frames
    // ("sent" in particular) go straight through: handling a message may send, and each send waits for "sent".
    ws.onmessage = (e) => {
      const data = String(e.data);
      if (data.includes('"t":"msg"')) this.inbound = this.inbound.then(() => this.onFrame(ws, data)).catch(() => {});
      else void this.onFrame(ws, data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = undefined;
      for (const [cid, resolve] of this.waiting) {
        this.waiting.delete(cid);
        resolve("queued");
      }
      this.setStatus("offline");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  private async onFrame(ws: WebSocket, text: string): Promise<void> {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    switch (f.t) {
      case "challenge": {
        const sig = ed25519.sign(utf8(`toip-relay-auth/v1|${String(f.nonce)}|${this.opts.url}`), this.opts.identity.signingSecret);
        ws.send(JSON.stringify({ t: "auth", did: this.opts.identity.did, sig: toB64u(sig) }));
        return;
      }
      case "ready":
        this.ready = true;
        this.backoff = BACKOFF_START_MS;
        this.setStatus("connected");
        await this.loaded;
        for (const item of [...this.outbox]) this.transmit(item);
        return;
      case "sent": {
        const cid = String(f.cid);
        this.outbox = this.outbox.filter((i) => i.cid !== cid);
        await this.persist();
        this.waiting.get(cid)?.(f.delivery === "live" ? "live" : "queued");
        this.waiting.delete(cid);
        return;
      }
      case "msg": {
        const deliver = this.deliverers.get(this.opts.identity.did) ?? [...this.deliverers.values()][0];
        try {
          await deliver?.(fromB64u(String(f.wire)));
        } catch {
          // A message this device can't process is dropped, not retried forever.
        }
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "ack", id: f.id }));
        return;
      }
      case "error": {
        const cid = typeof f.cid === "string" ? f.cid : undefined;
        if (cid && f.code === "queueFull") {
          // Temporary: the recipient's queue drains when they come online. Keep it and retry later (review I4).
          this.waiting.get(cid)?.("queued");
          this.waiting.delete(cid);
          clearTimeout(this.retryFull);
          this.retryFull = setTimeout(() => {
            if (this.ready) for (const item of [...this.outbox]) this.transmit(item);
          }, QUEUE_FULL_RETRY_MS);
          return;
        }
        if (cid) {
          // The relay refused this message (too large, queue full, bad recipient). Retrying won't help.
          this.outbox = this.outbox.filter((i) => i.cid !== cid);
          await this.persist();
          this.waiting.get(cid)?.("undelivered");
          this.waiting.delete(cid);
        }
        return;
      }
    }
  }

  private transmit(item: OutboxItem): void {
    if (this.ws?.readyState === 1 /* OPEN */) this.ws.send(JSON.stringify({ t: "send", cid: item.cid, to: item.to, wire: item.wire }));
  }

  private async persist(): Promise<void> {
    await this.opts.outbox?.save(this.outbox);
  }

  private setStatus(s: RelayStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }
}
