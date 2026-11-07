/** Packets: what the frame layer carries (design §8.4). Decoders return null for anything malformed. */
import { concat, h, utf8 } from "./bytes";

export type PacketKind = "pair" | "intro" | "via" | "down" | "receipt" | "raw" | "public";

export type Packet =
  | { kind: "pair"; tag: Uint8Array; enc: Uint8Array; ct: Uint8Array; signature: Uint8Array }
  | { kind: "intro"; sealedSender: Uint8Array; enc: Uint8Array; ct: Uint8Array; signature: Uint8Array }
  | { kind: "via"; gatewayHint: Uint8Array; routeBlock: Uint8Array; enc: Uint8Array; ct: Uint8Array; signature: Uint8Array }
  | { kind: "down"; tag: Uint8Array; sealedSender: Uint8Array; enc: Uint8Array; ct: Uint8Array; signature: Uint8Array }
  | { kind: "receipt"; tag: Uint8Array; pid: Uint8Array; status: 0 | 1 | 2; proof: Uint8Array }
  | { kind: "raw"; wire: Uint8Array }
  | { kind: "public"; signerHint: Uint8Array; contentType: number; body: Uint8Array; signature: Uint8Array };

export const KIND_BYTE: Record<PacketKind, number> = { pair: 1, intro: 2, via: 3, down: 4, receipt: 5, raw: 6, public: 7 };
export const RECEIPT_OPENED = 0;
export const RECEIPT_CUSTODY = 1;
export const RECEIPT_REFUSED = 2;

/** pid = H(packet)[0..4]. Retransmissions and relayed copies share it. */
export const packetId = (packet: Uint8Array) => h(packet, 4);

/** What a gateway signs in a custody receipt. */
export const custodyMessage = (packet: Uint8Array, status: number) => concat(utf8("zk-toip/mesh/custody/v1"), h(packet, 32), Uint8Array.of(status));

const tail = (enc: Uint8Array, ct: Uint8Array, signature: Uint8Array) => concat(enc, ct, signature);

export function encodePacket(p: Packet): Uint8Array {
  const k = Uint8Array.of(KIND_BYTE[p.kind]);
  switch (p.kind) {
    case "pair":
      return concat(k, p.tag, tail(p.enc, p.ct, p.signature));
    case "intro":
      return concat(k, Uint8Array.of(p.sealedSender.length), p.sealedSender, tail(p.enc, p.ct, p.signature));
    case "via":
      return concat(k, p.gatewayHint, Uint8Array.of(p.routeBlock.length), p.routeBlock, tail(p.enc, p.ct, p.signature));
    case "down":
      return concat(k, p.tag, Uint8Array.of(p.sealedSender.length), p.sealedSender, tail(p.enc, p.ct, p.signature));
    case "receipt":
      return concat(k, p.tag, p.pid, Uint8Array.of(p.status), p.proof);
    case "raw":
      return concat(k, p.wire);
    case "public":
      return concat(k, p.signerHint, Uint8Array.of(p.contentType), p.body, p.signature);
  }
}

/** enc (32) | ct ‖ aead tag (at least 16) | signature (64), from `at` to the end. */
function readTail(b: Uint8Array, at: number) {
  if (b.length - at < 32 + 16 + 64) return null;
  return { enc: b.slice(at, at + 32), ct: b.slice(at + 32, b.length - 64), signature: b.slice(b.length - 64) };
}

export function decodePacket(b: Uint8Array): Packet | null {
  if (b.length < 2) return null;
  switch (b[0]) {
    case 1: {
      const t = readTail(b, 5);
      return t && { kind: "pair", tag: b.slice(1, 5), ...t };
    }
    case 2: {
      const n = b[1];
      if (n < 48) return null;
      const t = readTail(b, 2 + n);
      return t && { kind: "intro", sealedSender: b.slice(2, 2 + n), ...t };
    }
    case 3: {
      if (b.length < 10) return null;
      const n = b[9];
      if (n < 48) return null;
      const t = readTail(b, 10 + n);
      return t && { kind: "via", gatewayHint: b.slice(1, 9), routeBlock: b.slice(10, 10 + n), ...t };
    }
    case 4: {
      if (b.length < 6) return null;
      const n = b[5];
      if (n < 17) return null;
      const t = readTail(b, 6 + n);
      return t && { kind: "down", tag: b.slice(1, 5), sealedSender: b.slice(6, 6 + n), ...t };
    }
    case 5: {
      if (b.length < 10) return null;
      const status = b[9];
      const want = status === RECEIPT_CUSTODY ? 64 : status === RECEIPT_OPENED || status === RECEIPT_REFUSED ? 8 : -1;
      if (want < 0 || b.length !== 10 + want) return null;
      return { kind: "receipt", tag: b.slice(1, 5), pid: b.slice(5, 9), status: status as 0 | 1 | 2, proof: b.slice(10) };
    }
    case 6:
      return { kind: "raw", wire: b.slice(1) };
    case 7:
      if (b.length < 74) return null;
      return { kind: "public", signerHint: b.slice(1, 9), contentType: b[9], body: b.slice(10, b.length - 64), signature: b.slice(b.length - 64) };
    default:
      return null;
  }
}
