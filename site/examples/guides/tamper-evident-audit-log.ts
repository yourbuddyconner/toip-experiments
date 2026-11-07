// Keep a tamper-evident audit log under a KERI identifier: signed entries, witness receipts, key rotation
// with pre-rotation, and an offline bundle anyone can verify. Editing an entry afterwards is detected.
import { Controller, MemoryStore, Witness, coldKeysFromSeed, ed25519Signer, exportBundle, localWitnessClient, signerFromIdentity, verifyBundle } from "@toip-tools/eventlog";
import { SystemClock, identityFromSeed } from "@toip-tools/trust-core";

const clock = new SystemClock();
const random = () => crypto.getRandomValues(new Uint8Array(32));
const service = identityFromSeed(random());

// Two independent witnesses. Each receipts the first version of every event it sees.
const witnesses = [1, 2].map(() => new Witness({ signer: ed25519Signer(random()), store: new MemoryStore(), clock }));
const clients = witnesses.map(localWitnessClient);

// Incept a KERI identifier (AID). The cold keys are tomorrow's keys: only their digest is published now.
const controller = await Controller.incept({
  hot: [signerFromIdentity(service)],
  cold: coldKeysFromSeed(random(), "service"),
  witnesses: witnesses.map((w) => w.aid),
  bt: 1, // events need a receipt from at least one witness
  bind: service, // links the AID to the service's did:key
  store: new MemoryStore(),
  clock,
});
console.log("AID:", controller.aid);

// A trail is an append-only log owned by the AID. Each entry is a signed header committing to a private body.
const trail = await controller.openTrail("admin/actions");
await trail.append({ kind: "user/role-changed", body: { user: "dana", from: "viewer", to: "admin", by: "ops-bot" } });
await trail.append({ kind: "export/started", body: { table: "customers", rows: 1204 } });
// For entries that matter, wait for a witness receipt before acting.
await trail.appendWitnessed({ kind: "key/deleted", body: { key: "backup-2025" } }, clients);
await controller.rotate(); // switch to the pre-committed keys; the old key can no longer extend the trail
await controller.publish(clients); // witnesses receipt everything they haven't seen

// Export everything needed to check the log offline, including the entry bodies, and verify it.
const bundle = await exportBundle(controller.store, controller.aid, { bodies: "all" });
const check = await verifyBundle(bundle, { expectDid: service.did });
console.log("Bundle verifies:", check.ok);
for (const e of check.trails[0].entries) console.log(`  #${e.s} ${e.t} ${e.kind || "(trail opened)"}: ${e.status}`);

// Quietly rewrite history: change who granted admin. The body no longer matches the digest its entry signed.
const edited = structuredClone(bundle);
const body = edited.trails[0].bodies!.find((b) => b.user === "dana")!;
body.by = "nobody";
const after = await verifyBundle(edited, { expectDid: service.did });
console.log("After editing an entry:", after.ok, after.problems.map((p) => `${p.code}: ${p.message}`));
