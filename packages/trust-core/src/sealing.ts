/**
 * Private item text: encrypted once under a fresh item key (ChaCha20-Poly1305), and the key
 * sealed separately to each reader's X25519 key with HPKE base mode (RFC 9180), the suite TSP uses.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { openBase, sealBase } from "@openvtc/vti-tsp-js/hpke";
import { fromB64u, fromUtf8, toB64u, utf8 } from "./encoding.js";
import type { Identity } from "./identity.js";

export interface SealedText {
  nonce: string;
  ciphertext: string;
  keys: { to: string; enc: string; wrapped: string }[];
}

const INFO = utf8("zk-toip/todo/item-key");
const NONE = new Uint8Array(0);

function encryptText(text: string, key: Uint8Array): { nonce: string; ciphertext: string } {
  const nonce = randomBytes(12);
  return { nonce: toB64u(nonce), ciphertext: toB64u(chacha20poly1305(key, nonce).encrypt(utf8(text))) };
}

export async function sealItem(
  text: string,
  readers: { did: string; encryptionPublic: Uint8Array }[],
): Promise<{ key: Uint8Array; sealed: SealedText }> {
  const key = randomBytes(32);
  const keys = await Promise.all(
    readers.map(async (r) => {
      const s = await sealBase(key, NONE, r.encryptionPublic, INFO);
      return { to: r.did, enc: toB64u(s.enc), wrapped: toB64u(s.ciphertext) };
    }),
  );
  return { key, sealed: { ...encryptText(text, key), keys } };
}

/** New text under the item's existing key, for the same readers. */
export function resealText(text: string, key: Uint8Array, prior: SealedText): SealedText {
  return { ...encryptText(text, key), keys: prior.keys };
}

/** Opens the item as `me`. Null when `me` isn't a reader or anything fails to decrypt. */
export async function openItem(sealed: SealedText, me: Identity): Promise<{ key: Uint8Array; text: string } | null> {
  const entry = sealed.keys.find((k) => k.to === me.did);
  if (!entry) return null;
  try {
    const key = await openBase(fromB64u(entry.wrapped), NONE, fromB64u(entry.enc), me.encryptionSecret, INFO);
    const text = fromUtf8(chacha20poly1305(key, fromB64u(sealed.nonce)).decrypt(fromB64u(sealed.ciphertext)));
    return { key, text };
  } catch {
    return null;
  }
}
