/** Where the mesh gets time and timers. Tests use VirtualScheduler, a clock that jumps from event to event. */

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Lets every pending promise continuation run. */
const flush = () => new Promise<void>((r) => (typeof setImmediate === "function" ? setImmediate(r) : setTimeout(r, 0)));
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Virtual time. Also a trust-core Clock (now, iso, date), so Endpoints on a simulated mesh see
 * the same time as the radio. Every run with the same inputs is identical.
 */
export class VirtualScheduler implements Scheduler {
  private ms: number;
  private seq = 0;
  private timers: Timer[] = [];
  private failure: unknown;
  private held = 0;

  constructor(startMs = Date.parse("2026-11-06T12:00:00.000Z")) {
    this.ms = startMs;
  }

  now(): number {
    return this.ms;
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
  date(): Date {
    return new Date(this.ms);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const t = { id: ++this.seq, at: this.ms + Math.max(0, ms), fn };
    // Keep the list sorted by time, then by creation, so equal times run in order.
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1].at > t.at) i--;
    this.timers.splice(i, 0, t);
    return t.id;
  }

  clearTimeout(handle: unknown): void {
    const i = this.timers.findIndex((t) => t.id === handle);
    if (i >= 0) this.timers.splice(i, 1);
  }

  /** Timers still waiting. */
  pending(): number {
    return this.timers.length;
  }

  /**
   * Freezes virtual time until `p` settles, and returns it. For real I/O inside a simulation (a post
   * to a real relay, say): without it, timers would fire as fast as they can while the I/O is out,
   * and a sender would time out in virtual seconds that took a few real milliseconds.
   */
  hold<T>(p: Promise<T>): Promise<T> {
    this.held++;
    const done = () => void this.held--;
    p.then(done, done);
    return p;
  }

  /** Whether some held I/O is still out. */
  holding(): boolean {
    return this.held > 0;
  }

  /** Waits in real time while held I/O is out. */
  private async thaw(): Promise<void> {
    while (this.held > 0) await realSleep(1);
  }

  private fire(t: Timer): void {
    this.ms = Math.max(this.ms, t.at);
    try {
      t.fn();
    } catch (e) {
      this.failure ??= e;
    }
  }

  private check(): void {
    if (this.failure !== undefined) {
      const e = this.failure;
      this.failure = undefined;
      throw e;
    }
  }

  /** Moves time forward by `ms`, running every timer due on the way. */
  async advance(ms: number): Promise<void> {
    const end = this.ms + ms;
    await flush();
    await this.thaw();
    while (this.timers.length && this.timers[0].at <= end) {
      this.fire(this.timers.shift()!);
      await flush();
      this.check();
      await this.thaw();
    }
    this.ms = end;
    await flush();
    this.check();
  }

  /** Runs timers until none are left, or until `maxMs` of virtual time has passed. */
  async runUntilIdle(opts: { maxMs?: number } = {}): Promise<void> {
    const end = this.ms + (opts.maxMs ?? 30 * 24 * 3600_000);
    await flush();
    await this.thaw();
    while (this.timers.length && this.timers[0].at <= end) {
      this.fire(this.timers.shift()!);
      await flush();
      this.check();
      await this.thaw();
    }
    if (this.timers.length && opts.maxMs !== undefined) this.ms = end;
  }

  /**
   * Runs timers until `p` settles, and returns its result. When nothing is scheduled but `p` is
   * still pending (real I/O, say), it waits in real time, up to `realIdleMs`.
   */
  async run<T>(p: Promise<T>, opts: { maxMs?: number; realIdleMs?: number } = {}): Promise<T> {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    const end = this.ms + (opts.maxMs ?? 7 * 24 * 3600_000);
    let idle = 0;
    await flush();
    while (!settled) {
      this.check();
      if (this.held > 0) {
        await realSleep(1);
        continue;
      }
      const next = this.timers[0];
      if (!next) {
        if (idle >= (opts.realIdleMs ?? 5000)) throw new Error("VirtualScheduler: idle with the promise still pending");
        await realSleep(2);
        idle += 2;
        continue;
      }
      idle = 0;
      if (next.at > end) throw new Error(`VirtualScheduler: promise still pending after ${opts.maxMs ?? "7 days of"} virtual ms`);
      this.fire(this.timers.shift()!);
      await flush();
    }
    this.check();
    return p;
  }
}
