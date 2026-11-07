// A newsroom learns "a current employee of Acme sent this" and nothing about which one.
import {
  GroupIssuer, MembershipProver, MembershipVerifier, NullifierBook, acceptMembership, dayOf, enroll,
  initHashing, memberSecret, membershipInputs, messageOf, scopeOf, treeFromRoot,
} from "@toip-tools/anon-membership";
import { Bus, Endpoint, SystemClock, identityFromSeed, seedFrom } from "@toip-tools/trust-core";

await initHashing();
const clock = new SystemClock();
const bus = new Bus(clock);
const acme = identityFromSeed(seedFrom("example/acme"));
const walletSeed = seedFrom("example/employee-wallet");
const employee = identityFromSeed(walletSeed);
const newsroom = identityFromSeed(seedFrom("example/newsroom"));

// The issuer keeps the group and signs one root per day. It never learns a member's secret.
const issuer = new GroupIssuer({ identity: acme, clock, name: "employees" });
issuer.serve(new Endpoint({ identity: acme, transport: bus, clock }), (did) => did === employee.did);

// The member enrolls a commitment to a secret derived from their wallet seed.
const secret = memberSecret(walletSeed, issuer.groupId);
await enroll(new Endpoint({ identity: employee, transport: bus, clock }), acme.did, issuer.groupId, secret);
const { root, snapshot } = issuer.publish();

// Proving: membership, a nullifier for this story, bound to this message.
const scope = scopeOf("tipline/v1", newsroom.did, "story-41");
const signal = messageOf("tipline/v1", { kind: "tip", body: "sha256:9f86d081" });
const tree = treeFromRoot(root, snapshot); // checks the snapshot against the signed root
const { statement, witness } = membershipInputs({ secret, groups: [{ group: issuer.groupId, tree }], scope, signal, today: dayOf(clock.now()) });
const proof = await (await MembershipProver.create()).prove(statement, witness);

// The newsroom accepts or refuses, and counts distinct sources by nullifier.
const verifier = await MembershipVerifier.create();
const r = await acceptMembership(proof, {
  policy: { groups: [{ group: issuer.groupId, issuer: acme.did }], vkHashes: verifier.vkHashes(), maxEpochAge: 3, minSize: 1 },
  logs: { [issuer.groupId]: issuer.log() },
  verifier, scope, signal, clock,
});
const book = new NullifierBook();
if (r.ok) console.log("accepted:", book.label(issuer.groupId, scope, r.nullifier));
