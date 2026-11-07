// Prove "I am a member of this group" with a zero-knowledge proof (Noir, UltraHonk), without saying which
// member. A scoped nullifier lets the verifier count one voice per member, still without knowing who.
import {
  GroupIssuer, MembershipProver, MembershipVerifier, NullifierBook, acceptMembership, dayOf, enroll,
  initHashing, memberSecret, membershipInputs, messageOf, scopeOf, treeFromRoot,
} from "@toip-tools/anon-membership";
import { Bus, Endpoint, SystemClock, identityFromSeed } from "@toip-tools/trust-core";

await initHashing();
const clock = new SystemClock();
const bus = new Bus(clock);
const random = () => crypto.getRandomValues(new Uint8Array(32));

// The issuer (a union, say) keeps the group and decides who may enroll.
const union = identityFromSeed(random());
const roster = new Set<string>();
const issuer = new GroupIssuer({ identity: union, clock, name: "members" });
issuer.serve(new Endpoint({ identity: union, transport: bus, clock }), (did) => roster.has(did));

// Each member enrolls a commitment to a secret derived from their own seed. The issuer never sees the secret.
const members = [random(), random(), random()].map((seed) => ({ seed, id: identityFromSeed(seed) }));
for (const m of members) {
  roster.add(m.id.did);
  await enroll(new Endpoint({ identity: m.id, transport: bus, clock }), union.did, issuer.groupId, memberSecret(m.seed, issuer.groupId));
}
const { root, snapshot } = issuer.publish(); // a signed root for today

const prover = await MembershipProver.create();
const verifier = await MembershipVerifier.create();
const book = new NullifierBook(undefined, { prefix: "Member" }); // labels distinct members "Member A", "Member B", …
const scope = scopeOf("survey/v1", union.did, "strike-vote-2026"); // one voice per member in this scope

async function vote(seed: Uint8Array, choice: string) {
  const signal = messageOf("survey/v1", { choice }); // the proof is bound to this exact message
  const secret = memberSecret(seed, issuer.groupId);
  const tree = treeFromRoot(root, snapshot); // checks the snapshot against the signed root
  const { statement, witness } = membershipInputs({ secret, groups: [{ group: issuer.groupId, tree }], scope, signal, today: dayOf(clock.now()) });
  const proof = await prover.prove(statement, witness);
  const r = await acceptMembership(proof, {
    policy: { groups: [{ group: issuer.groupId, issuer: union.did }], vkHashes: verifier.vkHashes(), maxEpochAge: 3, minSize: 3 },
    logs: { [issuer.groupId]: issuer.log() },
    verifier, scope, signal, clock,
  });
  if (!r.ok) return console.log(`"${choice}": refused (${r.reason})`);
  const { label, first } = book.label(issuer.groupId, scope, r.nullifier);
  console.log(`"${choice}": a member voted (${label}${first ? "" : ", again: count it once"}); proof ${JSON.stringify(proof).length} bytes`);
}

await vote(members[1].seed, "yes");
await vote(members[2].seed, "no");
await vote(members[1].seed, "yes"); // same member, same scope: same nullifier

// Someone who never enrolled can't build a proof for the group.
try {
  await vote(random(), "yes");
} catch (e) {
  console.log("An outsider:", (e as Error).message);
}

await prover.destroy(); // the prover and verifier hold worker threads until destroyed
await verifier.destroy();
