// A sensor signs a reading as COSE_Sign1 over deterministic CBOR; anyone with its key verifies it.
import { decodeCbor, encodeCbor, seedSigner, verifyCose1, signCose1 } from "@toip-tools/cose";

const seed = crypto.getRandomValues(new Uint8Array(32));
const sensor = seedSigner(seed, new TextEncoder().encode("sensor-7#0")); // alg -19, Ed25519

const reading = encodeCbor({ v: 1, kind: "temp", milliC: 21_375, at: 1_762_416_000 });
const signed = await signCose1(reading, sensor, { contentType: "application/cbor" });

const result = await verifyCose1(signed, async () => [sensor.publicKey], { allowedAlgs: [-19] });
if (result.ok) console.log("verified", decodeCbor(result.value.payload), `${signed.length} bytes`);
else console.log("refused:", result.failure);
