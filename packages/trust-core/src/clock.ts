/** A shared, manually advanced clock, so demo steps are deterministic. No component reads Date.now(). */
export class DemoClock {
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
