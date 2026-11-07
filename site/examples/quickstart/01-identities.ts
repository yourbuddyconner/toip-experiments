// Step 1: two identities.
// Run from the repository root:
//   npx tsx --tsconfig site/tsconfig.json site/examples/quickstart/01-identities.ts
import { identityFromSeed, resolveDidKey, seedFrom } from "@toip-tools/trust-core";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// An identity is a 32-byte seed. In an app, use random bytes:
//   identityFromSeed(crypto.getRandomValues(new Uint8Array(32)))
// Here a label makes the seed, so every run gives the same two DIDs.
const alice = identityFromSeed(seedFrom("quickstart/alice"));
const bob = identityFromSeed(seedFrom("quickstart/bob"));

console.log("Alice:", alice.did);
console.log("Bob:  ", bob.did);

// A did:key is its public key, written out. Anyone holding Bob's DID can get his keys from it,
// with no registry and no network call.
const keys = resolveDidKey(bob.did);
console.log("\nFrom Bob's DID alone:");
console.log("  signing key (Ed25519)   ", hex(keys.signingKey));
console.log("  encryption key (X25519) ", hex(keys.encryptionKey));

// The secret halves never leave the device that made them.
console.log("\nBob's own copy matches:", hex(keys.signingKey) === hex(bob.signingPublic) && hex(keys.encryptionKey) === hex(bob.encryptionPublic));
