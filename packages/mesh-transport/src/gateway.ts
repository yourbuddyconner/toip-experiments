/**
 * A gateway (design §11): a mesh node with internet. It opens the route block of each VIA packet
 * that names it, rebuilds the exact TSP bytes, posts them to the relay as itself, and answers the
 * sender with a signed custody receipt. Its record survives restarts, so a resent VIA packet gets
 * the same receipt and is never posted twice.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { resolveDidKey, type Delivery, type Identity } from "@zk-toip/trust-core";
import { concat, h, hex, utf8 } from "./bytes";
import { openRoute, pairKeys, receiptTag } from "./keys";
import type { MeshTransport, ViaArrival } from "./mesh";
import { RECEIPT_CUSTODY, custodyMessage, encodePacket } from "./packet";
import { joinTsp, tspSignatureValid } from "./tsp";

export interface GatewayStore {
  has(pid: string): Promise<boolean>;
  record(pid: string, receipt: Uint8Array): Promise<void>;
  receipt(pid: string): Promise<Uint8Array | undefined>;
}

export function memoryGatewayStore(): GatewayStore {
  const m = new Map<string, Uint8Array>();
  return {
    has: async (pid) => m.has(pid),
    record: async (pid, r) => void m.set(pid, r),
    receipt: async (pid) => m.get(pid),
  };
}

/** Anything that posts to the internet relay: a RelayTransport signed in as the gateway. */
export interface RelayLike {
  post(from: string, to: string, wire: Uint8Array): Promise<Delivery>;
  readonly url?: string;
}

export class MeshGateway {
  private readonly store: GatewayStore;
  private readonly inFlight = new Set<string>();
  private readonly counts = { forwarded: 0, duplicates: 0, failed: 0 };
  private off?: () => void;
  private timer?: unknown;

  constructor(private readonly opts: { identity: Identity; mesh: MeshTransport; relay: RelayLike; store?: GatewayStore; beaconEveryMs?: number }) {
    this.store = opts.store ?? memoryGatewayStore();
  }

  async start(): Promise<void> {
    await this.opts.mesh.start();
    this.off = this.opts.mesh.onVia(this.opts.identity.did, (v) => this.handle(v));
    const every = this.opts.beaconEveryMs ?? 60_000;
    const flags = 0b01; // accepts VIA; no DOWN yet
    const relayHint = h(utf8(this.opts.relay.url ?? ""), 4);
    const body = concat(Uint8Array.of(flags), relayHint, new Uint8Array(3));
    const tick = () => {
      void this.opts.mesh.sendBeacon("gateway", this.opts.identity.did, body).catch(() => {});
      this.timer = this.opts.mesh.scheduler.setTimeout(tick, every);
    };
    tick();
  }

  async stop(): Promise<void> {
    this.off?.();
    if (this.timer !== undefined) this.opts.mesh.scheduler.clearTimeout(this.timer);
  }

  stats(): { forwarded: number; duplicates: number; failed: number } {
    return { ...this.counts };
  }

  private replyRoute(v: ViaArrival) {
    return v.hops === 0 ? { ttl: 0, link: v.link } : { ttl: Math.min(v.hops + 1, 3) };
  }

  private async handle(v: ViaArrival): Promise<void> {
    const pid = hex(v.pid);
    if (this.inFlight.has(pid)) return;
    const prior = await this.store.receipt(pid);
    if (prior) {
      this.counts.duplicates++;
      await this.opts.mesh.sendPacket(prior, this.replyRoute(v));
      return;
    }
    this.inFlight.add(pid);
    try {
      const me = this.opts.identity;
      const route = await openRoute(v.via.routeBlock, me.encryptionSecret, v.via.enc);
      if (!route) return void this.counts.failed++;
      let sender;
      try {
        sender = resolveDidKey(route.sender);
      } catch {
        return void this.counts.failed++;
      }
      const parts = { senderVid: route.sender, receiverVid: route.receiver, enc: v.via.enc, ct: v.via.ct, signature: v.via.signature };
      if (!tspSignatureValid(parts, sender.signingKey)) return void this.counts.failed++;
      const delivery = await this.opts.relay.post(me.did, route.receiver, joinTsp(parts));
      if (delivery === "undelivered") return void this.counts.failed++;
      const k = pairKeys(me, sender).out;
      const proof = ed25519.sign(custodyMessage(v.packet, RECEIPT_CUSTODY), me.signingSecret);
      const receipt = encodePacket({ kind: "receipt", tag: receiptTag(k, v.pid), pid: v.pid, status: RECEIPT_CUSTODY, proof });
      await this.store.record(pid, receipt);
      this.counts.forwarded++;
      await this.opts.mesh.sendPacket(receipt, this.replyRoute(v));
    } finally {
      this.inFlight.delete(pid);
    }
  }
}
