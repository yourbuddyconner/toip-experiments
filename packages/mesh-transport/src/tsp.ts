/**
 * Splitting a TSP message into what has to travel, and rebuilding it byte for byte (design §8.2).
 * The envelope and the CESR framing are deterministic, so only `enc`, `ct ‖ tag` and the signature
 * go on the air, plus a way for the receiver to know the two VIDs.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { cesr, decodeEnvelope, encodeEnvelope } from "@openvtc/vti-tsp-js";
import { concat, equal } from "./bytes.js";

export interface TspParts {
  senderVid: string;
  receiverVid: string;
  /** The HPKE ephemeral key, 32 bytes. */
  enc: Uint8Array;
  /** The HPKE ciphertext with its 16-byte AEAD tag. */
  ct: Uint8Array;
  /** The Ed25519 signature over envelope and ciphertext, 64 bytes. */
  signature: Uint8Array;
}

const SIG_QUADLETS = 22;

function signedPart(p: Omit<TspParts, "signature">): number[] {
  const out = Array.from(encodeEnvelope(p.senderVid, p.receiverVid));
  cesr.encodeVariableData(cesr.TSP_HPKEAUTH_CIPHERTEXT, concat(p.ct, p.enc), out);
  return out;
}

export function joinTsp(p: TspParts): Uint8Array {
  if (p.enc.length !== 32 || p.signature.length !== 64) throw new Error("tsp: bad part sizes");
  const out = signedPart(p);
  cesr.encodeCount(cesr.TSP_ATTACH_GRP, SIG_QUADLETS, out);
  cesr.encodeCount(cesr.TSP_INDEX_SIG_GRP, SIG_QUADLETS, out);
  cesr.encodeFixedData(cesr.ED25519_SIGNATURE, p.signature, out);
  return Uint8Array.from(out);
}

/**
 * The parts of a TSP message. Throws unless `joinTsp` rebuilds exactly these bytes.
 * Routed and Nested messages have the same outer form as Direct ones, so they split too.
 */
export function splitTsp(wire: Uint8Array): TspParts {
  const { envelope, headerLen } = decodeEnvelope(wire);
  const cur = { pos: headerLen };
  const range = cesr.decodeVariableDataRange(cesr.TSP_HPKEAUTH_CIPHERTEXT, wire, cur);
  if (!range || range.end - range.begin < 48) throw new Error("tsp: no ciphertext");
  if (cesr.decodeCount(cesr.TSP_ATTACH_GRP, wire, cur) !== SIG_QUADLETS) throw new Error("tsp: no signature group");
  if (cesr.decodeCount(cesr.TSP_INDEX_SIG_GRP, wire, cur) !== SIG_QUADLETS) throw new Error("tsp: no signature group");
  const signature = cesr.decodeFixedData(cesr.ED25519_SIGNATURE, 64, wire, cur);
  if (!signature || cur.pos !== wire.length) throw new Error("tsp: bad signature frame");
  const g = wire.slice(range.begin, range.end);
  const parts: TspParts = {
    senderVid: envelope.sender,
    receiverVid: envelope.receiver,
    enc: g.slice(g.length - 32),
    ct: g.slice(0, g.length - 32),
    signature: signature.slice(),
  };
  if (!equal(joinTsp(parts), wire)) throw new Error("tsp: not in canonical form");
  return parts;
}

/** Checks the TSP signature, so a mesh node can drop forgeries and tag collisions before delivery. */
export function tspSignatureValid(p: TspParts, signingKey: Uint8Array): boolean {
  try {
    return ed25519.verify(p.signature, Uint8Array.from(signedPart(p)), signingKey);
  } catch {
    return false;
  }
}
