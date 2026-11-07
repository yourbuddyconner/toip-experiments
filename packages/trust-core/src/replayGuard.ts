/**
 * A replay guard whose record survives a restart (mesh design §6, §19.3): a door or gateway that
 * reboots must not run the same Trust Task twice. It behaves like the runtime's InMemoryReplayGuard
 * and writes its whole record to a store after every change.
 */
import type { ReplayGuard, ReplayVerdict } from "@openvtc/trust-tasks/runtime";

export interface ReplayRecord {
  id: string;
  digest: string;
  retainUntil?: number;
  /** The response the first execution produced, so a duplicate can be answered with it. */
  response?: unknown;
  completed: boolean;
}

/** Where the record lives. Load once at start; save gets the whole record, oldest first. */
export interface ReplayStore {
  load(): Promise<ReplayRecord[]>;
  save(records: ReplayRecord[]): Promise<void>;
}

/** A store in memory: survives a new guard, not a new process. For tests. */
export function memoryReplayStore(): ReplayStore & { records: ReplayRecord[] } {
  const s = {
    records: [] as ReplayRecord[],
    async load() {
      return s.records.map((r) => ({ ...r }));
    },
    async save(records: ReplayRecord[]) {
      s.records = records.map((r) => ({ ...r }));
    },
  };
  return s;
}

export class PersistentReplayGuard implements ReplayGuard {
  private readonly entries = new Map<string, ReplayRecord>();
  private readonly capacity: number;
  private readonly loaded: Promise<void>;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ReplayStore,
    opts: { capacity?: number } = {},
  ) {
    this.capacity = opts.capacity ?? 10_000;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.loaded = store.load().then((records) => {
      for (const r of records) this.entries.set(r.id, { ...r });
    });
  }

  /** Resolves once the stored record has been read. */
  ready(): Promise<void> {
    return this.loaded;
  }

  get size(): number {
    return this.entries.size;
  }

  async claim(id: string, digest: string, retainUntil: number | undefined, now: number): Promise<ReplayVerdict> {
    await this.loaded;
    // From here to the save, nothing awaits, so two concurrent claims can't both be fresh.
    const existing = this.entries.get(id);
    if (existing && existing.retainUntil !== undefined && existing.retainUntil <= now) {
      this.entries.delete(id);
    } else if (existing) {
      if (existing.digest !== digest) return { kind: "conflict" };
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing.response === undefined
        ? { kind: "duplicate", inFlight: !existing.completed }
        : { kind: "duplicate", priorResponse: existing.response, inFlight: !existing.completed };
    }
    this.entries.set(id, { id, digest, ...(retainUntil !== undefined ? { retainUntil } : {}), completed: false });
    for (const [k, r] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (r.retainUntil !== undefined && r.retainUntil <= now) this.entries.delete(k);
    }
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    await this.persist();
    return { kind: "fresh" };
  }

  async recordResponse(id: string, response: unknown): Promise<void> {
    await this.loaded;
    const e = this.entries.get(id);
    if (!e) return;
    e.response = response;
    e.completed = true;
    await this.persist();
  }

  async release(id: string, digest: string): Promise<void> {
    await this.loaded;
    const e = this.entries.get(id);
    if (e && e.digest === digest && !e.completed) {
      this.entries.delete(id);
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    const snapshot = [...this.entries.values()].map((r) => ({ ...r }));
    this.saving = this.saving.then(() => this.store.save(snapshot));
    return this.saving;
  }
}
