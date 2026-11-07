/**
 * A door's challenge beacon (design §8.5, §4.2): a signed BEACON with a fresh nonce every few
 * seconds. A guest signs the nonce into its presentation; the door accepts only recent nonces,
 * so an old presentation fails even after a restart.
 */
import type { Identity } from "@zk-toip/trust-core";
import { equal } from "./bytes";
import type { MeshTransport } from "./mesh";

export class ChallengeBeacon {
  private readonly nonces: Uint8Array[] = [];
  private timer?: unknown;
  private readonly everyMs: number;
  private readonly keep: number;

  constructor(private readonly opts: { identity: Identity; mesh: MeshTransport; everyMs?: number; keep?: number }) {
    this.everyMs = opts.everyMs ?? 15_000;
    this.keep = opts.keep ?? 2;
  }

  start(): void {
    if (this.timer !== undefined) return;
    const tick = () => {
      this.rotate();
      this.timer = this.opts.mesh.scheduler.setTimeout(tick, this.everyMs);
    };
    tick();
  }

  stop(): void {
    if (this.timer !== undefined) this.opts.mesh.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private rotate(): void {
    const nonce = crypto.getRandomValues(new Uint8Array(8));
    this.nonces.unshift(nonce);
    this.nonces.length = Math.min(this.nonces.length, this.keep);
    void this.opts.mesh.sendBeacon("verifier", this.opts.identity.did, nonce).catch(() => {});
  }

  /** The nonce in the latest beacon. */
  current(): Uint8Array {
    if (!this.nonces.length) this.rotate();
    return this.nonces[0];
  }

  /** One of the last `keep` nonces (default 2). */
  isFresh(nonce: Uint8Array): boolean {
    return this.nonces.some((n) => equal(n, nonce));
  }
}
