/**
 * The signed documents of a Settle payment (design §6–§7). Everything here travels over TSP
 * between the parties; only hashes and fresh payment keys ever reach the chain.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  canonicalJson,
  fromB64u,
  issueCredential,
  signDocument,
  toB64u,
  utf8,
  verifyCredential,
  verifyDocument,
  type Clock,
  type Credential,
  type Identity,
} from "@zk-toip/trust-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Address } from "@solana/kit";
import { addressBytes } from "../chain/escrow";
import { paymentKeyFromSeed, type PaymentKey } from "../chain/keys";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const hashOf = (doc: unknown): Uint8Array => sha256(utf8(canonicalJson(doc)));
export const hexHash = (doc: unknown): string => hex(hashOf(doc));

/** A fresh Ed25519 key for one payment, derived from the party's identity so the device can recreate it (design §4). */
export function derivePaymentKey(identity: Identity, paymentId: string): Promise<PaymentKey> {
  return paymentKeyFromSeed(sha256(new Uint8Array([...identity.signingSecret, ...utf8(`settle/payment-key/v1|${paymentId}`)])));
}

// ---------------------------------------------------------------- payment-key bindings

/** "Key K acts for DID D in payment P", signed by D and countersigned by K. Shared only with the parties. */
export interface PaymentKeyBinding {
  type: "settle/payment-key-binding";
  issuer: string;
  payment: string;
  key: Address;
  keySignature: string;
  proof?: unknown;
}

export function bindPaymentKey(identity: Identity, key: PaymentKey, paymentId: string, clock: Clock): PaymentKeyBinding {
  const body = { type: "settle/payment-key-binding" as const, issuer: identity.did, payment: paymentId, key: key.address };
  const keySignature = toB64u(key.sign(utf8(canonicalJson(body))));
  return signDocument({ ...body, keySignature }, identity, clock);
}

export async function verifyBinding(b: PaymentKeyBinding, expect: { did: string; payment: string; key: Address }, clock: Clock): Promise<boolean> {
  if (!b || b.type !== "settle/payment-key-binding" || b.issuer !== expect.did || b.payment !== expect.payment || b.key !== expect.key) return false;
  if (!(await verifyDocument(b, clock)).valid) return false;
  const body = { type: b.type, issuer: b.issuer, payment: b.payment, key: b.key };
  try {
    return ed25519.verify(fromB64u(b.keySignature), utf8(canonicalJson(body)), addressBytes(b.key));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- terms

export interface Party {
  did: string;
  paymentKey: Address;
  tokenAccount: Address;
  binding: PaymentKeyBinding;
}

export interface Terms {
  type: "settle/terms";
  version: 1;
  payment: string;
  purpose: string;
  payer: Party;
  payee: Party & { credentials: Credential[] };
  arbiter: { did: string; key: Address };
  amount: { mint: Address; units: string; display: string };
  conditions: { policy: "settle/policies/attested-completion/1"; attester: string; disputeWindowSeconds: number };
  fee: { bps: number; account: Address; to: string };
  threshold: number;
  refundAfter: number;
}

/** A party's signature on the terms, as its own small document bound to the terms hash. */
export interface Acceptance {
  type: "settle/acceptance";
  issuer: string;
  termsHash: string;
  proof?: unknown;
}

export const termsHash = (t: Terms): Uint8Array => hashOf(t);

export function accept(terms: Terms, identity: Identity, clock: Clock): Acceptance {
  return signDocument({ type: "settle/acceptance", issuer: identity.did, termsHash: hex(termsHash(terms)) }, identity, clock);
}

export async function verifyAcceptance(a: Acceptance, terms: Terms, did: string, clock: Clock): Promise<boolean> {
  return !!a && a.type === "settle/acceptance" && a.issuer === did && a.termsHash === hex(termsHash(terms)) && (await verifyDocument(a, clock)).valid;
}

// ---------------------------------------------------------------- attestations, disputes, rulings

export interface Attestation {
  type: "settle/attestation";
  issuer: string;
  termsHash: string;
  claim: "complete" | "not-complete";
  note?: string;
  at: string;
  proof?: unknown;
}

export function attest(identity: Identity, terms: Terms, claim: Attestation["claim"], clock: Clock, note?: string): Attestation {
  return signDocument({ type: "settle/attestation", issuer: identity.did, termsHash: hex(termsHash(terms)), claim, at: clock.iso(), ...(note ? { note } : {}) }, identity, clock);
}

export interface Dispute {
  type: "settle/dispute";
  issuer: string;
  termsHash: string;
  reason: string;
  at: string;
  proof?: unknown;
}

export function dispute(identity: Identity, terms: Terms, reason: string, clock: Clock): Dispute {
  return signDocument({ type: "settle/dispute", issuer: identity.did, termsHash: hex(termsHash(terms)), reason, at: clock.iso() }, identity, clock);
}

export interface Ruling {
  type: "settle/ruling";
  issuer: string;
  termsHash: string;
  payeeUnits: string;
  reasons: string;
  considered: string[];
  at: string;
  proof?: unknown;
}

export function rule(identity: Identity, terms: Terms, payeeUnits: bigint, reasons: string, considered: unknown[], clock: Clock): Ruling {
  return signDocument(
    { type: "settle/ruling", issuer: identity.did, termsHash: hex(termsHash(terms)), payeeUnits: payeeUnits.toString(), reasons, considered: considered.map(hexHash), at: clock.iso() },
    identity,
    clock,
  );
}

/** Verifies a signed Settle document (attestation, dispute, ruling) against its issuer and terms. */
export async function verifySigned<T extends { issuer: string; termsHash: string }>(doc: T, terms: Terms, issuer: string, clock: Clock): Promise<boolean> {
  return !!doc && doc.issuer === issuer && doc.termsHash === hex(termsHash(terms)) && (await verifyDocument(doc, clock)).valid;
}

// ---------------------------------------------------------------- evidence and receipts

/** What an outcome rests on. Its hash goes into the message every signer signs and into the chain's record. */
export interface Evidence {
  type: "settle/evidence";
  termsHash: string;
  payeeUnits: string;
  attestations: Attestation[];
  disputes: Dispute[];
  ruling?: Ruling;
}

export const evidenceHash = (e: Evidence): Uint8Array => hashOf(e);

export function receipt(identity: Identity, terms: Terms, escrow: Address, transaction: string, paidUnits: bigint, clock: Clock): Credential {
  return issueCredential(identity, clock, {
    type: ["VerifiableCredential", "SettlePaymentReceipt"],
    credentialSubject: { id: terms.payer.did, termsHash: hex(termsHash(terms)), escrow, transaction, paidUnits: paidUnits.toString(), purpose: terms.purpose },
  });
}

export { verifyCredential };
