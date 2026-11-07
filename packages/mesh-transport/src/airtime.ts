/**
 * LoRa time on air, channel plans and region rules (design §12, §14.4).
 * The rules are configuration presets from secondary sources, not legal advice.
 */

export interface LoRaSetting {
  frequencyHz: number;
  spreadingFactor: 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  bandwidthHz: 62500 | 125000 | 250000 | 500000;
  codingRate: 5 | 6 | 7 | 8;
  preambleSymbols: number;
  syncWord: "public" | "private";
  invertIq: boolean;
  txPowerDbm: number;
}

/** A link's airtime budget: a sliding window with a ceiling, and a per-frame cap (dwell time). */
export interface AirtimePolicy {
  windowMs: number;
  /** Share of the window this node may transmit: a legal duty cycle, or our fair share. */
  maxFraction: number;
  /** Longest single transmission allowed. */
  maxFrameMs?: number;
  /** Share of the budget kept back for ACKs and receipts. Default 0.1. */
  ackReserve?: number;
}

export interface ChannelPlan {
  name: string;
  tx: LoRaSetting;
  rx: LoRaSetting;
  mtu: number;
  budget: AirtimePolicy;
}

/** Semtech's time-on-air formula, explicit header, CRC on. Milliseconds. */
export function loraAirtimeMs(payloadBytes: number, s: LoRaSetting): number {
  const sf = s.spreadingFactor;
  const tSym = (2 ** sf / s.bandwidthHz) * 1000;
  const de = tSym > 16 ? 1 : 0;
  const crc = 1;
  const ih = 0;
  const cr = s.codingRate - 4;
  const tPre = (s.preambleSymbols + 4.25) * tSym;
  const nPayload = 8 + Math.max(Math.ceil((8 * payloadBytes - 4 * sf + 28 + 16 * crc - 20 * ih) / (4 * (sf - 2 * de))) * (cr + 4), 0);
  return tPre + nPayload * tSym;
}

/** The largest payload (up to 255 bytes) whose airtime is at most `ms`. 0 when even one byte is too long. */
export function maxBytesUnder(ms: number, s: LoRaSetting): number {
  let best = 0;
  for (let n = 1; n <= 255; n++) if (loraAirtimeMs(n, s) <= ms) best = n;
  return best;
}

const HOUR = 3_600_000;

export const regions: Record<"us915" | "eu868-g1" | "eu868-g3" | "none", AirtimePolicy> = {
  // No duty cycle in the US; 400 ms per transmission on every channel and a 10% fair share (our call).
  us915: { windowMs: HOUR, maxFraction: 0.1, maxFrameMs: 400, ackReserve: 0.1 },
  "eu868-g1": { windowMs: HOUR, maxFraction: 0.01, ackReserve: 0.1 },
  "eu868-g3": { windowMs: HOUR, maxFraction: 0.1, ackReserve: 0.1 },
  none: { windowMs: HOUR, maxFraction: 1, ackReserve: 0.1 },
};

const lora = (frequencyHz: number, spreadingFactor: LoRaSetting["spreadingFactor"], bandwidthHz: LoRaSetting["bandwidthHz"]): LoRaSetting => ({
  frequencyHz,
  spreadingFactor,
  bandwidthHz,
  codingRate: 5,
  preambleSymbols: 8,
  syncWord: "public",
  invertIq: false,
  txPowerDbm: 20,
});

/** 904.6 MHz: the stock US915 gateway's 500 kHz receive channel. 923.3 MHz: its first transmit channel. */
export const US915_UP = lora(904_600_000, 8, 500000);
export const US915_DOWN = lora(923_300_000, 8, 500000);

export const plans: Record<"us915-b-node" | "us915-b-gateway" | "us915-a" | "eu868-g1" | "eu868-g3", ChannelPlan> = {
  "us915-b-node": { name: "us915-b-node", tx: US915_UP, rx: US915_DOWN, mtu: 250, budget: regions.us915 },
  "us915-b-gateway": { name: "us915-b-gateway", tx: US915_DOWN, rx: US915_UP, mtu: 250, budget: regions.us915 },
  "us915-a": { name: "us915-a", tx: US915_UP, rx: US915_UP, mtu: 250, budget: regions.us915 },
  "eu868-g1": { name: "eu868-g1", tx: lora(868_100_000, 7, 125000), rx: lora(868_100_000, 7, 125000), mtu: 250, budget: regions["eu868-g1"] },
  "eu868-g3": { name: "eu868-g3", tx: lora(869_525_000, 7, 125000), rx: lora(869_525_000, 7, 125000), mtu: 250, budget: regions["eu868-g3"] },
};

/** The MTU a plan really allows: its own, capped by the largest frame under the dwell limit. */
export function planMtu(plan: { tx: LoRaSetting; mtu: number; budget: AirtimePolicy }): number {
  const cap = plan.budget.maxFrameMs;
  return cap === undefined ? plan.mtu : Math.min(plan.mtu, maxBytesUnder(cap, plan.tx));
}

export type TrafficClass = "control" | "normal" | "relay";

/**
 * A sliding-window airtime ledger. Every frame counts in full for `windowMs` after it starts.
 * ACKs and receipts ("control") may use the whole budget; other traffic leaves `ackReserve` of it;
 * relayed traffic also stays within `relayShare`.
 */
export class AirtimeBudget {
  private log: { at: number; ms: number; cls: TrafficClass }[] = [];
  constructor(
    readonly policy: AirtimePolicy,
    readonly relayShare = 0.3,
  ) {}

  get capMs(): number {
    return this.policy.maxFraction * this.policy.windowMs;
  }

  private prune(now: number): void {
    const from = now - this.policy.windowMs;
    let i = 0;
    while (i < this.log.length && this.log[i].at <= from) i++;
    if (i) this.log = this.log.slice(i);
  }

  usedMs(now: number, cls?: TrafficClass): number {
    this.prune(now);
    let n = 0;
    for (const e of this.log) if (!cls || e.cls === cls) n += e.ms;
    return n;
  }

  usedFraction(now: number): number {
    return this.usedMs(now) / this.capMs;
  }

  private limit(cls: TrafficClass): number {
    return cls === "control" ? this.capMs : this.capMs * (1 - (this.policy.ackReserve ?? 0.1));
  }

  /** How long until a frame of `ms` may start: 0 for now, Infinity for never (it is over the cap). */
  waitMs(now: number, ms: number, cls: TrafficClass): number {
    if (this.policy.maxFrameMs !== undefined && ms > this.policy.maxFrameMs) return Infinity;
    if (ms > this.limit(cls)) return Infinity;
    this.prune(now);
    const waitFor = (limit: number, only?: TrafficClass) => {
      let excess = this.usedMs(now, only) + ms - limit;
      if (excess <= 1e-9) return 0;
      for (const e of this.log) {
        if (only && e.cls !== only) continue;
        excess -= e.ms;
        if (excess <= 1e-9) return e.at + this.policy.windowMs - now + 1;
      }
      return Infinity;
    };
    let w = waitFor(this.limit(cls));
    if (cls === "relay") {
      const share = this.capMs * this.relayShare;
      if (ms > share) return Infinity;
      w = Math.max(w, waitFor(share, "relay"));
    }
    return w;
  }

  record(now: number, ms: number, cls: TrafficClass): void {
    this.log.push({ at: now, ms, cls });
  }
}
