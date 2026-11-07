// Step 4: a credential, presented in a Trust Task, verified, then revoked.
// Run from the repository root:
//   npx tsx --tsconfig site/tsconfig.json site/examples/quickstart/04-credentials.ts
import {
  Bus,
  Endpoint,
  StatusList,
  SystemClock,
  checkStatus,
  identityFromSeed,
  issueCredential,
  seedFrom,
  verifyCredential,
  type Credential,
} from "@toip-tools/trust-core";

const short = (did: string) => `${did.slice(0, 14)}…${did.slice(-4)}`;
const clock = new SystemClock();

// A third party: a community garden that vouches for its members.
const garden = identityFromSeed(seedFrom("quickstart/garden"));
const aliceId = identityFromSeed(seedFrom("quickstart/alice"));
const bobId = identityFromSeed(seedFrom("quickstart/bob"));

// The garden keeps a status list: one bit per credential it has issued. A set bit means revoked.
const statusList = new StatusList();
const slot = statusList.allocate();

const membership = issueCredential(garden, clock, {
  type: ["VerifiableCredential", "MembershipCredential"],
  credentialSubject: { id: bobId.did, memberOf: "Riverside Community Garden", plot: "B-12" },
  validUntil: new Date(clock.now() + 365 * 24 * 3600_000).toISOString(),
  credentialStatus: { type: "BitstringStatusListEntry", statusListIndex: slot, statusListCredential: `${garden.did}#status` },
});
console.log(`The garden issued Bob a ${membership.type[1]}, signed with ${membership.proof?.cryptosuite}.`);

// The garden publishes its signed list wherever verifiers can fetch it. Here, a variable.
let published = statusList.sign(garden, clock);

// Alice lends tools to garden members. She checks the credential Bob presents.
const bus = new Bus(clock);
const alice = new Endpoint({ identity: aliceId, transport: bus, clock });
const bob = new Endpoint({ identity: bobId, transport: bus, clock });

const BORROW = {
  typeUri: "https://example.org/spec/quickstart/borrow/0.1",
  isBearer: false,
  isProofRequired: true,
  isRecipientRequired: true,
  isIssuedAtRequired: true,
};

alice.handle<{ tool: string; credential: Credential }, { lent: boolean; why: string }>(BORROW, async (doc, { sender }) => {
  const vc = doc.payload.credential;
  const check = await verifyCredential(vc, clock);
  if (!check.ok) return { lent: false, why: `credential ${check.failure}` };
  if (vc.issuer !== garden.did) return { lent: false, why: "not issued by the garden" };
  if (vc.credentialSubject.id !== sender) return { lent: false, why: "credential is about someone else" };
  const status = await checkStatus(published, vc.credentialStatus!.statusListIndex, garden.did, clock);
  if (!status.signatureValid) return { lent: false, why: "status list not signed by the garden" };
  if (status.revoked) return { lent: false, why: "membership revoked" };
  return { lent: true, why: `member of ${vc.credentialSubject.memberOf}` };
});

async function ask(tool: string, credential: Credential) {
  const r = await bob.request<{ tool: string; credential: Credential }, { lent: boolean; why: string }>(alice.vid, BORROW, { tool, credential });
  console.log(`  Bob asks for the ${tool}: ${r.payload.lent ? "lent" : "refused"} (${r.payload.why})`);
}

console.log(`\nBob (${short(bobId.did)}) asks Alice (${short(aliceId.did)}):`);
await ask("wheelbarrow", membership);

// Change one claim and the issuer's signature no longer matches.
await ask("shears", { ...membership, credentialSubject: { ...membership.credentialSubject, plot: "A-01" } });

// The garden revokes Bob's membership: set his bit, sign the list again, publish it.
statusList.revoke(slot);
published = statusList.sign(garden, clock);
console.log("\nThe garden revokes slot", slot, "and publishes a new list.");
await ask("wheelbarrow", membership);
