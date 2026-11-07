/** Where every component gets the time. Production uses SystemClock; tests use DemoClock. */
export interface Clock {
  now(): number;
  iso(): string;
  date(): Date;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  iso(): string {
    return new Date().toISOString();
  }
  date(): Date {
    return new Date();
  }
}

/** A manually advanced clock, so tests are deterministic. */
export class DemoClock implements Clock {
  private ms: number;
  private readonly listeners = new Set<() => void>();

  constructor(startIso: string) {
    this.ms = Date.parse(startIso);
    if (Number.isNaN(this.ms)) throw new Error(`bad start time: ${startIso}`);
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

  advance(ms: number): void {
    this.ms += ms;
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * A clock that rounds every reading down to `granularityMs` (default one hour), so documents and
 * proofs made with it carry only a coarse time. Tipline's source app and Agora's posts use it.
 */
export class CoarseClock implements Clock {
  constructor(
    private readonly inner: Clock,
    private readonly granularityMs = 3_600_000,
  ) {
    if (!Number.isInteger(granularityMs) || granularityMs < 1) throw new Error("granularity must be a positive number of milliseconds");
  }

  now(): number {
    const t = this.inner.now();
    return t - (((t % this.granularityMs) + this.granularityMs) % this.granularityMs);
  }

  iso(): string {
    return new Date(this.now()).toISOString();
  }

  date(): Date {
    return new Date(this.now());
  }
}
