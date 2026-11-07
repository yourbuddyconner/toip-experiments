/**
 * A radio in another process: a sensor started with `npm run sensor` joins the world's simulated LoRa
 * medium through this link. Frames go up as POSTs and come down as server-sent events. The world puts
 * them on the air for this node, with the medium's loss, airtime and collisions.
 */
import { loraAirtimeMs, plans, regions, type Link, type LinkInfo, type LinkState, type ReceivedFrame } from "@zk-toip/mesh-transport";
import { b64, fromB64 } from "../core";

export class RemoteSimLink implements Link {
  readonly info: LinkInfo;
  private st: LinkState = "closed";
  private readonly frameFns = new Set<(f: ReceivedFrame) => void>();
  private readonly stateFns = new Set<(s: LinkState) => void>();
  private abort?: AbortController;

  constructor(
    private readonly world: string,
    private readonly name: string,
  ) {
    const tx = plans["us915-a"].tx;
    this.info = { label: `sim-remote:${name}`, kind: "sim", mtu: 250, broadcast: true, halfDuplex: true, reliable: false, turnaroundMs: 10, airtimeMs: (n) => loraAirtimeMs(n, tx), budget: regions.us915 };
  }

  get state(): LinkState {
    return this.st;
  }

  private set(s: LinkState) {
    this.st = s;
    for (const fn of this.stateFns) fn(s);
  }

  async open(): Promise<void> {
    this.abort = new AbortController();
    this.set("opening");
    const res = await fetch(`${this.world}/api/air/${encodeURIComponent(this.name)}/rx`, { signal: this.abort.signal, headers: { accept: "text/event-stream" } });
    if (!res.ok || !res.body) throw new Error(`the world refused the radio link: HTTP ${res.status}`);
    this.set("open");
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const ev = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = ev.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
            if (!data) continue;
            const j = JSON.parse(data) as { frame: string; rssi?: number; snr?: number; at: number };
            const f: ReceivedFrame = { bytes: fromB64(j.frame), atMs: j.at, rssi: j.rssi, snr: j.snr };
            for (const fn of this.frameFns) fn(f);
          }
        }
      } catch {
        // closed
      }
      if (this.st === "open") this.set("failed");
    })();
  }

  async close(): Promise<void> {
    this.abort?.abort();
    this.set("closed");
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.st !== "open") throw new Error(`${this.info.label} is not open`);
    const res = await fetch(`${this.world}/api/air/${encodeURIComponent(this.name)}/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ frame: b64(frame) }) });
    if (!res.ok) throw new Error(`${this.info.label}: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
  }

  onFrame(fn: (f: ReceivedFrame) => void): () => void {
    this.frameFns.add(fn);
    return () => this.frameFns.delete(fn);
  }

  onState(fn: (s: LinkState) => void): () => void {
    this.stateFns.add(fn);
    return () => this.stateFns.delete(fn);
  }
}
