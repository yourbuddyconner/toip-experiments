/** Delivery of sealed TSP bytes between VIDs. The in-memory Bus and the WebSocket RelayTransport implement it. */
export type Delivery = "live" | "queued" | "undelivered";

export interface Transport {
  /** Registers the function that receives wires addressed to `vid`. It resolves once the wire is processed. */
  attach(vid: string, deliver: (wire: Uint8Array) => Promise<void>): void;
  detach(vid: string): void;
  post(from: string, to: string, wire: Uint8Array): Promise<Delivery>;
}
