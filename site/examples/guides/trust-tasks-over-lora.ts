// Send a signed, encrypted Trust Task over LoRa radio, with no internet and no relay. This runs on the
// simulated radio from @toip-tools/mesh-transport/sim; real radios use the same MeshTransport.
import { MeshTransport, plans, regions } from "@toip-tools/mesh-transport";
import { SimMedium, VirtualScheduler } from "@toip-tools/mesh-transport/sim";
import { Endpoint, ctt1, identityFromSeed } from "@toip-tools/trust-core";

const random = () => crypto.getRandomValues(new Uint8Array(32));
const sensor = identityFromSeed(random());
const base = identityFromSeed(random());

// A simulated LoRa channel: US915, 250-byte frames, and the US airtime budget.
const scheduler = new VirtualScheduler();
const medium = new SimMedium({ scheduler, seed: 1 });
const radio = { setting: plans["us915-a"].tx, mtu: 250, budget: regions.us915 };
const sensorMesh = new MeshTransport({ identities: [sensor], links: [medium.node("sensor", radio)], scheduler, random: () => 0.5 });
const baseMesh = new MeshTransport({ identities: [base], links: [medium.node("base", radio)], scheduler, random: () => 0.5 });
medium.connect("sensor", "base"); // in range of each other

// The Endpoint is the same one you'd use over a relay. CTT1 is a compact CBOR body that decodes to the
// identical signed document, so the Data Integrity proof still verifies.
const compact = (mesh: MeshTransport) => (to: string) => (mesh.supportsCompact(to) ? ctt1 : undefined);
const sensorEndpoint = new Endpoint({ identity: sensor, transport: sensorMesh, clock: scheduler, bodyCodecFor: compact(sensorMesh) });
const baseEndpoint = new Endpoint({ identity: base, transport: baseMesh, clock: scheduler, bodyCodecFor: compact(baseMesh) });

const READING = {
  typeUri: "https://example.org/spec/field/reading/0.1",
  isBearer: false,
  isProofRequired: true,
  isRecipientRequired: true,
  isIssuedAtRequired: true,
};
baseEndpoint.handle<{ soilMoisture: number }, { stored: boolean }>(READING, (doc, { sender }) => {
  console.log(`Base station got ${doc.payload.soilMoisture}% from ${sender === sensor.did ? "the sensor" : sender}`);
  return { stored: true };
});

try {
  await sensorMesh.start();
  await baseMesh.start();
  sensorMesh.addContact(base.did); // a did:key resolves locally: no lookup over the air
  baseMesh.addContact(sensor.did);

  // run() advances the simulated radio's clock while the request waits for its signed reply.
  const reply = await scheduler.run(
    sensorEndpoint.request<{ soilMoisture: number }, { stored: boolean }>(base.did, READING, { soilMoisture: 31 }, { timeoutMs: 60_000 }),
  );
  console.log("Reply:", reply.payload, "signed by the base:", reply.issuer === base.did);

  const frames = medium.records();
  console.log(`${frames.length} radio frames in both directions, ${frames.reduce((n, f) => n + f.bytes.length, 0)} bytes on the air, largest ${Math.max(...frames.map((f) => f.bytes.length))} bytes`);
} finally {
  sensorEndpoint.close();
  baseEndpoint.close();
  await sensorMesh.stop();
  await baseMesh.stop();
}
