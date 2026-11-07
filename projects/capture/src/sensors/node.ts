/**
 * A sensor (design §12): takes a reading every interval, chains it, sends it on the radio, and seals the
 * chain head every few readings. It listens for the gateway's beacons and backfill requests.
 */
import type { Link } from "@zk-toip/mesh-transport";
import type { Scheduler } from "@zk-toip/mesh-transport";
import { equal } from "../core/bytes";
import { beaconTag, decodeFrame, FRAME, ReadingChain } from "../core/frames";
import { RadioQueue } from "./radio";

export interface Channels {
  /** One reading: [channel kind, integer value in the channel's scale]. */
  read(atMs: number): [number, number][];
}

/** Simulated channels: temperature and humidity as smooth random walks, PM2.5 with spikes (design §12.6). */
export function simulatedChannels(seed = 1, base = { tempC: 14, rh: 62, pm: 8 }): Channels {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
  let temp = base.tempC;
  let rh = base.rh;
  let pm = base.pm;
  let spike = 0;
  return {
    read: (atMs) => {
      const hour = (atMs / 3_600_000) % 24;
      const daily = Math.sin(((hour - 9) / 24) * 2 * Math.PI) * 0.02;
      temp += (rnd() - 0.5) * 0.12 + daily;
      temp += (base.tempC - temp) * 0.02;
      rh += (rnd() - 0.5) * 0.4 - daily * 2;
      rh += (base.rh - rh) * 0.03;
      if (spike > 0) spike *= 0.6;
      if (rnd() < 0.06) spike = 15 + rnd() * 40;
      pm += (rnd() - 0.5) * 0.6 + (base.pm - pm) * 0.1;
      return [
        [1, Math.round(temp * 100)], // air temperature, 0.01 °C
        [2, Math.round(rh * 10)], // relative humidity, 0.1 %
        [4, Math.round(Math.max(0, pm + spike) * 10)], // PM2.5, 0.1 µg/m³
      ];
    },
  };
}

const BACKFILL_HOLDOFF_MS = 1500;

export class SensorNode {
  private readonly queue: RadioQueue;
  private timer: unknown;
  private off?: () => void;
  private beacon?: { round: number; prefix: Uint8Array };
  private sinceSeal = 0;
  stats = { readings: 0, seals: 0, backfilled: 0, beaconsHeard: 0 };

  constructor(
    readonly chain: ReadingChain,
    private readonly o: {
      link: Link;
      scheduler: Scheduler;
      channels: Channels;
      intervalMs: number;
      /** Seal after this many readings. */
      sealEvery: number;
      /** Added to the scheduler's time to give the device's own clock (a wrong clock, for the demo). */
      clockSkewMs?: number;
      /** Called after each change, so the caller can persist the chain. */
      onChange?: (chain: ReadingChain) => void;
      log?: (line: string) => void;
    },
  ) {
    this.queue = new RadioQueue(o.link);
  }

  get dev(): Uint8Array {
    return this.chain.state.dev;
  }

  async start(): Promise<void> {
    await this.o.link.open();
    this.off = this.o.link.onFrame((f) => this.heard(f.bytes));
    const tick = () => {
      void this.takeReading();
      this.timer = this.o.scheduler.setTimeout(tick, this.o.intervalMs);
    };
    this.timer = this.o.scheduler.setTimeout(tick, Math.min(1000, this.o.intervalMs));
  }

  stop(): void {
    this.off?.();
    if (this.timer !== undefined) this.o.scheduler.clearTimeout(this.timer);
  }

  async takeReading(): Promise<void> {
    const now = this.o.scheduler.now();
    const t = Math.floor((now + (this.o.clockSkewMs ?? 0)) / 1000);
    const tag = this.beacon ? beaconTag(this.beacon.round, this.beacon.prefix) : undefined;
    const frame = this.chain.next(t, this.o.channels.read(now), tag);
    this.stats.readings++;
    this.sinceSeal++;
    this.o.onChange?.(this.chain);
    await this.queue.send(frame);
    if (this.sinceSeal >= this.o.sealEvery) await this.sealNow();
  }

  async sealNow(): Promise<void> {
    const seal = await this.chain.seal(this.beacon);
    if (!seal) return;
    this.sinceSeal = 0;
    this.stats.seals++;
    this.o.onChange?.(this.chain);
    await this.queue.send(seal);
  }

  private heard(bytes: Uint8Array): void {
    let f;
    try {
      f = decodeFrame(bytes);
    } catch {
      return;
    }
    if (f.type === FRAME.beacon) {
      this.beacon = { round: f.round, prefix: f.prefix };
      this.stats.beaconsHeard++;
    } else if (f.type === FRAME.backfill && equal(f.dev, this.dev)) {
      const frames = this.chain.backfill(f.fromSeq, Math.min(f.toSeq, f.fromSeq + 64));
      this.stats.backfilled += frames.length;
      this.o.log?.(`backfill ${f.fromSeq}–${f.toSeq}: resending ${frames.length} frames`);
      // wait for the gateway to finish sending its requests: it can't hear while it transmits
      this.o.scheduler.setTimeout(() => {
        for (const fr of frames) void this.queue.send(fr);
      }, BACKFILL_HOLDOFF_MS);
    }
  }
}
