/** A send queue for a half-duplex radio link: one frame at a time, within the link's airtime budget. */
import type { Link } from "@toip-tools/mesh-transport";

export class RadioQueue {
  private tail: Promise<unknown> = Promise.resolve();
  dropped = 0;
  sent = 0;
  lastError?: string;
  constructor(private readonly link: Link) {}

  /**
   * Queues a frame. Resolves true once it is on the air, false if it didn't go out (over the airtime
   * budget, the link closed, the bridge unreachable). A radio frame that doesn't go out is simply lost,
   * as on the air; the chain's links and backfill deal with it. It never rejects.
   */
  send(frame: Uint8Array): Promise<boolean> {
    const p = this.tail.then(async () => {
      try {
        await this.link.send(frame);
        this.sent++;
        return true;
      } catch (e) {
        this.dropped++;
        this.lastError = String((e as Error)?.message ?? e);
        return false;
      }
    });
    this.tail = p;
    return p;
  }
}
