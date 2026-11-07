/** The link interface every radio adapter implements (design §13). An adapter only frames bytes. */
import type { AirtimePolicy } from "./airtime.js";

export interface LinkInfo {
  /** "gwmp:AA555A0000000000", "rak:/dev/tty.usbserial-0001", "sim:door". */
  label: string;
  kind: "sim" | "lora" | "ble";
  /** Largest frame this link sends, in bytes. */
  mtu: number;
  /** Everyone in range hears every frame. */
  broadcast: boolean;
  halfDuplex: boolean;
  /** The link retransmits by itself (BLE). */
  reliable: boolean;
  /** From the end of a received frame to when we can transmit. */
  turnaroundMs: number;
  airtimeMs(frameBytes: number): number;
  budget: AirtimePolicy;
}

export interface ReceivedFrame {
  bytes: Uint8Array;
  atMs: number;
  rssi?: number;
  snr?: number;
  frequencyHz?: number;
}

export type LinkState = "closed" | "opening" | "open" | "failed";

export interface Link {
  readonly info: LinkInfo;
  readonly state: LinkState;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Resolves when the frame has been transmitted. It says nothing about who received it. */
  send(frame: Uint8Array): Promise<void>;
  onFrame(fn: (f: ReceivedFrame) => void): () => void;
  onState(fn: (s: LinkState) => void): () => void;
  /** True while the radio senses a busy channel, if it can. */
  channelBusy?(): boolean;
}

/** A small helper for adapters: listener sets for frames and state. */
export class LinkEvents {
  private readonly frameFns = new Set<(f: ReceivedFrame) => void>();
  private readonly stateFns = new Set<(s: LinkState) => void>();
  state: LinkState = "closed";

  onFrame(fn: (f: ReceivedFrame) => void): () => void {
    this.frameFns.add(fn);
    return () => this.frameFns.delete(fn);
  }
  onState(fn: (s: LinkState) => void): () => void {
    this.stateFns.add(fn);
    return () => this.stateFns.delete(fn);
  }
  frame(f: ReceivedFrame): void {
    for (const fn of [...this.frameFns]) fn(f);
  }
  setState(s: LinkState): void {
    if (this.state === s) return;
    this.state = s;
    for (const fn of [...this.stateFns]) fn(s);
  }
}
