// An agent keeps a witnessed audit trail under a KERI identifier; a reviewer verifies the bundle.
import { Controller, MemoryStore, Witness, coldKeysFromSeed, ed25519Signer, exportBundle, localWitnessClient, signerFromIdentity, verifyBundle } from "@toip-tools/eventlog";
import { SystemClock, identityFromSeed, seedFrom } from "@toip-tools/trust-core";

const clock = new SystemClock();
const agent = identityFromSeed(seedFrom("example/agent"));
const witnesses = [1, 2].map((n) => new Witness({ signer: ed25519Signer(seedFrom(`example/witness/${n}`)), store: new MemoryStore(), clock }));

const controller = await Controller.incept({
  hot: [signerFromIdentity(agent)], // signs today
  cold: coldKeysFromSeed(seedFrom("example/agent/rotation"), "agent"), // pre-rotation: tomorrow's keys, committed now
  witnesses: witnesses.map((w) => w.aid),
  bt: 1,
  bind: agent, // links the AID to the agent's did:key
  store: new MemoryStore(),
  clock,
});

const clients = witnesses.map(localWitnessClient);
const trail = await controller.openTrail("agent/actions");
await trail.append({ kind: "agent/tool-call", body: { tool: "search", query: "bike shops near me" } });
await trail.appendWitnessed({ kind: "agent/payment", body: { to: "did:key:z6Mk…", cents: 4500 } }, clients); // before paying: wait for a receipt
await controller.rotate(); // new keys; every open trail is sealed at its head
await controller.publish(clients); // witnesses receipt everything they haven't seen

const bundle = await exportBundle(controller.store, controller.aid);
const check = await verifyBundle(bundle, { expectDid: agent.did });
console.log(check.ok ? "bundle verifies" : check.problems);
