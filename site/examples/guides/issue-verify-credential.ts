// Issue a W3C verifiable credential (VC Data Model 2.0 shape) and verify it: proof, issuer, subject and validity.
import { SystemClock, identityFromSeed, issueCredential, verifyCredential, type Credential } from "@toip-tools/trust-core";

const clock = new SystemClock();
const random = () => crypto.getRandomValues(new Uint8Array(32));
const university = identityFromSeed(random());
const graduate = identityFromSeed(random());

// The issuer signs a claim about a subject. issueCredential sets @context, id, issuer and validFrom.
const diploma = issueCredential(university, clock, {
  type: ["VerifiableCredential", "DegreeCredential"],
  credentialSubject: { id: graduate.did, degree: "BSc Computer Science", year: 2026 },
  validUntil: new Date(clock.now() + 5 * 365 * 86_400_000).toISOString(),
});
console.log(JSON.stringify({ ...diploma, proof: { ...diploma.proof, proofValue: "…" } }, null, 2));

// A verifier checks the proof and validity window, then decides whether it trusts this issuer for this claim.
const trustedIssuers = new Set([university.did]);
async function accept(vc: Credential, holder: string): Promise<string> {
  const check = await verifyCredential(vc, clock);
  if (!check.ok) return `rejected: ${check.failure}`;
  if (!trustedIssuers.has(vc.issuer)) return "rejected: unknown issuer";
  if (vc.credentialSubject.id !== holder) return "rejected: credential is about someone else";
  return `accepted: ${vc.credentialSubject.degree}`;
}

console.log("\nThe graduate presents it:", await accept(diploma, graduate.did));
console.log("Someone else presents it:", await accept(diploma, identityFromSeed(random()).did));
const inflated = { ...diploma, credentialSubject: { ...diploma.credentialSubject, degree: "PhD Computer Science" } };
console.log("With the degree changed:", await accept(inflated, graduate.did));
const selfIssued = issueCredential(graduate, clock, { type: ["VerifiableCredential", "DegreeCredential"], credentialSubject: { id: graduate.did, degree: "PhD" } });
console.log("Signed by the graduate:", await accept(selfIssued, graduate.did));
