import { Bus, DemoClock, Policies, identityFromSeed, seedFrom } from "@zk-toip/trust-core";
import { MemberAgent, type Invitation } from "./member";
import { RelayAgent } from "./relay";
import { STEPS } from "./scenario";

export const START = "2026-11-05T14:30:00Z";

/** Everything on the demo's one page: the clock, the network, the relay, and four people's devices. */
export class World {
  readonly clock: DemoClock;
  readonly bus: Bus;
  readonly relay: RelayAgent;
  readonly people: { alice: MemberAgent; bob: MemberAgent; carol: MemberAgent; mallory: MemberAgent };
  /** Ids and invitations the script creates, so later steps and the UI can refer to them. */
  readonly refs: { items: Record<string, string>; invitations: Record<string, Invitation> } = { items: {}, invitations: {} };
  stepIndex = 0;
  private running = false;
  private readonly listeners = new Set<() => void>();

  private constructor(policies: Policies) {
    this.clock = new DemoClock(START);
    this.bus = new Bus(this.clock);
    this.relay = new RelayAgent({ identity: identityFromSeed(seedFrom("shared-todo/relay")), bus: this.bus, clock: this.clock });
    const mk = (name: string) => new MemberAgent({ name, bus: this.bus, clock: this.clock, policies, relayDid: this.relay.did });
    this.people = { alice: mk("Alice"), bob: mk("Bob"), carol: mk("Carol"), mallory: mk("Mallory") };
    const ping = () => this.changed();
    this.bus.subscribe(ping);
    this.clock.subscribe(ping);
    this.relay.subscribe(ping);
    for (const p of Object.values(this.people)) p.subscribe(ping);
  }

  static async create(opts: { policyWasm: BufferSource }): Promise<World> {
    return new World(await Policies.load(opts.policyWasm));
  }

  get busy(): boolean {
    return this.running;
  }

  /** Runs scripted step `n`. Steps run one at a time and in order. */
  async runStep(n: number): Promise<void> {
    if (this.running) throw new Error("busy");
    if (n !== this.stepIndex + 1) throw new Error("out of order");
    const step = STEPS.find((s) => s.n === n);
    if (!step) throw new Error(`no step ${n}`);
    this.running = true;
    this.changed();
    try {
      this.clock.advance(step.advanceMs ?? 60_000);
      await step.run(this);
      await this.bus.settle();
      this.stepIndex = n;
    } finally {
      this.running = false;
      this.changed();
    }
  }

  /** Waits for every message in flight, including any the free-play actions caused. */
  settle(): Promise<void> {
    return this.bus.settle();
  }

  nameOf(did: string): string {
    if (did === this.relay.did) return "Relay";
    if (did === this.people.alice.list?.did) return "Maple St House (list)";
    for (const p of Object.values(this.people)) if (p.did === did) return p.name;
    return `${did.slice(0, 14)}…`;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
