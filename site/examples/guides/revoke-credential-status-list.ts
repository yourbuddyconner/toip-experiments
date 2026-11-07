// Revoke a verifiable credential with a signed status list: one bit per credential, published by the issuer.
import { StatusList, SystemClock, checkStatus, identityFromSeed, issueCredential, verifyCredential, type Credential } from "@toip-tools/trust-core";

const clock = new SystemClock();
const random = () => crypto.getRandomValues(new Uint8Array(32));
const gym = identityFromSeed(random());
const member = identityFromSeed(random());

// The issuer keeps one list for many credentials (1024 by default) and gives each credential a slot.
const list = new StatusList();
const slot = list.allocate();
const pass = issueCredential(gym, clock, {
  type: ["VerifiableCredential", "MembershipCredential"],
  credentialSubject: { id: member.did, plan: "monthly" },
  credentialStatus: { type: "BitstringStatusListEntry", statusListIndex: slot, statusListCredential: `${gym.did}#status` },
});

// The issuer signs the list and publishes it anywhere verifiers can fetch it: a web server, a relay, a file.
let published = list.sign(gym, clock);

// A verifier checks the credential, then the list: signed by the same issuer, and the credential's bit clear.
async function check(vc: Credential): Promise<string> {
  const proof = await verifyCredential(vc, clock);
  if (!proof.ok) return `invalid (${proof.failure})`;
  const status = await checkStatus(published, vc.credentialStatus!.statusListIndex, vc.issuer, clock);
  if (!status.signatureValid) return "status list not signed by the issuer";
  return status.revoked ? `revoked (list is ${status.ageSeconds}s old)` : `valid (list is ${status.ageSeconds}s old)`;
}

console.log(`Slot ${slot}:`, await check(pass));

// To revoke: set the bit, sign the list again, publish the new copy.
list.revoke(slot);
published = list.sign(gym, clock);
console.log(`Slot ${slot} after revocation:`, await check(pass));

// Someone in the middle swaps in an all-clear bitstring to un-revoke the pass. The issuer's signature catches it.
published = { ...published, bits: new StatusList().sign(gym, clock).bits };
console.log("With a tampered list:", await check(pass));
