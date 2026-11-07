/** Shared types. */

export type Qb64 = string;

export type ProblemCode =
  | "badVersion"
  | "badFields"
  | "unsupported"
  | "saidMismatch"
  | "badSequence"
  | "badChain"
  | "abandoned"
  | "signatureInvalid"
  | "thresholdNotMet"
  | "nextKeyMismatch"
  | "notWitnessed"
  | "duplicity"
  | "unknownKeyState"
  | "staleKeyState"
  | "unsealedRotation"
  | "sealMismatch"
  | "timeReversed"
  | "afterClose"
  | "bodyMismatch"
  | "bindingInvalid"
  | "truncated";

export interface Problem {
  code: ProblemCode;
  logId?: Qb64;
  s?: number;
  message: string;
}

export type MessageType = "icp" | "rot" | "ixn" | "rct" | "tin" | "ten" | "tcl" | "trc";
export const KEL_TYPES: readonly MessageType[] = ["icp", "rot", "ixn"];
export const TRAIL_TYPES: readonly MessageType[] = ["tin", "ten", "tcl"];

/** Indexed signature codes: A/B/2A/2B for Ed25519, E/F/2E/2F for ECDSA P-256. B and F (and 2B, 2F) count only toward current keys. */
export type IndexedSigCode = "A" | "B" | "2A" | "2B" | "E" | "F" | "2E" | "2F";

/** A WebAuthn assertion that wraps a P-256 signature. Not KERI: carried in our `-Y` attachment group. */
export interface WebAuthnWrap {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
}

export interface IndexedSig {
  code: IndexedSigCode;
  index: number;
  /** Index in the prior next-key digests. Equal to `index` for A and E; absent for current-only codes. */
  ondex?: number;
  sig: Uint8Array;
  wrap?: WebAuthnWrap;
}

export interface KeyRef {
  aid: Qb64;
  estSn: number;
  estSaid: Qb64;
}

/** A `-F` group: the key state that signed, and its indexed signatures. */
export interface KeyRefSig extends KeyRef {
  sigs: IndexedSig[];
}

export interface Couple {
  signer: Qb64;
  sig: Uint8Array;
}

export type Seal = { d: Qb64 } | { i: Qb64; s: string; d: Qb64 };

export interface SignedMessage {
  t: MessageType;
  /** Exact bytes signed and hashed. */
  raw: string;
  body: Record<string, unknown>;
  logId: Qb64;
  s: number;
  d: Qb64;
  controllerSigs?: IndexedSig[];
  witnessSigs?: IndexedSig[];
  keyRefSig?: KeyRefSig;
  couples?: Couple[];
}

/** A body: JSON with its SAID `d` and a random salt `u`. */
export interface Body {
  d: Qb64;
  u: Qb64;
  [k: string]: unknown;
}

export interface DuplicityEvidence {
  kind: "controller" | "witness";
  logId: Qb64;
  s: number;
  a: SignedMessage;
  b: SignedMessage;
  witness?: Qb64;
  detectedBy: string;
  detectedAt: string;
}

export const problem = (code: ProblemCode, message: string, logId?: Qb64, s?: number): Problem => ({
  code,
  message,
  ...(logId !== undefined ? { logId } : {}),
  ...(s !== undefined ? { s } : {}),
});
