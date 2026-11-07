// Talking to this page's own server, and the demo's shared clock.
import type { Clock } from "@zk-toip/trust-core";

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

/**
 * The demo's clock: real time plus the offset the dev clock has been moved by, read from this
 * page's own server. Every party follows it, so "skip ahead a day" moves everyone.
 */
export class ServerClock implements Clock {
  private offset = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly listeners = new Set<() => void>();

  async sync(): Promise<void> {
    const t0 = Date.now();
    const { now } = await getJson<{ now: number }>("/api/clock");
    const next = now + (Date.now() - t0) / 2 - Date.now();
    const changed = Math.abs(next - this.offset) > 60_000;
    this.offset = next;
    if (changed) for (const fn of this.listeners) fn();
  }

  start(everyMs = 2000): Promise<void> {
    this.timer ??= setInterval(() => void this.sync().catch(() => {}), everyMs);
    return this.sync();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  onJump(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  now(): number {
    return Date.now() + this.offset;
  }
  iso(): string {
    return new Date(this.now()).toISOString();
  }
  date(): Date {
    return new Date(this.now());
  }
}

export const shortDid = (did: string) => (did.length > 28 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did);
export const shortHex = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);

/** "6 November 2026", from an ISO day or time. */
export function longDate(iso: string): string {
  const d = new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** "6 Nov, 14:00 UTC": times in the protocol are to the hour. */
export function hourOf(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)} UTC`;
}
