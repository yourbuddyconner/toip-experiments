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
