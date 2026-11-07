// A signed, encrypted Trust Task crosses a simulated radio link, with no relay.
import { MeshTransport, plans, regions } from "@toip-tools/mesh-transport";
import { SimMedium, VirtualScheduler } from "@toip-tools/mesh-transport/sim";
import { Endpoint, ctt1, identityFromSeed, ourSpec, seedFrom } from "@toip-tools/trust-core";

// Demo seeds make identities repeatable. Real devices need securely generated seeds.
const guest = identityFromSeed(seedFrom("mesh-example/guest"));
const door = identityFromSeed(seedFrom("mesh-example/door"));
const scheduler = new VirtualScheduler();
const medium = new SimMedium({ scheduler, seed: 1 });
const radio = { setting: plans["us915-a"].tx, mtu: 250, budget: regions.us915 };
// Fixed radio jitter makes the simulation's scheduling repeatable.
const guestMesh = new MeshTransport({
  identities: [guest], links: [medium.node("guest", radio)], scheduler, random: () => 0.5,
});
const doorMesh = new MeshTransport({
  identities: [door], links: [medium.node("door", radio)], scheduler, random: () => 0.5,
});
medium.connect("guest", "door"); // Both radios are in range; the default is no loss.

// Endpoint still signs and seals the request. CTT1 compacts its signed body;
// MeshTransport fragments the sealed envelope and reassembles it at the door.
const guestEndpoint = new Endpoint({
  identity: guest, transport: guestMesh, clock: scheduler,
  bodyCodecFor: (to) => guestMesh.supportsCompact(to) ? ctt1 : undefined,
});
const doorEndpoint = new Endpoint({
  identity: door, transport: doorMesh, clock: scheduler,
  bodyCodecFor: (to) => doorMesh.supportsCompact(to) ? ctt1 : undefined,
});

const CHECK = ourSpec("example/door/check");
doorEndpoint.handle<{ challenge: string }, { accepted: boolean }>(CHECK, (doc) => ({
  accepted: doc.payload.challenge === "9f3a",
}));

try {
  await guestMesh.start();
  await doorMesh.start();
  // Resolve the peer's did:key locally. The first packet introduces the sender.
  guestMesh.addContact(door.did);
  doorMesh.addContact(guest.did);

  // run() advances virtual radio timers while the request waits for its reply.
  // Real radio adapters use real time; they do not need VirtualScheduler.run().
  const reply = await scheduler.run(guestEndpoint.request<{ challenge: string }, { accepted: boolean }>(
    door.did, CHECK, { challenge: "9f3a" }, { timeoutMs: 60_000 },
  ));
  console.log("Challenge accepted:", reply.payload.accepted);
  console.log("Reply signed by the door:", reply.issuer === door.did);
  console.log("Every radio frame fits the MTU:", medium.records().every((frame) => frame.bytes.length <= radio.mtu));
} finally {
  guestEndpoint.close();
  doorEndpoint.close();
  await guestMesh.stop();
  await doorMesh.stop();
}
