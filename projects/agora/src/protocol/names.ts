/**
 * Nym names (design §10.1): two bytes of SHA-256(nym) pick an adjective and a noun, a third gives a
 * number from 0 to 99. Names are cosmetic. Clashes are possible; the full nym is always available.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { fieldFromHex, fieldToBytes } from "@toip-tools/anon-membership";
import { ADJECTIVES, NOUNS } from "./words";

export interface NymLook {
  name: string;
  /** Hue 0..359 and a pattern 0..15, for the nym's seal. */
  hue: number;
  hue2: number;
  pattern: number;
}

export function nymLook(nym: string): NymLook {
  const h = sha256(fieldToBytes(fieldFromHex(nym)));
  return {
    name: `${ADJECTIVES[h[0]]}-${NOUNS[h[1]]}-${h[2] % 100}`,
    hue: Math.round((h[3] / 256) * 360),
    hue2: Math.round((h[4] / 256) * 360),
    pattern: h[5] & 15,
  };
}

export const nymName = (nym: string) => nymLook(nym).name;
