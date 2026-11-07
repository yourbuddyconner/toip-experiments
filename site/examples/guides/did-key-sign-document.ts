// Create a did:key identity, sign a JSON document with it, and verify the signature from the DID alone.
import { SystemClock, identityFromSeed, resolveDidKey, signDocument, verifyDocument } from "@toip-tools/trust-core";

const clock = new SystemClock();

// A did:key identity is 32 random bytes. Keep the seed secret: whoever holds it can sign as you.
const seed = crypto.getRandomValues(new Uint8Array(32));
const me = identityFromSeed(seed);
console.log("DID:", me.did);

// The DID encodes the Ed25519 public key, so anyone can recover it without a registry or network call.
const { signingKey } = resolveDidKey(me.did);
console.log("Public key from the DID:", Buffer.from(signingKey).toString("hex"));

// signDocument adds a W3C Data Integrity proof (eddsa-jcs-2022). The document's issuer must be the signer's DID.
interface Receipt { issuer: string; kind: string; item: string; cents: number; proof?: { type: string; cryptosuite: string } }
const receipt = signDocument<Receipt>({ issuer: me.did, kind: "receipt", item: "bike tune-up", cents: 4500 }, me, clock);
console.log("Proof:", receipt.proof?.type, receipt.proof?.cryptosuite);

// Anyone can verify it: the proof names the key, and the key is in the DID.
const check = await verifyDocument(receipt, clock);
console.log("Valid:", check.valid);

// Change one field and the signature no longer matches.
const altered = await verifyDocument({ ...receipt, cents: 450 }, clock);
console.log("Valid after changing the price:", altered.valid, `(${altered.failure})`);
