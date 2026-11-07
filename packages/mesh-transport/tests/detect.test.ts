import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { KissDecoder, detectRadios, kissEncode, probeSerial } from "../src/detect";
import type { SerialPortLike } from "../src/serial";

/** A serial port that answers what it is written with a function of the bytes so far. */
function fakePort(label: string, opts: { chatter?: Uint8Array; answer?: (written: Uint8Array) => Uint8Array | string | undefined }): SerialPortLike {
  const fns = new Set<(b: Uint8Array) => void>();
  const say = (x: Uint8Array | string) => {
    const b = typeof x === "string" ? new TextEncoder().encode(x) : x;
    setTimeout(() => fns.forEach((f) => f(b)), 5);
  };
  return {
    label,
    async open() {
      if (opts.chatter) say(opts.chatter);
    },
    async close() {},
    async write(bytes) {
      const a = opts.answer?.(bytes);
      if (a !== undefined) say(a);
    },
    onData(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const fast = { listenMs: 30, probeMs: 60 };

const rui3 = () =>
  fakePort("/dev/rak", {
    answer: (b) => (text(b) === "AT\r\n" ? "OK\r\n" : text(b) === "AT+VER=?\r\n" ? "AT+VER=RUI_4.0.6_RAK3172-E\r\nOK\r\n" : undefined),
  });
const seeed = () =>
  fakePort("/dev/e5", {
    answer: (b) => (text(b) === "AT\r\n" ? "+AT: OK\r\n" : text(b) === "AT+VER=?\r\n" ? "+VER=?: ERROR(-1)\r\n" : text(b) === "AT+VER\r\n" ? "+VER: 4.0.11\r\n" : undefined),
  });
const rnode = () =>
  fakePort("/dev/rnode", {
    answer: (b) => {
      const frames = new KissDecoder().push(b);
      const f = frames[0];
      if (!f) return undefined;
      if (f.command === 0x08 && f.data[0] === 0x73) return kissEncode(0x08, Uint8Array.of(0x46));
      if (f.command === 0x50) return kissEncode(0x50, Uint8Array.of(1, 74));
      if (f.command === 0x48) return kissEncode(0x48, Uint8Array.of(0x80));
      if (f.command === 0x49) return kissEncode(0x49, Uint8Array.of(0x81));
      return undefined;
    },
  });
const meshtastic = () => fakePort("/dev/mt", { chatter: Uint8Array.of(0x94, 0xc3, 0x00, 0x05, 1, 2, 3, 4, 5) });
const silent = () => fakePort("/dev/quiet", {});

describe("KISS framing", () => {
  it("escapes FEND and FESC and decodes across reads", () => {
    const data = Uint8Array.of(1, 0xc0, 2, 0xdb, 3);
    const enc = kissEncode(0x00, data);
    expect([...enc]).toEqual([0xc0, 0x00, 1, 0xdb, 0xdc, 2, 0xdb, 0xdd, 3, 0xc0]);
    const d = new KissDecoder();
    expect(d.push(enc.slice(0, 4))).toEqual([]);
    expect(d.push(enc.slice(4))).toEqual([{ command: 0, data }]);
  });
});

describe("probing serial ports", () => {
  it("tells a RUI3 module, a Seeed AT modem, an RNode, Meshtastic and silence apart", async () => {
    expect(await probeSerial(rui3(), fast)).toEqual({ kind: "rak-rui3", port: "/dev/rak", version: "RUI_4.0.6_RAK3172-E" });
    expect(await probeSerial(seeed(), fast)).toEqual({ kind: "seeed-at", port: "/dev/e5", version: "4.0.11" });
    expect(await probeSerial(rnode(), fast)).toEqual({ kind: "rnode", port: "/dev/rnode", firmware: "1.74", platform: 0x80, mcu: 0x81 });
    expect(await probeSerial(meshtastic(), fast)).toEqual({ kind: "meshtastic", port: "/dev/mt" });
    expect(await probeSerial(silent(), fast)).toEqual({ kind: "unknown", port: "/dev/quiet", heard: "" });
  });
});

describe("detectRadios", () => {
  it("finds a LoRaWAN gateway by its PULL_DATA, and probes every serial port", async () => {
    const ports: Record<string, () => SerialPortLike> = { "/dev/rak": rui3, "/dev/quiet": silent };
    const found = await detectRadios({
      udpPort: 0,
      timeoutMs: 300,
      ...fast,
      onUdpListening: (port) => {
        const s = createSocket("udp4");
        const pull = Buffer.concat([Buffer.from([2, 0xab, 0xcd, 0x02]), Buffer.from("AA555A0000000001", "hex")]);
        s.send(pull, port, "127.0.0.1", () => setTimeout(() => s.close(), 50));
      },
      listPorts: async () => [{ path: "/dev/rak", vendorId: "10c4", productId: "ea60" }, { path: "/dev/quiet" }],
      openPort: (path) => ports[path](),
    });
    expect(found).toContainEqual({ kind: "gwmp-gateway", eui: "AA555A0000000001", address: "127.0.0.1" });
    expect(found).toContainEqual({ kind: "rak-rui3", port: "/dev/rak", version: "RUI_4.0.6_RAK3172-E" });
    expect(found).toContainEqual({ kind: "unknown", port: "/dev/quiet", heard: "" });
  });
});
