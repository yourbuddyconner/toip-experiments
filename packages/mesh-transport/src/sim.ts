/**
 * A simulated radio world (design §14.1): frames occupy the channel for their airtime, receivers
 * lose them to half-duplex, collisions (with a capture effect), loss models and injected faults,
 * and every link enforces its region's rules. With a VirtualScheduler it runs fast and repeats exactly.
 */
import { AirtimeBudget, loraAirtimeMs, type AirtimePolicy, type LoRaSetting } from "./airtime";
import { seeded } from "./bytes";
import { LinkEvents, type Link, type LinkInfo, type LinkState, type ReceivedFrame } from "./link";
import type { Scheduler } from "./scheduler";

export { VirtualScheduler } from "./scheduler";

/** Thrown when a link breaks its airtime rules. Tests assert it never is. */
export class RegulatoryViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegulatoryViolation";
  }
}

export interface SimRadioParams {
  /** One setting, or a transmit setting and several receive settings (a gateway). */
  setting: LoRaSetting | { tx: LoRaSetting; rx: LoRaSetting[] };
  mtu: number;
  budget: AirtimePolicy;
  turnaroundMs?: number;
  /** Time from send() to the start of transmission, as over a serial port. */
  serialLatencyMs?: number;
}

/** Bursty loss: a two-state Markov chain per directed pair, stepped once per frame. */
export interface GilbertElliott {
  pGoodToBad: number;
  pBadToGood: number;
  lossGood: number;
  lossBad: number;
}

export type SimFault =
  | { kind: "drop"; from?: string; to?: string; match?: (bytes: Uint8Array) => boolean; count?: number }
  | { kind: "duplicate"; from?: string; to?: string; match?: (bytes: Uint8Array) => boolean; count?: number }
  /** Delays delivery by `delayMs`, so later frames overtake it. */
  | { kind: "delay"; from?: string; to?: string; match?: (bytes: Uint8Array) => boolean; count?: number; delayMs: number }
  /** Flips a byte. Without `passCrc` the radio's CRC catches it and the frame is lost. */
  | { kind: "corrupt"; from?: string; to?: string; match?: (bytes: Uint8Array) => boolean; count?: number; passCrc?: boolean };

export type LossReason = "half-duplex" | "collision" | "loss" | "off" | "crc" | "dropped";

export interface SimRecord {
  atMs: number;
  from: string;
  bytes: Uint8Array;
  airtimeMs: number;
  results: { to: string; ok: boolean; reason?: LossReason }[];
}

interface Quality {
  loss: number;
  burst?: GilbertElliott;
  bad: boolean;
  rssi: number;
  snr: number;
}

interface Tx {
  from: string;
  start: number;
  end: number;
  setting: LoRaSetting;
}

const sameChannel = (a: LoRaSetting, b: LoRaSetting) =>
  a.frequencyHz === b.frequencyHz && a.spreadingFactor === b.spreadingFactor && a.bandwidthHz === b.bandwidthHz;

export class SimMedium {
  readonly scheduler: Scheduler;
  private readonly rnd: () => number;
  private readonly captureDb: number;
  private readonly nodes = new Map<string, SimLink>();
  private readonly quality = new Map<string, Quality>();
  private readonly off = new Set<string>();
  private readonly faults: (SimFault & { left: number })[] = [];
  private readonly log: SimRecord[] = [];
  private readonly listeners = new Set<() => void>();
  private txs: Tx[] = [];

  constructor(opts: { scheduler: Scheduler; seed: number; captureDb?: number }) {
    this.scheduler = opts.scheduler;
    this.rnd = seeded(opts.seed);
    this.captureDb = opts.captureDb ?? 6;
  }

  node(name: string, params: SimRadioParams): SimLink {
    if (this.nodes.has(name)) throw new Error(`node ${name} exists`);
    const link = new SimLink(this, name, params);
    this.nodes.set(name, link);
    return link;
  }

  /** Puts `b` in range of `a` (and `a` of `b`, unless `both` is false). */
  connect(a: string, b: string, q: { loss?: number; burst?: GilbertElliott; rssi?: number; snr?: number; both?: boolean } = {}): void {
    const set = (x: string, y: string) => this.quality.set(`${x}>${y}`, { loss: q.loss ?? 0, burst: q.burst, bad: false, rssi: q.rssi ?? -70, snr: q.snr ?? 9 });
    set(a, b);
    if (q.both !== false) set(b, a);
  }

  disconnect(a: string, b: string): void {
    this.quality.delete(`${a}>${b}`);
    this.quality.delete(`${b}>${a}`);
  }

  power(name: string, on: boolean): void {
    if (on) this.off.delete(name);
    else this.off.add(name);
  }

  isOn(name: string): boolean {
    return !this.off.has(name);
  }

  inject(fault: SimFault): void {
    this.faults.push({ ...fault, left: fault.count ?? 1 });
  }

  records(): readonly SimRecord[] {
    return this.log;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** True while `name` hears a frame on one of its receive settings. */
  busyAt(name: string): boolean {
    const now = this.scheduler.now();
    const me = this.nodes.get(name);
    if (!me) return false;
    return this.txs.some((t) => t.from !== name && t.start <= now && t.end > now && this.quality.has(`${t.from}>${name}`) && me.hears(t.setting));
  }

  transmitting(name: string): boolean {
    const now = this.scheduler.now();
    return this.txs.some((t) => t.from === name && t.end > now);
  }

  /** Called by SimLink.send once the frame passed the link's own checks. Resolves at the end of transmission. */
  transmit(from: SimLink, frame: Uint8Array, airtimeMs: number, latencyMs: number): Promise<void> {
    const start = this.scheduler.now() + latencyMs;
    const tx: Tx = { from: from.name, start, end: start + airtimeMs, setting: from.txSetting };
    this.txs.push(tx);
    const cutoff = this.scheduler.now() - 120_000;
    this.txs = this.txs.filter((t) => t.end > cutoff);
    const bytes = frame.slice();
    return new Promise<void>((resolve) => {
      this.scheduler.setTimeout(() => {
        this.finish(tx, bytes, airtimeMs);
        resolve();
      }, latencyMs + airtimeMs);
    });
  }

  private finish(tx: Tx, bytes: Uint8Array, airtimeMs: number): void {
    const rec: SimRecord = { atMs: tx.start, from: tx.from, bytes, airtimeMs, results: [] };
    for (const [name, link] of this.nodes) {
      if (name === tx.from) continue;
      const q = this.quality.get(`${tx.from}>${name}`);
      if (!q || !link.hears(tx.setting)) continue;
      const lost = (reason: LossReason) => rec.results.push({ to: name, ok: false, reason });
      if (this.off.has(name) || link.state !== "open") {
        lost("off");
        continue;
      }
      const overlaps = (t: Tx) => t !== tx && t.start < tx.end && t.end > tx.start;
      if (this.txs.some((t) => t.from === name && overlaps(t))) {
        lost("half-duplex");
        continue;
      }
      const interferer = this.txs.some((t) => {
        if (t.from === name || !overlaps(t) || !link.hears(t.setting) || !sameChannel(t.setting, tx.setting)) return false;
        const other = this.quality.get(`${t.from}>${name}`);
        return other !== undefined && other.rssi > q.rssi - this.captureDb;
      });
      if (interferer) {
        lost("collision");
        continue;
      }
      let p = q.loss;
      if (q.burst) {
        q.bad = q.bad ? this.rnd() >= q.burst.pBadToGood : this.rnd() < q.burst.pGoodToBad;
        p = Math.max(p, q.bad ? q.burst.lossBad : q.burst.lossGood);
      }
      if (p > 0 && this.rnd() < p) {
        lost("loss");
        continue;
      }
      const fault = this.faults.find((f) => f.left > 0 && (!f.from || f.from === tx.from) && (!f.to || f.to === name) && (!f.match || f.match(bytes)));
      let copy = bytes.slice();
      let delay = 0;
      let times = 1;
      if (fault) {
        fault.left--;
        if (fault.kind === "drop") {
          lost("dropped");
          continue;
        }
        if (fault.kind === "corrupt") {
          if (!fault.passCrc) {
            lost("crc");
            continue;
          }
          const at = copy.length > 8 ? 8 + Math.floor(this.rnd() * (copy.length - 8)) : 0;
          copy[at] ^= 0x5a;
        }
        if (fault.kind === "duplicate") times = 2;
        if (fault.kind === "delay") delay = fault.delayMs;
      }
      rec.results.push({ to: name, ok: true });
      const frame: ReceivedFrame = { bytes: copy, atMs: tx.end + delay, rssi: q.rssi, snr: q.snr, frequencyHz: tx.setting.frequencyHz };
      for (let i = 0; i < times; i++) {
        const d = delay + i;
        if (d === 0) link.receive(frame);
        else this.scheduler.setTimeout(() => link.receive({ ...frame, bytes: frame.bytes.slice(), atMs: this.scheduler.now() }), d);
      }
    }
    this.log.push(rec);
    for (const fn of [...this.listeners]) fn();
  }
}

export class SimLink implements Link {
  readonly info: LinkInfo;
  readonly txSetting: LoRaSetting;
  private readonly rxSettings: LoRaSetting[];
  private readonly events = new LinkEvents();
  private readonly budget: AirtimeBudget;
  private readonly latencyMs: number;

  constructor(
    private readonly medium: SimMedium,
    readonly name: string,
    params: SimRadioParams,
  ) {
    const s = params.setting;
    this.txSetting = "tx" in s ? s.tx : s;
    this.rxSettings = "tx" in s ? s.rx : [s];
    this.budget = new AirtimeBudget(params.budget);
    this.latencyMs = params.serialLatencyMs ?? 0;
    const tx = this.txSetting;
    this.info = {
      label: `sim:${name}`,
      kind: "sim",
      mtu: params.mtu,
      broadcast: true,
      halfDuplex: true,
      reliable: false,
      turnaroundMs: params.turnaroundMs ?? 10,
      airtimeMs: (n) => loraAirtimeMs(n, tx),
      budget: params.budget,
    };
  }

  get state(): LinkState {
    return this.events.state;
  }

  hears(s: LoRaSetting): boolean {
    return this.rxSettings.some((r) => sameChannel(r, s));
  }

  async open(): Promise<void> {
    this.events.setState("open");
  }

  async close(): Promise<void> {
    this.events.setState("closed");
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.state !== "open") throw new Error(`${this.info.label} is not open`);
    if (frame.length > this.info.mtu) throw new Error(`${this.info.label}: ${frame.length}-byte frame over the MTU of ${this.info.mtu}`);
    if (this.medium.transmitting(this.name)) throw new Error(`${this.info.label}: already transmitting`);
    const ms = this.info.airtimeMs(frame.length);
    const now = this.medium.scheduler.now();
    const cap = this.info.budget.maxFrameMs;
    if (cap !== undefined && ms > cap) throw new RegulatoryViolation(`${this.info.label}: ${ms.toFixed(1)} ms frame over the ${cap} ms limit`);
    if (this.budget.waitMs(now, ms, "control") > 0) throw new RegulatoryViolation(`${this.info.label}: airtime budget exceeded`);
    this.budget.record(now, ms, "control");
    if (!this.medium.isOn(this.name)) return;
    await this.medium.transmit(this, frame, ms, this.latencyMs);
  }

  onFrame(fn: (f: ReceivedFrame) => void): () => void {
    return this.events.onFrame(fn);
  }

  onState(fn: (s: LinkState) => void): () => void {
    return this.events.onState(fn);
  }

  channelBusy(): boolean {
    return this.medium.busyAt(this.name);
  }

  /** The medium hands this link a frame it heard. */
  receive(f: ReceivedFrame): void {
    if (this.state === "open" && this.medium.isOn(this.name)) this.events.frame(f);
  }
}
