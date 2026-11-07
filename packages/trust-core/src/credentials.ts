/**
 * W3C VC-shaped credentials with one issuer and one eddsa-jcs-2022 Data Integrity proof.
 * Signing and verifying reuse @openvtc/trust-tasks-proof: its signer and verifier bind the proof
 * to the document's `issuer`, which a VC has too.
 */
import type { Proof, TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import { newUrnUuid } from "@openvtc/trust-tasks-tsp";
import { DataIntegrityProofVerifier, signTrustTask } from "@openvtc/trust-tasks-proof";
import type { Clock } from "./clock.js";
import type { Identity } from "./identity.js";

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

/**
 * Signs a JSON object with an eddsa-jcs-2022 Data Integrity proof.
 * @param doc Document whose `issuer` must be the signing identity's DID.
 * @param issuer Identity that signs the document.
 * @param clock Supplies the proof's creation time.
 * @returns The signed document, including its proof.
 */
export function signDocument<T extends { issuer: string }>(doc: T, issuer: Identity, clock: Clock): T {
  return signTrustTask(doc as unknown as TrustTaskDocument<unknown>, issuer.signer, { created: clock.date() }) as unknown as T;
}

/**
 * Verifies a document's Data Integrity proof, allowing five minutes of clock skew.
 * This checks the proof; credential validity and revocation are separate checks.
 * @param doc Document signed by `signDocument` or a compatible signer.
 * @param clock Supplies the verifier's current time.
 * @returns The proof verifier's detailed result, including `valid` and a failure reason when invalid.
 */
export async function verifyDocument(doc: object, clock: Clock) {
  // Devices' clocks drift; tolerate a proof dated up to 5 minutes ahead (design v2 §4.5).
  const verifier = new DataIntegrityProofVerifier({ now: () => clock.now(), clockSkewMs: 5 * 60_000 });
  return verifier.verifyDetailed(doc as unknown as TrustTaskDocument<unknown>);
}

/**
 * Creates and signs a VC-shaped credential with a fresh UUID and the issuer's DID.
 * @param issuer Identity that issues and signs the credential.
 * @param clock Supplies `validFrom` and the proof creation time.
 * @param body Credential types, subject claims, optional expiry, and optional status-list reference.
 * @returns A credential with the W3C VC v2 context and a Data Integrity proof.
 */
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

/**
 * Checks a credential's proof and validity window. Revocation and application authorization are separate.
 * `validFrom` may be up to one minute ahead of the clock; `validUntil` is exclusive.
 * @param vc Credential to verify.
 * @param clock Supplies the current time for proof and credential checks.
 * @returns `{ ok: true }` on success, or a proof/validity failure code in `failure`.
 */
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
