/**
 * Sneakernet bundles (design §14.12): a file of queued TSP messages that a courier carries to the
 * internet. They hold full TSP bytes, not mesh packets. Sealed to the courier, a copy reveals nothing.
 *
 *   CBOR ["toip-bundle", 1, createdMs, sealed, body]
 *   body (unsealed) = [[to VID, TSP bytes], ...]
 *   body (sealed)   = enc ‖ ct: HPKE base to the courier's X25519 key, info "zk-toip/mesh/bundle/v1"
 */
import { decode, encode } from "cborg";
import { decodeEnvelope, hpke } from "@openvtc/vti-tsp-js";
import type { Delivery, Identity } from "@zk-toip/trust-core";
import { concat, utf8 } from "./bytes";

export interface BundleItem {
  to: string;
  wire: Uint8Array;
}

const MAGIC = "toip-bundle";
const INFO = utf8("zk-toip/mesh/bundle/v1");
const NONE = new Uint8Array(0);

export async function exportBundle(items: BundleItem[], opts: { sealTo?: { vid: string; encryptionKey: Uint8Array }; nowMs?: number } = {}): Promise<Uint8Array> {
  const body = encode(items.map((i) => [i.to, i.wire]));
  const createdMs = opts.nowMs ?? Date.now();
  if (!opts.sealTo) return encode([MAGIC, 1, createdMs, false, body]);
  const s = await hpke.sealBase(body, NONE, opts.sealTo.encryptionKey, INFO);
  return encode([MAGIC, 1, createdMs, true, concat(s.enc, s.ciphertext)]);
}

/** The messages in a bundle. A sealed bundle opens only for the courier it was sealed to. */
export async function openBundle(bytes: Uint8Array, me?: Identity): Promise<BundleItem[]> {
  const outer = decode(bytes) as unknown[];
  if (!Array.isArray(outer) || outer[0] !== MAGIC || outer[1] !== 1 || !(outer[4] instanceof Uint8Array)) throw new Error("not a toip bundle");
  let body = outer[4] as Uint8Array;
  if (outer[3] === true) {
    if (!me) throw new Error("this bundle is sealed to a courier");
    if (body.length < 48) throw new Error("bundle truncated");
    try {
      body = await hpke.openBase(body.slice(32), NONE, body.slice(0, 32), me.encryptionSecret, INFO);
    } catch {
      throw new Error("this bundle is sealed to someone else");
    }
  }
  const list = decode(body) as unknown[];
  if (!Array.isArray(list)) throw new Error("bad bundle body");
  return list.map((e) => {
    if (!Array.isArray(e) || typeof e[0] !== "string" || !(e[1] instanceof Uint8Array)) throw new Error("bad bundle entry");
    return { to: e[0], wire: e[1] };
  });
}

/** Posts every message through a relay transport signed in as the courier. The relay sees the original senders' TSP bytes. */
export async function postBundle(items: BundleItem[], relay: { post(from: string, to: string, wire: Uint8Array): Promise<Delivery> }): Promise<{ posted: number; refused: number }> {
  let posted = 0;
  let refused = 0;
  for (const i of items) {
    let from = "";
    try {
      from = decodeEnvelope(i.wire).envelope.sender;
    } catch {
      refused++;
      continue;
    }
    if ((await relay.post(from, i.to, i.wire)) === "undelivered") refused++;
    else posted++;
  }
  return { posted, refused };
}
