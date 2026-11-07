/**
 * The gateway (design §16.1 item 8): hears sensor frames on the radio, signs a receipt for each with its
 * own clock ("not after"), broadcasts drand beacons ("not before"), and asks sensors for backfill.
 * It can't forge readings: its "evil" switch changes one reading's value, and the verifier shows it.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Link } from "@toip-tools/mesh-transport";
import type { Scheduler } from "@toip-tools/mesh-transport";
import { concat } from "../core/bytes";
import { decodeFrame, encodeBackfill, encodeBeacon, FRAME, readingBody } from "../core/frames";
import { gatewayReceiptMessage, type GatewayReceipt } from "../core/readings";
import { RadioQueue } from "./radio";

export interface HeardFrame {
  bytes: Uint8Array;
  receipt: GatewayReceipt;
  meta: { rssi?: number; snr?: number; link: string; at: number };
  type: number;
}

export interface GatewayBeacon {
  round: number;
  randomness: Uint8Array;
}

export class CaptureGateway {
  readonly id: string;
  readonly publicKey: Uint8Array;
  private readonly queue: RadioQueue;
  private timer: unknown;
  private off?: () => void;
  /** Change the value of the next reading heard (a demo of a dishonest gateway). */
  evil = false;
  stats = { frames: 0, readings: 0, seals: 0, beacons: 0, backfills: 0, bytes: { reading: 0, seal: 0 } };

  constructor(
    private readonly o: {
      link: Link;
      /** The gateway's Ed25519 secret, for receipts. */
      secret: Uint8Array;
      id: string;
      scheduler: Scheduler;
      beacon: () => GatewayBeacon | null;
      beaconEveryMs?: number;
      onFrame: (f: HeardFrame) => void;
      log?: (line: string) => void;
    },
  ) {
    this.id = o.id;
    this.publicKey = ed25519.getPublicKey(o.secret);
    this.queue = new RadioQueue(o.link);
  }

  async start(): Promise<void> {
    await this.o.link.open();
    this.off = this.o.link.onFrame((f) => this.heard(f.bytes, f.atMs, f.rssi, f.snr));
    const tick = () => {
      void this.broadcastBeacon();
      this.timer = this.o.scheduler.setTimeout(tick, this.o.beaconEveryMs ?? 60_000);
    };
    tick();
  }

  stop(): void {
    this.off?.();
    if (this.timer !== undefined) this.o.scheduler.clearTimeout(this.timer);
  }

  async broadcastBeacon(): Promise<boolean> {
    const b = this.o.beacon();
    if (!b) return false;
    this.stats.beacons++;
    return this.queue.send(encodeBeacon(b.round, b.randomness.slice(0, 8)));
  }

  requestBackfill(dev: Uint8Array, fromSeq: number, toSeq: number): Promise<boolean> {
    this.stats.backfills++;
    return this.queue.send(encodeBackfill(dev, fromSeq, toSeq));
  }

  receiptFor(bytes: Uint8Array, at: number): GatewayReceipt {
    return { gateway: this.id, at, sig: ed25519.sign(gatewayReceiptMessage(bytes, at), this.o.secret) };
  }

  private heard(bytes0: Uint8Array, atMs: number, rssi?: number, snr?: number): void {
    let bytes = bytes0;
    let f;
    try {
      f = decodeFrame(bytes);
    } catch {
      return; // not ours: mesh traffic or noise
    }
    if (f.type !== FRAME.reading && f.type !== FRAME.seal && f.type !== FRAME.signedReading) return;
    this.stats.frames++;
    if (f.type === FRAME.reading) {
      this.stats.readings++;
      this.stats.bytes.reading = bytes.length;
      if (this.evil) {
        this.evil = false;
        const r = f.reading;
        const values = r.values.map(([k, v], i) => [k, i === 0 ? v + 250 : v] as [number, number]);
        bytes = concat(Uint8Array.of(FRAME.reading), readingBody({ ...r, values }));
        this.o.log?.(`gateway: changed reading ${r.seq}'s first value by +250 (evil mode)`);
      }
    } else if (f.type === FRAME.seal) {
      this.stats.seals++;
      this.stats.bytes.seal = bytes.length;
    }
    const at = this.o.scheduler.now();
    this.o.onFrame({ bytes, receipt: this.receiptFor(bytes, at), meta: { rssi, snr, link: "sim-lora", at: atMs || at }, type: f.type });
  }
}

/** Encodes a heard frame for the HTTP API. */
export const heardJson = (h: HeardFrame) => ({ type: h.type, frame: Buffer.from(h.bytes).toString("base64"), receipt: { gateway: h.receipt.gateway, at: h.receipt.at, sig: Buffer.from(h.receipt.sig).toString("base64") }, meta: h.meta });
