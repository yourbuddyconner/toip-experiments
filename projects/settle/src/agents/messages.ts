/** The payloads Settle parties send each other over TSP (design §7). */
import type { Credential } from "@toip-tools/trust-core";
import type { Address } from "@solana/kit";
import type { Acceptance, Evidence, Party as TermsParty, Ruling, Terms } from "../protocol/documents";
import type { OutcomeSignature } from "./base";

export interface OfferPayload {
  payment: string;
  purpose: string;
  units: string;
  payee: TermsParty;
  credentials: Credential[];
  /** The payee's own name for itself (shown to people, never trusted). */
  name?: string;
  /** Set when the invoice answers a checkout from a payment link. */
  link?: string;
  checkout?: string;
  /** The release conditions the payment link fixed; the payee accepts only terms that use them. */
  conditions?: { attester: string; disputeWindowDays: number };
}
export interface OpenedPayload {
  terms: Terms;
  acceptances: Acceptance[];
  escrow: Address;
  transaction: string;
}
export interface RulingPayload {
  ruling: Ruling;
  evidence: Evidence;
  signature: OutcomeSignature;
}
export interface SettledPayload {
  termsHash: string;
  escrow: Address;
  transaction: string;
  payeeUnits: string;
  evidenceHash: string;
}
export interface SubmitPayload {
  transaction: string;
  /** For an open: the terms and both acceptances, which the processor checks before paying for anything. */
  terms?: Terms;
  acceptances?: Acceptance[];
}
export type SubmitResult = { ok: boolean; signature?: string; error?: string };
export interface HoldPayload {
  escrow: Address;
  until: string;
  signature: string;
}
