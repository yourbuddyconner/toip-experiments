/**
 * Finding the radio (design §14.10). Node only.
 * 1. UDP: listen for a packet forwarder's PULL_DATA: a LoRaWAN gateway.
 * 2. Each serial port: listen (Meshtastic chatters), then a KISS probe (RNode), then an AT probe
 *    (RUI3, or Seeed's LoRa-E5 family). The probes are safe in this order.
 */
import { createSocket } from "node:dgram";
import type { SerialPortLike } from "./serial.js";

export type RadioDetection =
  | { kind: "gwmp-gateway"; eui: string; address: string }
  | { kind: "rak-rui3"; port: string; version: string }
  | { kind: "seeed-at"; port: string; version: string }
  | { kind: "rnode"; port: string; firmware: string; platform?: number; mcu?: number }
  | { kind: "meshtastic"; port: string }
  | { kind: "unknown"; port?: string; heard: string };

const FEND = 0xc0;
const FESC = 0xdb;
const TFEND = 0xdc;
const TFESC = 0xdd;

/** A KISS frame: FEND, command, escaped data, FEND. */
export function kissEncode(command: number, data: Uint8Array): Uint8Array {
  const out = [FEND, command];
  for (const b of data) {
    if (b === FEND) out.push(FESC, TFEND);
    else if (b === FESC) out.push(FESC, TFESC);
    else out.push(b);
  }
  out.push(FEND);
  return Uint8Array.from(out);
}

export class KissDecoder {
  private frame: number[] | null = null;
  private escaped = false;

  push(bytes: Uint8Array): { command: number; data: Uint8Array }[] {
    const out: { command: number; data: Uint8Array }[] = [];
    for (const b of bytes) {
      if (b === FEND) {
        if (this.frame && this.frame.length > 0) out.push({ command: this.frame[0], data: Uint8Array.from(this.frame.slice(1)) });
        this.frame = [];
        this.escaped = false;
        continue;
      }
      if (!this.frame) continue;
      if (this.escaped) {
        this.frame.push(b === TFEND ? FEND : b === TFESC ? FESC : b);
        this.escaped = false;
      } else if (b === FESC) this.escaped = true;
      else this.frame.push(b);
      if (this.frame.length > 1024) this.frame = null;
    }
    return out;
  }
}

/** Collects what a port says for `ms` after `write` (if any). */
async function exchange(port: SerialPortLike, write: Uint8Array | string | undefined, ms: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const off = port.onData((b) => chunks.push(b));
  try {
    if (write !== undefined) await port.write(typeof write === "string" ? new TextEncoder().encode(write) : write);
    await new Promise((r) => setTimeout(r, ms));
  } finally {
    off();
  }
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const all = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

const asText = (b: Uint8Array) => new TextDecoder().decode(b);
const printable = (b: Uint8Array) => asText(b).replace(/[^\x20-\x7e\r\n]/g, ".").trim().slice(0, 200);

function hasMeshtasticMarker(b: Uint8Array): boolean {
  for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x94 && b[i + 1] === 0xc3) return true;
  return /meshtastic/i.test(asText(b));
}

async function kissQuery(port: SerialPortLike, command: number, ms: number): Promise<Uint8Array | undefined> {
  const reply = await exchange(port, kissEncode(command, Uint8Array.of(0x00)), ms);
  return new KissDecoder().push(reply).find((f) => f.command === command)?.data;
}

/** Works out what is on one serial port. */
export async function probeSerial(port: SerialPortLike, opts: { listenMs?: number; probeMs?: number } = {}): Promise<RadioDetection> {
  const listenMs = opts.listenMs ?? 1500;
  const probeMs = opts.probeMs ?? 500;
  await port.open();
  try {
    const heard = await exchange(port, undefined, listenMs);
    if (hasMeshtasticMarker(heard)) return { kind: "meshtastic", port: port.label };
    const detect = await exchange(port, kissEncode(0x08, Uint8Array.of(0x73)), probeMs);
    if (new KissDecoder().push(detect).some((f) => f.command === 0x08 && f.data[0] === 0x46)) {
      const fw = await kissQuery(port, 0x50, probeMs);
      const platform = await kissQuery(port, 0x48, probeMs);
      const mcu = await kissQuery(port, 0x49, probeMs);
      return {
        kind: "rnode",
        port: port.label,
        firmware: fw && fw.length >= 2 ? `${fw[0]}.${fw[1]}` : "unknown",
        ...(platform?.length ? { platform: platform[0] } : {}),
        ...(mcu?.length ? { mcu: mcu[0] } : {}),
      };
    }
    const at = asText(await exchange(port, "AT\r\n", probeMs));
    if (/(^|\s|\+AT: )OK\b/m.test(at)) {
      const rui = asText(await exchange(port, "AT+VER=?\r\n", probeMs));
      const m = /AT\+VER=(\S*RUI\S*)|(RUI_\S+)/.exec(rui);
      if (m) return { kind: "rak-rui3", port: port.label, version: m[1] ?? m[2] };
      const ver = asText(await exchange(port, "AT+VER\r\n", probeMs));
      const s = /\+VER: ?([\w.\-]+)/.exec(ver);
      if (s) return { kind: "seeed-at", port: port.label, version: s[1] };
      return { kind: "unknown", port: port.label, heard: printable(new TextEncoder().encode(at + rui + ver)) };
    }
    return { kind: "unknown", port: port.label, heard: printable(concatAll([heard, detect, new TextEncoder().encode(at)])) };
  } finally {
    await port.close().catch(() => {});
  }
}

const concatAll = (xs: Uint8Array[]) => {
  const out = new Uint8Array(xs.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of xs) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};

/** Listens for PULL_DATA on a UDP port for `ms`: each gateway's EUI and address. */
export async function listenForGateways(port: number, ms: number, onListening?: (port: number) => void): Promise<{ eui: string; address: string }[]> {
  const s = createSocket("udp4");
  const found = new Map<string, string>();
  s.on("message", (m, r) => {
    if (m.length >= 12 && (m[0] === 1 || m[0] === 2) && m[3] === 0x02) {
      found.set(m.subarray(4, 12).toString("hex").toUpperCase(), r.address);
      s.send(Buffer.from([m[0], m[1], m[2], 0x04]), r.port, r.address);
    }
  });
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.bind(port, () => resolve());
  });
  onListening?.(s.address().port);
  await new Promise((r) => setTimeout(r, ms));
  await new Promise<void>((r) => s.close(() => r()));
  return [...found].map(([eui, address]) => ({ eui, address }));
}

export async function detectRadios(
  opts: {
    udpPort?: number;
    timeoutMs?: number;
    listenMs?: number;
    probeMs?: number;
    onUdpListening?: (port: number) => void;
    listPorts?: () => Promise<{ path: string; vendorId?: string; productId?: string; hint?: string }[]>;
    openPort?: (path: string) => SerialPortLike;
  } = {},
): Promise<RadioDetection[]> {
  const udp = listenForGateways(opts.udpPort ?? 1700, opts.timeoutMs ?? 15_000, opts.onUdpListening).catch(() => []);
  let listPorts = opts.listPorts;
  let openPort = opts.openPort;
  if (!listPorts || !openPort) {
    const node = await import("./node.js");
    listPorts ??= node.listSerialPorts;
    openPort ??= (path) => node.nodeSerialPort(path, 115200);
  }
  const serial: RadioDetection[] = [];
  for (const p of await listPorts().catch(() => [])) {
    try {
      serial.push(await probeSerial(openPort(p.path), opts));
    } catch (e) {
      serial.push({ kind: "unknown", port: p.path, heard: `could not open: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const gateways: RadioDetection[] = (await udp).map((g) => ({ kind: "gwmp-gateway", ...g }));
  return [...gateways, ...serial];
}
