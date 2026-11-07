/**
 * The LoRaWAN gateway adapter (design §14.3): a server for Semtech's UDP packet forwarder protocol
 * (GWMP, PROTOCOL.TXT v1.4/v2). The forwarder on the gateway sends us what it hears (PUSH_DATA with
 * rxpk) and keeps a downlink path open (PULL_DATA); we send frames back with PULL_RESP (txpk) and
 * wait for TX_ACK. Node only (node:dgram).
 */
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { loraAirtimeMs, plans, type ChannelPlan, type LoRaSetting } from "./airtime.js";

import { LinkEvents, type Link, type LinkInfo, type LinkState, type ReceivedFrame } from "./link.js";

export const GWMP = { PUSH_DATA: 0x00, PUSH_ACK: 0x01, PULL_DATA: 0x02, PULL_RESP: 0x03, PULL_ACK: 0x04, TX_ACK: 0x05 } as const;

export interface RxPk {
  freq?: number;
  chan?: number;
  rfch?: number;
  stat?: number;
  modu?: string;
  datr?: string;
  codr?: string;
  rssi?: number;
  lsnr?: number;
  size?: number;
  data?: string;
  tmst?: number;
}

/** The txpk for one frame under a plan's transmit setting. `ipol: false` so ordinary nodes (normal IQ) hear it. */
export function txpkFor(frame: Uint8Array, s: LoRaSetting): Record<string, unknown> {
  return {
    imme: true,
    freq: s.frequencyHz / 1e6,
    rfch: 0,
    powe: s.txPowerDbm,
    modu: "LORA",
    datr: `SF${s.spreadingFactor}BW${s.bandwidthHz / 1000}`,
    codr: `4/${s.codingRate}`,
    ipol: s.invertIq,
    prea: s.preambleSymbols,
    size: frame.length,
    data: Buffer.from(frame).toString("base64"),
  };
}

const euiOf = (b: Buffer) => b.subarray(4, 12).toString("hex").toUpperCase();

interface Gateway {
  eui: string;
  link: GwmpLink;
  /** Where its last PULL_DATA came from: the downlink path. */
  down?: { address: string; port: number };
  lastPullMs: number;
}

export class GwmpServer {
  private socket?: Socket;
  private readonly gateways = new Map<string, Gateway>();
  private readonly listeners = new Set<(link: GwmpLink) => void>();
  private readonly txWaiters = new Map<number, (error: string) => void>();
  private watchdog?: ReturnType<typeof setInterval>;
  private boundPort = 0;
  readonly staleMs: number;
  readonly txAckTimeoutMs: number;

  constructor(
    private readonly opts: {
      port?: number;
      host?: string;
      /** Only these gateways (and, if given, only from this address). */
      allow?: { eui: string; address?: string }[];
      log?: (s: string) => void;
      /** The channel plan for every gateway's link. Default us915-b-gateway. */
      plan?: ChannelPlan;
      /** A gateway is "failed" after this long without PULL_DATA. Default 30 s. */
      staleMs?: number;
      txAckTimeoutMs?: number;
    } = {},
  ) {
    this.staleMs = opts.staleMs ?? 30_000;
    this.txAckTimeoutMs = opts.txAckTimeoutMs ?? 1000;
  }

  /** The bound UDP port (useful with port 0). */
  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    if (this.socket) return;
    const s = createSocket("udp4");
    this.socket = s;
    s.on("message", (msg, rinfo) => this.onMessage(msg, rinfo));
    s.on("error", (e) => this.log(`gwmp: socket error ${e.message}`));
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.bind(this.opts.port ?? 1700, this.opts.host, () => {
        s.off("error", reject);
        resolve();
      });
    });
    this.boundPort = s.address().port;
    this.watchdog = setInterval(() => this.checkStale(), Math.min(1000, this.staleMs / 2));
    this.watchdog.unref?.();
    this.log(`gwmp: listening on UDP ${this.boundPort}`);
  }

  async stop(): Promise<void> {
    clearInterval(this.watchdog);
    for (const g of this.gateways.values()) g.link.setState("closed");
    const s = this.socket;
    this.socket = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  onGateway(fn: (link: GwmpLink) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  link(eui: string): GwmpLink | undefined {
    return this.gateways.get(eui.toUpperCase())?.link;
  }

  private log(s: string): void {
    this.opts.log?.(s);
  }

  private allowed(eui: string, rinfo: RemoteInfo): boolean {
    if (!this.opts.allow) return true;
    return this.opts.allow.some((a) => a.eui.toUpperCase() === eui && (!a.address || a.address === rinfo.address));
  }

  private gateway(eui: string): Gateway {
    let g = this.gateways.get(eui);
    if (!g) {
      const link = new GwmpLink(this, eui, this.opts.plan ?? plans["us915-b-gateway"]);
      g = { eui, link, lastPullMs: 0 };
      this.gateways.set(eui, g);
      this.log(`gwmp: gateway ${eui}`);
      for (const fn of [...this.listeners]) fn(link);
    }
    return g;
  }

  private reply(rinfo: RemoteInfo, msg: Buffer, id: number): void {
    this.socket?.send(Buffer.from([msg[0], msg[1], msg[2], id]), rinfo.port, rinfo.address);
  }

  private onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    if (msg.length < 4 || (msg[0] !== 1 && msg[0] !== 2)) return;
    const token = (msg[1] << 8) | msg[2];
    const id = msg[3];
    if (id === GWMP.PUSH_DATA || id === GWMP.PULL_DATA || id === GWMP.TX_ACK) {
      if (msg.length < 12) return;
      const eui = euiOf(msg);
      if (!this.allowed(eui, rinfo)) return this.log(`gwmp: ignored ${eui} from ${rinfo.address}`);
      const g = this.gateway(eui);
      if (id === GWMP.PULL_DATA) {
        this.reply(rinfo, msg, GWMP.PULL_ACK);
        g.down = { address: rinfo.address, port: rinfo.port };
        g.lastPullMs = Date.now();
        g.link.setState("open");
        return;
      }
      if (id === GWMP.PUSH_DATA) {
        this.reply(rinfo, msg, GWMP.PUSH_ACK);
        let body: { rxpk?: RxPk[] };
        try {
          body = JSON.parse(msg.subarray(12).toString("utf8"));
        } catch {
          return this.log("gwmp: bad PUSH_DATA JSON");
        }
        for (const p of body.rxpk ?? []) {
          if (p.stat !== 1 || p.modu !== "LORA" || typeof p.data !== "string") continue;
          const bytes = new Uint8Array(Buffer.from(p.data, "base64"));
          g.link.received({ bytes, atMs: Date.now(), rssi: p.rssi, snr: p.lsnr, frequencyHz: typeof p.freq === "number" ? Math.round(p.freq * 1e6) : undefined });
        }
        return;
      }
      // TX_ACK: optional JSON {"txpk_ack":{"error":"NONE"}}. No JSON (old forwarders) means success.
      let error = "NONE";
      const rest = msg.subarray(12).toString("utf8").replace(/\0+$/, "").trim();
      if (rest) {
        try {
          error = JSON.parse(rest)?.txpk_ack?.error ?? "NONE";
        } catch {
          error = "BAD_JSON";
        }
      }
      this.txWaiters.get(token)?.(error);
      return;
    }
  }

  private checkStale(): void {
    const now = Date.now();
    for (const g of this.gateways.values()) {
      if (g.link.state === "open" && now - g.lastPullMs > this.staleMs) {
        this.log(`gwmp: no PULL_DATA from ${g.eui} for ${this.staleMs} ms`);
        g.link.setState("failed");
      }
    }
  }

  /** Sends one txpk to a gateway and waits for its TX_ACK. Resolves with the error string ("NONE" on success). */
  async transmit(eui: string, txpk: Record<string, unknown>): Promise<string> {
    const g = this.gateways.get(eui);
    if (!g?.down || !this.socket) throw new Error(`gwmp: no downlink path to ${eui} yet (no PULL_DATA)`);
    let token: number;
    do token = Math.floor(Math.random() * 0x10000);
    while (this.txWaiters.has(token));
    const json = Buffer.from(JSON.stringify({ txpk }), "utf8");
    const datagram = Buffer.concat([Buffer.from([2, token >> 8, token & 0xff, GWMP.PULL_RESP]), json]);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.txWaiters.delete(token);
        reject(new Error(`gwmp: no TX_ACK from ${eui}`));
      }, this.txAckTimeoutMs);
      this.txWaiters.set(token, (error) => {
        clearTimeout(timer);
        this.txWaiters.delete(token);
        resolve(error);
      });
      this.socket!.send(datagram, g.down!.port, g.down!.address);
    });
  }
}

export class GwmpLink implements Link {
  readonly info: LinkInfo;
  private readonly events = new LinkEvents();

  constructor(
    private readonly server: GwmpServer,
    readonly eui: string,
    readonly plan: ChannelPlan,
  ) {
    this.info = {
      label: `gwmp:${eui}`,
      kind: "lora",
      mtu: plan.mtu,
      broadcast: true,
      halfDuplex: true,
      reliable: false,
      // The forwarder batches received packets for up to 100 ms, and the downlink queue adds some: a guess, to measure.
      turnaroundMs: 250,
      airtimeMs: (n) => loraAirtimeMs(n, plan.tx),
      budget: plan.budget,
    };
    this.events.state = "opening";
  }

  get state(): LinkState {
    return this.events.state;
  }

  /** Open once the gateway has sent PULL_DATA. Until then the link is "opening". */
  async open(): Promise<void> {}

  async close(): Promise<void> {
    this.events.setState("closed");
  }

  async send(frame: Uint8Array): Promise<void> {
    if (frame.length > this.info.mtu) throw new Error(`${this.info.label}: frame over the MTU`);
    const error = await this.server.transmit(this.eui, txpkFor(frame, this.plan.tx));
    if (error !== "NONE") throw new Error(`gwmp: ${this.eui} refused to transmit: ${error}`);
    // The protocol has no "transmit done" event: wait out the frame's airtime.
    await new Promise((r) => setTimeout(r, this.info.airtimeMs(frame.length)));
  }

  onFrame(fn: (f: ReceivedFrame) => void): () => void {
    return this.events.onFrame(fn);
  }

  onState(fn: (s: LinkState) => void): () => void {
    return this.events.onState(fn);
  }

  /** @internal The server hands the link what the gateway heard. */
  received(f: ReceivedFrame): void {
    this.events.frame(f);
  }

  /** @internal */
  setState(s: LinkState): void {
    this.events.setState(s);
  }
}

