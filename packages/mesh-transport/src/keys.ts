/**
 * Pairwise keys, address tags and MACs (design §8.3), and the sealed VID blocks of INTRO and VIA
 * packets (§8.4). Nothing here names anyone in clear.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hpke } from "@openvtc/vti-tsp-js";
import { didKeyFromPublicKey } from "@openvtc/trust-tasks-proof";
import { resolveDidKey } from "@zk-toip/trust-core";
import { concat, h, utf8 } from "./bytes";

export interface PeerKeys {
  signingKey: Uint8Array;
  encryptionKey: Uint8Array;
}
export interface LocalKeys {
  signingPublic: Uint8Array;
  encryptionSecret: Uint8Array;
}

const SALT = utf8("zk-toip/mesh/v1");
const DIR = utf8("dir");
const TAG = utf8("tag");
const ACK = utf8("ack");
const RCPT = utf8("rcpt");
const INTRO_INFO = utf8("zk-toip/mesh/intro/v1");
const VIA_INFO = utf8("zk-toip/mesh/via/v1");

/** k(me→peer) and k(peer→me), from one X25519 agreement. */
export function pairKeys(me: LocalKeys, peer: PeerKeys): { out: Uint8Array; in: Uint8Array } {
  const ss = x25519.getSharedSecret(me.encryptionSecret, peer.encryptionKey);
  const dir = (from: Uint8Array, to: Uint8Array) => hkdf(sha256, ss, SALT, concat(DIR, from, to), 32);
  return { out: dir(me.signingPublic, peer.signingKey), in: dir(peer.signingKey, me.signingPublic) };
}

const mac = (k: Uint8Array, n: number, ...parts: Uint8Array[]) => hmac(sha256, k, concat(...parts)).slice(0, n);

/** The 4-byte address tag of a packet from S to R, under k(S→R). Fresh for every `enc`. */
export const addressTag = (k: Uint8Array, enc: Uint8Array) => mac(k, 4, TAG, enc.subarray(0, 16));
/** An ACK's MAC, under k(R→S). */
export const ackMac = (k: Uint8Array, pid: Uint8Array, bitmap: Uint8Array) => mac(k, 4, ACK, pid, bitmap);
/** A RECEIPT's tag, under k(R→S). */
export const receiptTag = (k: Uint8Array, pid: Uint8Array) => mac(k, 4, RCPT, pid);
/** The MAC of a receipt with status 0 or 2, under k(R→S). */
export const receiptMac = (k: Uint8Array, pid: Uint8Array, status: number) => mac(k, 8, RCPT, pid, Uint8Array.of(status));

/** H(Ed25519 key)[0..8], naming a door or gateway in its beacons and VIA packets. */
export const keyHint = (signingKey: Uint8Array) => h(signingKey, 8);

/** `0x01 ‖ key` for an Ed25519 did:key, otherwise `0x02 ‖ length ‖ UTF-8`. */
export function vidForm(vid: string): Uint8Array {
  try {
    const { signingKey } = resolveDidKey(vid);
    return concat(Uint8Array.of(1), signingKey);
  } catch {
    const b = utf8(vid);
    if (b.length > 255) throw new Error("VID too long");
    return concat(Uint8Array.of(2, b.length), b);
  }
}

const didKeyFrom = (key: Uint8Array) => didKeyFromPublicKey({ curve: "ed25519", bytes: key }).split("#")[0];

export function readVidForm(b: Uint8Array, pos: number): { vid: string; next: number } | null {
  if (b[pos] === 1 && pos + 33 <= b.length) return { vid: didKeyFrom(b.slice(pos + 1, pos + 33)), next: pos + 33 };
  if (b[pos] === 2 && pos + 2 <= b.length) {
    const n = b[pos + 1];
    if (pos + 2 + n > b.length) return null;
    try {
      return { vid: new TextDecoder("utf-8", { fatal: true }).decode(b.slice(pos + 2, pos + 2 + n)), next: pos + 2 + n };
    } catch {
      return null;
    }
  }
  return null;
}

async function sealTo(plain: Uint8Array, recipientX: Uint8Array, enc: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const s = await hpke.sealBase(plain, enc, recipientX, info);
  return concat(s.enc, s.ciphertext);
}

async function openFrom(block: Uint8Array, secretX: Uint8Array, enc: Uint8Array, info: Uint8Array): Promise<Uint8Array | null> {
  if (block.length < 48) return null;
  try {
    return await hpke.openBase(block.slice(32), enc, block.slice(0, 32), secretX, info);
  } catch {
    return null;
  }
}

/** An INTRO's sealed sender: HPKE base mode to R, bound to the packet's `enc`. 81 bytes for a did:key. */
export const sealSender = (sender: string, recipientX: Uint8Array, enc: Uint8Array) => sealTo(vidForm(sender), recipientX, enc, INTRO_INFO);

export async function openSender(sealed: Uint8Array, secretX: Uint8Array, enc: Uint8Array): Promise<string | null> {
  const plain = await openFrom(sealed, secretX, enc, INTRO_INFO);
  const v = plain && readVidForm(plain, 0);
  return v && v.next === plain!.length ? v.vid : null;
}

/** A VIA's route block for the gateway: both VIDs, sealed to it. 114 bytes for two did:keys. */
export const sealRoute = (sender: string, receiver: string, gatewayX: Uint8Array, enc: Uint8Array) =>
  sealTo(concat(vidForm(sender), vidForm(receiver)), gatewayX, enc, VIA_INFO);

export async function openRoute(block: Uint8Array, secretX: Uint8Array, enc: Uint8Array): Promise<{ sender: string; receiver: string } | null> {
  const plain = await openFrom(block, secretX, enc, VIA_INFO);
  if (!plain) return null;
  const s = readVidForm(plain, 0);
  const r = s && readVidForm(plain, s.next);
  return r && r.next === plain.length ? { sender: s!.vid, receiver: r.vid } : null;
}
