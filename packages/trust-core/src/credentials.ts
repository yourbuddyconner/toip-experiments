/**
 * W3C VC-shaped credentials with one issuer and one eddsa-jcs-2022 Data Integrity proof.
 * Signing and verifying reuse @openvtc/trust-tasks-proof: its signer and verifier bind the proof
 * to the document's `issuer`, which a VC has too.
 */
import type { Proof, TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import { newUrnUuid } from "@openvtc/trust-tasks-tsp";
import { DataIntegrityProofVerifier, signTrustTask } from "@openvtc/trust-tasks-proof";
import type { Clock } from "./clock";
import type { Identity } from "./identity";

export interface Credential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil?: string;
  credentialSubject: { id: string; [k: string]: unknown };
  credentialStatus?: { type: "BitstringStatusListEntry"; statusListIndex: number; statusListCredential: string };
  proof?: Proof;
}

export type CredentialCheck =
  | { ok: true }
  | { ok: false; failure: "signatureInvalid" | "issuerMismatch" | "malformedProof" | "notYetValid" | "expired" };

export interface CredentialBody {
  type: string[];
  credentialSubject: Credential["credentialSubject"];
  validUntil?: string;
  credentialStatus?: Credential["credentialStatus"];
}

/** Signs any JSON object whose `issuer` is the signer's DID. */
export function signDocument<T extends { issuer: string }>(doc: T, issuer: Identity, clock: Clock): T {
  return signTrustTask(doc as unknown as TrustTaskDocument<unknown>, issuer.signer, { created: clock.date() }) as unknown as T;
}

/** Verifies the proof of any JSON object signed by `signDocument`. */
export async function verifyDocument(doc: object, clock: Clock) {
  // Devices' clocks drift; tolerate a proof dated up to 5 minutes ahead (design v2 §4.5).
  const verifier = new DataIntegrityProofVerifier({ now: () => clock.now(), clockSkewMs: 5 * 60_000 });
  return verifier.verifyDetailed(doc as unknown as TrustTaskDocument<unknown>);
}

export function issueCredential(issuer: Identity, clock: Clock, body: CredentialBody): Credential {
  const vc: Credential = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: newUrnUuid(),
    type: body.type,
    issuer: issuer.did,
    validFrom: clock.iso(),
    ...(body.validUntil ? { validUntil: body.validUntil } : {}),
    credentialSubject: body.credentialSubject,
    ...(body.credentialStatus ? { credentialStatus: body.credentialStatus } : {}),
  };
  return signDocument(vc, issuer, clock);
}

export async function verifyCredential(vc: Credential, clock: Clock): Promise<CredentialCheck> {
  const r = await verifyDocument(vc, clock);
  if (!r.valid) {
    const failure = r.failure === "issuerMismatch" ? "issuerMismatch" : r.failure === "signatureInvalid" ? "signatureInvalid" : "malformedProof";
    return { ok: false, failure };
  }
  if (Date.parse(vc.validFrom) > clock.now() + 60_000) return { ok: false, failure: "notYetValid" };
  if (vc.validUntil && Date.parse(vc.validUntil) <= clock.now()) return { ok: false, failure: "expired" };
  return { ok: true };
}
