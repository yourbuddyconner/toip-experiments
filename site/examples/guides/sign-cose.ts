// Sign and verify COSE_Sign1 messages (RFC 9052) over deterministic CBOR, with an Ed25519 seed and with a
// non-extractable P-256 WebCrypto key. Runs in Node and in browsers.
import { ALG, decodeCbor, encodeCbor, seedSigner, signCose1, verifyCose1, webCryptoSigner, type KeyLookup, type PublicKey } from "@toip-tools/cose";

const kid = (s: string) => new TextEncoder().encode(s);

// Two signers: an Ed25519 key from a 32-byte seed, and a P-256 key that WebCrypto never lets you export.
const sensor = seedSigner(crypto.getRandomValues(new Uint8Array(32)), kid("sensor-7"));
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const gateway = await webCryptoSigner(pair, kid("gateway-1"));
console.log("Algorithms:", sensor.alg, "(Ed25519),", gateway.alg, "(ESP256)");

// The payload is CBOR: compact and deterministic, so the same reading always encodes to the same bytes.
const reading = encodeCbor({ v: 1, kind: "temp", milliC: 21_375, at: 1_762_416_000 });
const fromSensor = await signCose1(reading, sensor, { contentType: "application/cbor" });
const fromGateway = await signCose1(reading, gateway, { contentType: "application/cbor" });
console.log("Message sizes:", fromSensor.length, "and", fromGateway.length, "bytes");

// The verifier decides which keys it trusts. The kid in the message is only a hint for finding one.
const trusted = new Map<string, PublicKey>([["sensor-7", sensor.publicKey], ["gateway-1", gateway.publicKey]]);
const lookup: KeyLookup = async (id) => {
  const key = id && trusted.get(new TextDecoder().decode(id));
  return key ? [key] : [];
};
const allowedAlgs = [ALG.Ed25519, ALG.ESP256, ALG.ES256];

for (const [who, msg] of [["sensor", fromSensor], ["gateway", fromGateway]] as const) {
  const r = await verifyCose1(msg, lookup, { allowedAlgs });
  console.log(`From the ${who}:`, r.ok ? decodeCbor(r.value.payload) : r.failure);
}

// One flipped bit in the payload, and verification fails. Use the payload only when ok is true.
const tampered = fromSensor.slice();
tampered[tampered.length - 70] ^= 0x01;
const r = await verifyCose1(tampered, lookup, { allowedAlgs });
console.log("Tampered:", r.ok ? "verified" : r.failure);

// A message signed by a key you don't trust fails too, whatever kid it claims.
const stranger = seedSigner(crypto.getRandomValues(new Uint8Array(32)), kid("sensor-7"));
const spoofed = await verifyCose1(await signCose1(reading, stranger), lookup, { allowedAlgs });
console.log("Signed by an unknown key claiming sensor-7:", spoofed.ok ? "verified" : spoofed.failure);
