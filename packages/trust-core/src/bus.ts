import type { TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import type { Clock } from "./clock";
import type { Delivery, Transport } from "./transport";

/** One message on the simulated network, as an observer sees it, plus what its recipient opened. */
export interface WireRecord {
  seq: number;
  at: string;
  from: string;
  to: string;
  bytes: number;
  /** Hex of the last 24 bytes (ciphertext and signature). The first bytes are the cleartext TSP envelope, the same for every message. */
  head: string;
  raw: Uint8Array;
  undelivered?: true;
  opened?: { by: string; document: TrustTaskDocument<unknown> };
  /** Why the recipient's TSP layer refused it, if it did. */
  refused?: string;
}

type Deliver = (wire: Uint8Array, rec: WireRecord) => Promise<void>;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** An in-memory network that delivers bytes by receiver VID, and lets the UI tap every message. */
export class Bus implements Transport {
  private readonly peers = new Map<string, Deliver>();
  private readonly offline = new Set<string>();
  private readonly log: WireRecord[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly inFlight = new Set<Promise<void>>();
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  attach(vid: string, deliver: Deliver): void {
    this.peers.set(vid, deliver);
  }

  detach(vid: string): void {
    this.peers.delete(vid);
  }

  setOnline(vid: string, online: boolean): void {
    if (online) this.offline.delete(vid);
    else this.offline.add(vid);
    this.changed();
  }

  isOnline(vid: string): boolean {
    return this.peers.has(vid) && !this.offline.has(vid);
  }

  /** Records the message and delivers it asynchronously. An unknown or offline recipient marks it undelivered. */
  send(from: string, to: string, wire: Uint8Array): WireRecord {
    const rec: WireRecord = {
      seq: ++this.seq,
      at: this.clock.iso(),
      from,
      to,
      bytes: wire.length,
      head: hex(wire.slice(-24)),
      raw: wire,
    };
    const deliver = this.peers.get(to);
    if (!deliver || this.offline.has(to)) rec.undelivered = true;
    this.log.push(rec);
    this.changed();
    if (!rec.undelivered && deliver) {
      const p: Promise<void> = new Promise<void>((resolve) => queueMicrotask(resolve))
        .then(() => deliver(wire, rec))
        .catch(() => {})
        .finally(() => {
          this.inFlight.delete(p);
          this.changed();
        });
      this.inFlight.add(p);
    }
    return rec;
  }

  async post(from: string, to: string, wire: Uint8Array): Promise<Delivery> {
    return this.send(from, to, wire).undelivered ? "undelivered" : "live";
  }

  records(): readonly WireRecord[] {
    return this.log;
  }

  /** Resolves once every delivery, including the ones those deliveries cause, has finished. */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Lets an agent tell the UI that a record it opened has changed. */
  changed(): void {
    for (const fn of this.listeners) fn();
  }
}
