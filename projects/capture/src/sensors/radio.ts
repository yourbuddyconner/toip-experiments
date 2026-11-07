/** A send queue for a half-duplex radio link: one frame at a time, within the link's airtime budget. */
import { RegulatoryViolation } from "@zk-toip/mesh-transport/sim";
import type { Link } from "@zk-toip/mesh-transport";

export class RadioQueue {
  private tail: Promise<unknown> = Promise.resolve();
  dropped = 0;
  sent = 0;
  constructor(private readonly link: Link) {}

  /** Queues a frame. Resolves true once it is on the air, false if the link refused it (budget, closed). */
  send(frame: Uint8Array): Promise<boolean> {
    const p = this.tail.then(async () => {
      try {
        await this.link.send(frame);
        this.sent++;
        return true;
      } catch (e) {
        this.dropped++;
        if (!(e instanceof RegulatoryViolation) && !/not open|already transmitting/.test(String((e as Error)?.message))) throw e;
        return false;
      }
    });
    this.tail = p.catch(() => {});
    return p;
  }
}
