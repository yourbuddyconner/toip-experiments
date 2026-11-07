/**
 * "@toip-tools/mesh-transport/node": Node-only pieces. The serial wrapper over the "serialport"
 * package, port listing with board hints, JSON file stores, and re-exports of the GWMP adapter
 * and radio detection.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SerialPort, SerialPortMock } from "serialport";
import type { ReplayRecord, ReplayStore } from "@toip-tools/trust-core";
import type { GatewayStore } from "./gateway";
import type { Contact, ContactStore, MeshOutboxItem, MeshOutboxStore } from "./mesh";
import type { SerialPortLike } from "./serial";

export { GwmpServer, GwmpLink, GWMP, txpkFor } from "./gwmp";
export { detectRadios, probeSerial, listenForGateways, kissEncode, KissDecoder, type RadioDetection } from "./detect";

interface StreamLike {
  readonly path: string;
  open(cb: (e: Error | null) => void): void;
  close(cb: (e: Error | null) => void): void;
  write(data: Buffer, cb: (e: Error | null | undefined) => void): boolean;
  on(event: "data", fn: (b: Buffer) => void): unknown;
  off(event: "data", fn: (b: Buffer) => void): unknown;
  readonly isOpen: boolean;
}

function wrap(sp: StreamLike): SerialPortLike {
  const fns = new Set<(b: Uint8Array) => void>();
  const onData = (b: Buffer) => {
    for (const fn of [...fns]) fn(new Uint8Array(b));
  };
  return {
    label: sp.path,
    open: () =>
      new Promise<void>((resolve, reject) => {
        if (sp.isOpen) return resolve();
        sp.on("data", onData);
        sp.open((e) => (e ? reject(e) : resolve()));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        sp.off("data", onData);
        if (!sp.isOpen) return resolve();
        sp.close(() => resolve());
      }),
    write: (bytes) => new Promise<void>((resolve, reject) => void sp.write(Buffer.from(bytes), (e) => (e ? reject(e) : resolve()))),
    onData(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}

/** A USB serial port through the "serialport" package. 115200 baud for RUI3 and RNode. */
export function nodeSerialPort(path: string, baud = 115200): SerialPortLike {
  return wrap(new SerialPort({ path, baudRate: baud, autoOpen: false }) as unknown as StreamLike);
}

/** The same wrapper over serialport's mock binding, for trying adapters without hardware. */
export function mockSerialPort(path: string, opts: { echo?: boolean } = {}): SerialPortLike {
  SerialPortMock.binding.createPort(path, { echo: opts.echo ?? false, record: true });
  return wrap(new SerialPortMock({ path, baudRate: 115200, autoOpen: false }) as unknown as StreamLike);
}

const HINTS: Record<string, string> = {
  "10c4": "CP210x USB serial bridge (RAK eval boards, Heltec, others)",
  "1a86": "CH340/CH9102 USB serial bridge (LilyGO, Heltec, others)",
  "303a": "ESP32-S3 native USB (Heltec V3, LilyGO T3-S3)",
  "239a": "nRF52 native USB (RAK4631, Adafruit bootloader)",
  "0483": "STM32 USB (some RAK3172 and LoRa-E5 boards)",
};

/** Serial ports, with a hint at the board family from the USB vendor id (never the firmware). */
export async function listSerialPorts(list: () => Promise<{ path: string; vendorId?: string; productId?: string }[]> = () => SerialPort.list()) {
  return (await list()).map((p) => {
    const vendorId = p.vendorId?.toLowerCase();
    const hint = vendorId ? HINTS[vendorId] : undefined;
    return { path: p.path, ...(vendorId ? { vendorId } : {}), ...(p.productId ? { productId: p.productId.toLowerCase() } : {}), ...(hint ? { hint } : {}) };
  });
}

// ---------------------------------------------------------------- JSON file stores

const replacer = (_k: string, v: unknown) => (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64") } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $bytes?: unknown }).$bytes === "string"
    ? new Uint8Array(Buffer.from((v as { $bytes: string }).$bytes, "base64"))
    : v;

/** One JSON file, written whole and atomically (to a temporary file, then renamed). */
export function jsonFile<T>(path: string, empty: T) {
  let writing: Promise<void> = Promise.resolve();
  return {
    async load(): Promise<T> {
      try {
        return JSON.parse(await readFile(path, "utf8"), reviver) as T;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
        throw e;
      }
    },
    save(value: T): Promise<void> {
      const text = JSON.stringify(value, replacer);
      writing = writing.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, path);
      });
      return writing;
    },
  };
}

export const fileContacts = (path: string): ContactStore => jsonFile<Contact[]>(path, []);
export const fileOutbox = (path: string): MeshOutboxStore => jsonFile<MeshOutboxItem[]>(path, []);
export const fileReplayStore = (path: string): ReplayStore => jsonFile<ReplayRecord[]>(path, []);

/** A gateway's custody record in a JSON file: survives restarts, so a resent VIA is never posted twice. */
export function fileGatewayStore(path: string): GatewayStore {
  const f = jsonFile<Record<string, Uint8Array>>(path, {});
  let cache: Promise<Record<string, Uint8Array>> | undefined;
  const all = () => (cache ??= f.load());
  return {
    has: async (pid) => pid in (await all()),
    receipt: async (pid) => (await all())[pid],
    async record(pid, receipt) {
      const m = await all();
      m[pid] = receipt;
      await f.save(m);
    },
  };
}
