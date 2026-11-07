/**
 * Checks a WebAuthn-wrapped signature (alg -65600), as Capture's design §8.4 describes.
 *
 * The COSE signature field holds CBOR `[authenticatorData, clientDataJSON, signature]`. The passkey signed
 * `authenticatorData || SHA-256(clientDataJSON)`, and `clientDataJSON.challenge` must be SHA-256 of the
 * COSE Sig_structure. The caller then checks `signature` (DER ECDSA P-256) over `signed`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeCbor, equal } from "./cbor.js";

export interface WebAuthnInfo {
  origin: string;
  /** User present, user verified, backup eligible, backup state (a synced passkey has BS set). */
  flags: { up: boolean; uv: boolean; be: boolean; bs: boolean };
}

type Failure = "malformed" | "webauthnChallenge" | "webauthnOrigin" | "webauthnFlags";
export type WebAuthnCheck = { ok: true; info: WebAuthnInfo; signature: Uint8Array; signed: Uint8Array } | { ok: false; failure: Failure };

const utf8 = new TextEncoder();
const b64u = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function checkWebAuthn(wrapper: Uint8Array, toBeSigned: Uint8Array, origins: string[]): WebAuthnCheck {
  let authData: Uint8Array, clientDataJSON: Uint8Array, signature: Uint8Array, client: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    const v = decodeCbor<unknown[]>(wrapper, { strict: false });
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => x instanceof Uint8Array)) return { ok: false, failure: "malformed" };
    [authData, clientDataJSON, signature] = v as Uint8Array[];
    if (authData.length < 37) return { ok: false, failure: "malformed" };
    client = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clientDataJSON));
    if (!client || typeof client !== "object") return { ok: false, failure: "malformed" };
  } catch {
    return { ok: false, failure: "malformed" };
  }

  // 1, 2: an assertion over this message.
  if (client.type !== "webauthn.get" || client.challenge !== b64u(sha256(toBeSigned))) return { ok: false, failure: "webauthnChallenge" };
  // 3: from an origin the owner listed.
  const origin = client.origin;
  if (typeof origin !== "string" || !origins.includes(origin)) return { ok: false, failure: "webauthnOrigin" };
  // 4: for that origin's host.
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return { ok: false, failure: "webauthnOrigin" };
  }
  if (!equal(authData.subarray(0, 32), sha256(utf8.encode(host)))) return { ok: false, failure: "webauthnOrigin" };
  // 5: user present and verified.
  const f = authData[32];
  const flags = { up: !!(f & 0x01), uv: !!(f & 0x04), be: !!(f & 0x08), bs: !!(f & 0x10) };
  if (!flags.up || !flags.uv) return { ok: false, failure: "webauthnFlags" };

  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(sha256(clientDataJSON), authData.length);
  return { ok: true, info: { origin, flags }, signature, signed };
}
