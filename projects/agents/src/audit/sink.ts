/**
 * The guard's audit trail (design §13), through packages/eventlog. The guard is its only writer. Headers go to
 * the witnesses; bodies stay here and go to the principal by disclosure.
 */
import { coldKeysFromSeed, Controller, exportBundle, MemoryStore, signerFromIdentity, WitnessError, type Bundle, type LogStore, type Trail, type WitnessClient } from "@toip-tools/eventlog";
import type { Clock, Identity } from "@toip-tools/trust-core";

export interface TrailRef {
  i: string;
  s: number;
  d: string;
}

/** What the guard needs from a log. Small, so the log could move elsewhere. */
export interface AuditSink {
  readonly aid: string;
  readonly trailId: string;
  readonly witnesses: string[];
  append(kind: string, body: Record<string, unknown>): Promise<{ s: number; d: string }>;
  /** Appends and waits for a witness receipt. Throws if none comes: the caller must not act (fail closed). */
  appendWitnessed(kind: string, body: Record<string, unknown>): Promise<{ s: number; d: string; ref: TrailRef; receipts: number }>;
  /** Everything verifiable offline, with every body: for the principal. */
  bundle(): Promise<Bundle>;
  /** Number of entries so far, the inception included. */
  size(): number;
  /** Publishes what the witnesses haven't seen yet. */
  flush(): Promise<void>;
}

export { WitnessError };

export class EventlogSink implements AuditSink {
  private publishing: Promise<void> | null = null;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    readonly controller: Controller,
    readonly trail: Trail,
    private readonly clients: WitnessClient[],
    private readonly timeoutMs = 5000,
  ) {}

  get aid(): string {
    return this.controller.aid;
  }
  get trailId(): string {
    return this.trail.id;
  }
  get witnesses(): string[] {
    return this.clients.map((c) => c.aid);
  }
  get store(): LogStore {
    return this.controller.store;
  }

  size(): number {
    return this.trail.head().s + 1;
  }

  async append(kind: string, body: Record<string, unknown>): Promise<{ s: number; d: string }> {
    const { entry } = await this.trail.append({ kind, body: clean(body) });
    this.schedule();
    return { s: entry.s, d: entry.d };
  }

  async appendWitnessed(kind: string, body: Record<string, unknown>): Promise<{ s: number; d: string; ref: TrailRef; receipts: number }> {
    const { entry, receipts } = await this.trail.appendWitnessed({ kind, body: clean(body) }, this.clients, { timeoutMs: this.timeoutMs });
    return { s: entry.s, d: entry.d, ref: { i: this.trail.id, s: entry.s, d: entry.d }, receipts: receipts.length };
  }

  async bundle(): Promise<Bundle> {
    return exportBundle(this.controller.store, this.controller.aid, { bodies: "all" });
  }

  flush(): Promise<void> {
    if (this.publishing) {
      this.again = true;
      return this.publishing;
    }
    this.publishing = (async () => {
      do {
        this.again = false;
        await this.controller.publish(this.clients, { timeoutMs: this.timeoutMs }).catch(() => undefined);
      } while (this.again && !this.closed);
    })().finally(() => {
      this.publishing = null;
    });
    return this.publishing;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 250);
    this.timer.unref?.();
  }
}

/** JSON only: drops undefined, turns bigints into strings, so bodies hash the same everywhere. */
function clean(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 * The agent's trail identity (design §6.1): an AID whose current key is the agent's, whose next keys are the
 * agent's and the principal's (nt = 1, so either can rotate), witnessed by the principal's console and the hub
 * (bt = 1), with a DID binding to the agent's did:key.
 */
export async function createAgentTrail(o: {
  identity: Identity;
  rotationSeed: Uint8Array;
  principalNext: string;
  witnesses: WitnessClient[];
  clock: Clock;
  store?: LogStore;
  timeoutMs?: number;
}): Promise<EventlogSink> {
  const controller = await Controller.incept({
    hot: [signerFromIdentity(o.identity)],
    cold: coldKeysFromSeed(o.rotationSeed, "agent"),
    extraNext: [o.principalNext],
    nt: 1,
    witnesses: o.witnesses.map((w) => w.aid),
    bt: 1,
    bind: o.identity,
    store: o.store ?? new MemoryStore(),
    clock: o.clock,
  });
  const trail = await controller.openTrail("agent/actions");
  return new EventlogSink(controller, trail, o.witnesses, o.timeoutMs);
}
