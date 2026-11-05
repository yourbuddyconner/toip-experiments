import { Endpoint, fromB64u, toB64u, type Bus, type DemoClock, type Identity } from "@zk-toip/trust-core";
import { COLLECT, DEPOSIT } from "./specs";

export interface HeldMessage {
  to: string;
  from: string;
  bytes: number;
  head: string;
  at: string;
  wire: string;
}

const hex = (b: Uint8Array) => Array.from(b.slice(0, 24), (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * A mailbox for members who are offline (design 4.4a). It stores already-sealed TSP messages
 * and hands them only to the DID they're sealed for. It can't read or alter them.
 */
export class RelayAgent {
  readonly did: string;
  readonly endpoint: Endpoint;
  private readonly box: HeldMessage[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(opts: { identity: Identity; bus: Bus; clock: DemoClock }) {
    this.did = opts.identity.did;
    this.endpoint = new Endpoint({ identity: opts.identity, bus: opts.bus, clock: opts.clock });
    this.endpoint.handle<{ to: string; wire: string }, { stored: true }>(DEPOSIT, (doc, ctx) => {
      const wire = fromB64u(doc.payload.wire);
      this.box.push({ to: doc.payload.to, from: ctx.sender, bytes: wire.length, head: hex(wire), at: opts.clock.iso(), wire: doc.payload.wire });
      this.changed();
      return { stored: true };
    });
    this.endpoint.handle<Record<string, never>, { wires: string[] }>(COLLECT, (_doc, ctx) => {
      const mine = this.box.filter((m) => m.to === ctx.sender);
      for (const m of mine) this.box.splice(this.box.indexOf(m), 1);
      this.changed();
      return { wires: mine.map((m) => m.wire) };
    });
  }

  held(): Omit<HeldMessage, "wire">[] {
    return this.box.map(({ wire: _w, ...rest }) => rest);
  }

  /** Everything the relay holds, as it holds it. */
  state(): { box: HeldMessage[] } {
    return { box: this.box };
  }

  /** Loses every held message, as a relay might. */
  dropAll(): void {
    this.box.length = 0;
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  static encode(wire: Uint8Array): string {
    return toB64u(wire);
  }
}
