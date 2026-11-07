/**
 * Frames: what a link sends (design §8.5). The top 4 bits of byte 0 are 0xA. The channel may carry
 * other people's traffic, so a frame that fails any check decodes to null and is dropped.
 */
import { concat } from "./bytes";
import { packetId } from "./packet";
import type { LinkInfo } from "./link";

export const FRAME_HEADER = 8;
export const MAX_FRAGMENTS = 64;
export const BEACON_BYTES = 82;

export type Frame =
  | { type: "data"; pid: Uint8Array; index: number; count: number; ttl: number; hops: number; attempt: number; chunk: Uint8Array }
  | { type: "ack"; pid: Uint8Array; count: number; bitmap: Uint8Array; mac: Uint8Array }
  | {
      type: "beacon";
      role: "verifier" | "gateway";
      keyHint: Uint8Array;
      body: Uint8Array;
      signature: Uint8Array;
      /** Times relays have repeated it. 0 is sent as the design's 82 bytes; relayed copies add one byte. */
      hops: number;
    };

export const ackLength = (count: number) => 6 + Math.ceil(count / 8) + 4;

export function encodeFrame(f: Frame): Uint8Array {
  switch (f.type) {
    case "data":
      return concat(Uint8Array.of(0xa0), f.pid, Uint8Array.of(f.index, f.count, (f.ttl << 5) | (f.hops << 2) | f.attempt), f.chunk);
    case "ack":
      return concat(Uint8Array.of(0xa1), f.pid, Uint8Array.of(f.count), f.bitmap, f.mac);
    case "beacon": {
      const signed = beaconSigned(f.role, f.keyHint, f.body);
      return f.hops ? concat(signed, f.signature, Uint8Array.of(f.hops)) : concat(signed, f.signature);
    }
  }
}

/** Bytes 0–17 of a beacon, the part its signature covers (after the "zk-toip/mesh/beacon/v1" label). */
export const beaconSigned = (role: "verifier" | "gateway", keyHint: Uint8Array, body: Uint8Array) =>
  concat(Uint8Array.of(0xa2, role === "verifier" ? 0 : 1), keyHint, body);

export function decodeFrame(b: Uint8Array): Frame | null {
  if (b.length < 1 || b[0] >> 4 !== 0xa) return null;
  switch (b[0]) {
    case 0xa0: {
      if (b.length < FRAME_HEADER + 1) return null;
      const index = b[5];
      const count = b[6];
      if (count < 1 || count > MAX_FRAGMENTS || index >= count) return null;
      return { type: "data", pid: b.slice(1, 5), index, count, ttl: b[7] >> 5, hops: (b[7] >> 2) & 7, attempt: b[7] & 3, chunk: b.slice(FRAME_HEADER) };
    }
    case 0xa1: {
      if (b.length < 7) return null;
      const count = b[5];
      if (count < 1 || count > MAX_FRAGMENTS || b.length !== ackLength(count)) return null;
      const bitmap = b.slice(6, 6 + Math.ceil(count / 8));
      if (count % 8 && bitmap[bitmap.length - 1] >> count % 8) return null;
      return { type: "ack", pid: b.slice(1, 5), count, bitmap, mac: b.slice(b.length - 4) };
    }
    case 0xa2: {
      if (b.length !== BEACON_BYTES && b.length !== BEACON_BYTES + 1) return null;
      if (b[1] > 1) return null;
      const hops = b.length > BEACON_BYTES ? b[BEACON_BYTES] : 0;
      if (b.length > BEACON_BYTES && (hops < 1 || hops > 7)) return null;
      return { type: "beacon", role: b[1] === 0 ? "verifier" : "gateway", keyHint: b.slice(2, 10), body: b.slice(10, 18), signature: b.slice(18, 82), hops };
    }
    default:
      return null;
  }
}

/** Cuts a packet into DATA frames of at most `mtu` bytes. Throws when it needs more than 64. */
export function fragment(packet: Uint8Array, mtu: number, hdr: { ttl: number; hops: number; attempt: number }): Uint8Array[] {
  const room = mtu - FRAME_HEADER;
  if (room < 1) throw new Error("MTU too small");
  const count = Math.max(1, Math.ceil(packet.length / room));
  if (count > MAX_FRAGMENTS) throw new Error(`packet too large: ${packet.length} bytes needs ${count} fragments`);
  const pid = packetId(packet);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    out.push(encodeFrame({ type: "data", pid, index: i, count, ...hdr, chunk: packet.subarray(i * room, (i + 1) * room) }));
  }
  return out;
}

/** Frames and airtime (frames plus one ACK) to send a packet once over `link`. */
export function estimate(packetBytes: number, link: Pick<LinkInfo, "mtu" | "airtimeMs">): { frames: number; airtimeMs: number } {
  const room = link.mtu - FRAME_HEADER;
  const frames = Math.max(1, Math.ceil(packetBytes / room));
  let airtimeMs = 0;
  for (let i = 0; i < frames; i++) airtimeMs += link.airtimeMs(FRAME_HEADER + Math.min(room, packetBytes - i * room));
  return { frames, airtimeMs: airtimeMs + link.airtimeMs(ackLength(frames)) };
}
