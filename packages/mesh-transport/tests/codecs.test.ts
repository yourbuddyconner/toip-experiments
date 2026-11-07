import { describe, expect, it } from "vitest";
import { pack, packNested } from "@openvtc/vti-tsp-js";
import { identityFromSeed, seedFrom, resolveDidKey, type Identity } from "@zk-toip/trust-core";
import { loraAirtimeMs, maxBytesUnder, planMtu, plans, regions, AirtimeBudget, type LoRaSetting } from "../src/airtime";
import { seeded } from "../src/bytes";
import { joinTsp, splitTsp, tspSignatureValid } from "../src/tsp";
import { ackMac, addressTag, keyHint, openRoute, openSender, pairKeys, readVidForm, sealRoute, sealSender, vidForm } from "../src/keys";
import { decodePacket, encodePacket, packetId, type Packet } from "../src/packet";
import { MAX_FRAGMENTS, decodeFrame, encodeFrame, fragment, type Frame } from "../src/frame";

const id = (n: string) => identityFromSeed(seedFrom(`codec/${n}`));
const alice = id("alice");
const bob = id("bob");
const gw = id("gateway");

function keysFor(from: Identity, toVidKeys: { encryptionKey: Uint8Array }) {
  return { senderSigningKey: from.signingSecret, senderEncryptionKey: from.encryptionSecret, receiverEncryptionKey: toVidKeys.encryptionKey };
}
async function seal(from: Identity, toVid: string, toKeys: { encryptionKey: Uint8Array }, body: Uint8Array) {
  return (await pack(body, from.did, toVid, keysFor(from, toKeys))).bytes;
}

const setting = (sf: LoRaSetting["spreadingFactor"], bw: LoRaSetting["bandwidthHz"]): LoRaSetting => ({
  frequencyHz: 868_100_000, spreadingFactor: sf, bandwidthHz: bw, codingRate: 5, preambleSymbols: 8, syncWord: "public", invertIq: false, txPowerDbm: 14,
});

describe("LoRa airtime", () => {
  it("matches the design's table (section 12.1)", () => {
    const table: [LoRaSetting["spreadingFactor"], LoRaSetting["bandwidthHz"], number, number][] = [
      [7, 125000, 389, 41], [8, 125000, 687, 82], [9, 125000, 1230, 144], [10, 125000, 2260, 289], [12, 125000, 8860, 1160],
      [7, 500000, 97, 10], [8, 500000, 172, 21], [9, 500000, 307, 36], [10, 500000, 564, 72],
    ];
    for (const [sf, bw, frame, ack] of table) {
      expect(Math.abs(loraAirtimeMs(250, setting(sf, bw)) - frame) / frame).toBeLessThan(0.02);
      expect(Math.abs(loraAirtimeMs(11, setting(sf, bw)) - ack) / ack).toBeLessThan(0.06);
    }
  });

  it("gives the largest frames under the US 400 ms dwell limit (section 12.2)", () => {
    expect(maxBytesUnder(400, setting(10, 500000))).toBe(174);
    expect(maxBytesUnder(400, setting(8, 125000))).toBe(138);
    expect(maxBytesUnder(400, setting(9, 125000))).toBe(66);
    expect(maxBytesUnder(400, setting(10, 125000))).toBe(24);
    expect(planMtu(plans["us915-b-node"])).toBe(250);
    expect(planMtu({ tx: setting(10, 500000), mtu: 250, budget: regions.us915 })).toBe(174);
  });

  it("budgets airtime in a sliding window, keeping a reserve for ACKs and a cap for relaying", () => {
    const b = new AirtimeBudget({ windowMs: 1000, maxFraction: 0.1, maxFrameMs: 50, ackReserve: 0.1 }, 0.3);
    expect(b.waitMs(0, 60, "normal")).toBe(Infinity);
    b.record(0, 50, "normal");
    b.record(10, 40, "normal");
    expect(b.waitMs(20, 1, "normal")).toBeGreaterThan(0);
    expect(b.waitMs(20, 10, "control")).toBe(0);
    expect(b.waitMs(20, 5, "normal")).toBe(981);
    expect(b.waitMs(1001, 40, "normal")).toBe(0);
    const r = new AirtimeBudget({ windowMs: 1000, maxFraction: 0.1 }, 0.3);
    r.record(0, 30, "relay");
    expect(r.waitMs(1, 1, "relay")).toBeGreaterThan(0);
    expect(r.waitMs(1, 1, "normal")).toBe(0);
  });
});

describe("splitting and joining TSP messages", () => {
  it("rebuilds random Direct messages byte for byte, with did:key and other VIDs", async () => {
    const rnd = seeded(1);
    const other = { encryptionKey: resolveDidKey(bob.did).encryptionKey };
    for (let i = 0; i < 300; i++) {
      const body = Uint8Array.from({ length: Math.floor(rnd() * 900) }, () => Math.floor(rnd() * 256));
      const toVid = i % 3 === 0 ? `did:web:example.com:user:${i}` : bob.did;
      const wire = await seal(alice, toVid, other, body);
      const parts = splitTsp(wire);
      expect(parts.senderVid).toBe(alice.did);
      expect(parts.receiverVid).toBe(toVid);
      expect(parts.enc.length).toBe(32);
      expect(parts.signature.length).toBe(64);
      expect(joinTsp(parts)).toEqual(wire);
      expect(tspSignatureValid(parts, alice.signingPublic)).toBe(true);
      expect(tspSignatureValid(parts, bob.signingPublic)).toBe(false);
    }
  });

  it("splits Nested messages too: their outer form is the same", async () => {
    const inner = await seal(alice, bob.did, resolveDidKey(bob.did), new Uint8Array(10));
    const nested = (await packNested(inner, alice.did, gw.did, keysFor(alice, resolveDidKey(gw.did)))).bytes;
    expect(joinTsp(splitTsp(nested))).toEqual(nested);
  });

  it("refuses anything that isn't a canonical Direct TSP message", async () => {
    const wire = await seal(alice, bob.did, resolveDidKey(bob.did), new Uint8Array(20));
    expect(() => splitTsp(wire.slice(0, wire.length - 1))).toThrow();
    expect(() => splitTsp(new Uint8Array([1, 2, 3]))).toThrow();
    const extra = new Uint8Array(wire.length + 3);
    extra.set(wire);
    expect(() => splitTsp(extra)).toThrow();
  });
});

describe("keys and address tags", () => {
  const enc = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 0xff);

  it("derives the same directional keys on both sides, different for each direction", () => {
    const a = pairKeys(alice, resolveDidKey(bob.did));
    const b = pairKeys(bob, resolveDidKey(alice.did));
    expect(a.out).toEqual(b.in);
    expect(a.in).toEqual(b.out);
    expect(a.out).not.toEqual(a.in);
  });

  it("makes a fresh tag per packet that only the intended pair recognizes", () => {
    const k = pairKeys(alice, resolveDidKey(bob.did)).out;
    const tags = new Set<string>();
    for (let i = 0; i < 200; i++) tags.add(Buffer.from(addressTag(k, enc(i))).toString("hex"));
    expect(tags.size).toBe(200);
    const mallory = id("mallory");
    const wrong = pairKeys(bob, resolveDidKey(mallory.did)).in;
    let matches = 0;
    for (let i = 0; i < 200; i++) if (Buffer.from(addressTag(wrong, enc(i))).equals(Buffer.from(addressTag(k, enc(i))))) matches++;
    expect(matches).toBe(0);
    expect(ackMac(k, new Uint8Array(4), new Uint8Array([7]))).toHaveLength(4);
    expect(keyHint(alice.signingPublic)).toHaveLength(8);
  });

  it("writes VIDs compactly, did:key as 33 bytes", () => {
    expect(vidForm(alice.did)).toHaveLength(33);
    expect(readVidForm(vidForm(alice.did), 0)).toEqual({ vid: alice.did, next: 33 });
    const web = "did:web:example.com";
    expect(readVidForm(vidForm(web), 0)).toEqual({ vid: web, next: 2 + web.length });
  });

  it("opens a sealed sender only for the addressee, and a route block only for the gateway", async () => {
    const e = enc(1);
    const sealed = await sealSender(alice.did, bob.encryptionPublic, e);
    expect(sealed.length).toBe(81);
    expect(await openSender(sealed, bob.encryptionSecret, e)).toBe(alice.did);
    expect(await openSender(sealed, gw.encryptionSecret, e)).toBeNull();
    expect(await openSender(sealed, bob.encryptionSecret, enc(2))).toBeNull();
    const block = await sealRoute(alice.did, bob.did, gw.encryptionPublic, e);
    expect(block.length).toBe(114);
    expect(await openRoute(block, gw.encryptionSecret, e)).toEqual({ sender: alice.did, receiver: bob.did });
    expect(await openRoute(block, bob.encryptionSecret, e)).toBeNull();
  });
});

describe("packets", () => {
  const b = (n: number, f = 1) => new Uint8Array(n).fill(f);
  const samples: Packet[] = [
    { kind: "pair", tag: b(4), enc: b(32), ct: b(100), signature: b(64) },
    { kind: "intro", sealedSender: b(81), enc: b(32), ct: b(16), signature: b(64) },
    { kind: "via", gatewayHint: b(8), routeBlock: b(114), enc: b(32), ct: b(40), signature: b(64) },
    { kind: "down", tag: b(4), sealedSender: b(49), enc: b(32), ct: b(40), signature: b(64) },
    { kind: "receipt", tag: b(4), pid: b(4), status: 0, proof: b(8) },
    { kind: "receipt", tag: b(4), pid: b(4), status: 1, proof: b(64) },
    { kind: "receipt", tag: b(4), pid: b(4), status: 2, proof: b(8) },
    { kind: "raw", wire: b(300) },
    { kind: "public", signerHint: b(8), contentType: 3, body: b(20), signature: b(64) },
  ];

  it("round-trips every kind, with the design's fixed sizes", () => {
    for (const p of samples) expect(decodePacket(encodePacket(p))).toEqual(p);
    expect(encodePacket(samples[0]).length).toBe(101 + 100);
    expect(encodePacket(samples[1]).length - 16).toBe(179);
    expect(encodePacket(samples[4]).length).toBe(18);
    expect(encodePacket(samples[5]).length).toBe(74);
    expect(packetId(encodePacket(samples[0]))).toHaveLength(4);
  });

  it("refuses truncated, oversized and malformed packets", () => {
    expect(decodePacket(new Uint8Array(0))).toBeNull();
    expect(decodePacket(Uint8Array.of(0x09, 1, 2))).toBeNull();
    // Shortest valid form of each sample: everything fixed plus a 16-byte AEAD tag.
    const minimum = [117, 195, 236, 167, 18, 74, 18, 2, 74];
    samples.forEach((p, i) => {
      const bytes = encodePacket(p);
      expect(decodePacket(bytes.slice(0, minimum[i] - 1))).toBeNull();
      if (p.kind === "receipt") expect(decodePacket(Uint8Array.of(...bytes, 0))).toBeNull();
    });
    const rnd = seeded(5);
    for (let i = 0; i < 5000; i++) decodePacket(Uint8Array.from({ length: Math.floor(rnd() * 300) }, () => Math.floor(rnd() * 256)));
  });
});

describe("frames and fragmentation", () => {
  it("round-trips every frame type", () => {
    const frames: Frame[] = [
      { type: "data", pid: Uint8Array.of(1, 2, 3, 4), index: 2, count: 3, ttl: 3, hops: 2, attempt: 1, chunk: new Uint8Array(10).fill(9) },
      { type: "ack", pid: Uint8Array.of(1, 2, 3, 4), count: 3, bitmap: Uint8Array.of(0b101), mac: Uint8Array.of(5, 6, 7, 8) },
      { type: "ack", pid: Uint8Array.of(1, 2, 3, 4), count: 64, bitmap: new Uint8Array(8).fill(0xff), mac: Uint8Array.of(5, 6, 7, 8) },
      { type: "beacon", role: "gateway", keyHint: new Uint8Array(8).fill(1), body: new Uint8Array(8).fill(2), signature: new Uint8Array(64).fill(3), hops: 0 },
      { type: "beacon", role: "verifier", keyHint: new Uint8Array(8).fill(1), body: new Uint8Array(8).fill(2), signature: new Uint8Array(64).fill(3), hops: 2 },
    ];
    for (const f of frames) expect(decodeFrame(encodeFrame(f))).toEqual(f);
    expect(encodeFrame(frames[1]).length).toBe(11);
    expect(encodeFrame(frames[3]).length).toBe(82);
  });

  it("drops frames that fail any check, and never throws on junk", () => {
    expect(decodeFrame(Uint8Array.of(0xa0, 1, 2, 3, 4, 3, 3, 0))).toBeNull(); // no chunk
    expect(decodeFrame(Uint8Array.of(0xa0, 1, 2, 3, 4, 0, 65, 0, 1))).toBeNull(); // too many fragments
    expect(decodeFrame(Uint8Array.of(0xa0, 1, 2, 3, 4, 3, 3, 0, 1))).toBeNull(); // index out of range
    expect(decodeFrame(Uint8Array.of(0xa1, 1, 2, 3, 4, 3, 0b1000, 1, 2, 3, 4))).toBeNull(); // bit past count
    expect(decodeFrame(Uint8Array.of(0x94, 0xc3, 0, 4))).toBeNull(); // someone else's traffic
    const rnd = seeded(9);
    for (let i = 0; i < 5000; i++) decodeFrame(Uint8Array.from({ length: Math.floor(rnd() * 100) }, () => Math.floor(rnd() * 256)));
  });

  it("cuts every packet size into frames within the MTU, and rebuilds it", () => {
    const rnd = seeded(3);
    for (const mtu of [20, 24, 66, 138, 250, 254, 512]) {
      const max = MAX_FRAGMENTS * (mtu - 8);
      const sizes = [1, mtu - 9, mtu - 8, mtu - 7, max - 1, max, ...Array.from({ length: 30 }, () => 1 + Math.floor(rnd() * max))];
      for (const n of sizes) {
        const packet = Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
        const frames = fragment(packet, mtu, { ttl: 0, hops: 0, attempt: 0 });
        expect(frames.length).toBe(Math.ceil(n / (mtu - 8)));
        const chunks: Uint8Array[] = [];
        for (const f of frames) {
          expect(f.length).toBeLessThanOrEqual(mtu);
          const d = decodeFrame(f);
          if (d?.type !== "data") throw new Error("not data");
          expect(d.pid).toEqual(packetId(packet));
          chunks[d.index] = d.chunk;
        }
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(packet));
      }
      expect(() => fragment(new Uint8Array(max + 1), mtu, { ttl: 0, hops: 0, attempt: 0 })).toThrow(/too large/);
    }
  });
});
