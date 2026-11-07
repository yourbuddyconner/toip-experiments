import { beforeAll, describe, expect, it } from "vitest";
import { Bus, DemoClock, Endpoint, Refusal, canonicalJson, identityFromSeed, seedFrom, signDocument } from "@zk-toip/trust-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { groupFieldOf, memberSecret } from "../src/encode";
import { fieldToHex } from "../src/field";
import { commitmentOf, initHashing, leafHash, plainLeaf } from "../src/hash";
import { ENROLL, GroupIssuer, enroll } from "../src/issuer";
import { checkRootLog, epochOf, rootDocHash, snapshotMatches, treeFromRoot, type GroupRoot } from "../src/roots";
import { GroupTree } from "../src/tree";

beforeAll(initHashing);

const acme = identityFromSeed(seedFrom("am/acme"));
const mallory = identityFromSeed(seedFrom("am/mallory"));
const DAY = 86_400_000;

function setup(start = "2026-11-06T00:00:05Z") {
  const clock = new DemoClock(start);
  const issuer = new GroupIssuer({ identity: acme, clock, name: "employees" });
  return { clock, issuer };
}

describe("epochs", () => {
  it("is the UTC day by default, and the period start otherwise", () => {
    expect(epochOf(Date.parse("2026-11-06T23:59:59Z"))).toBe("2026-11-06");
    expect(epochOf(Date.parse("2026-11-06T10:59:59Z"), 3600)).toBe("2026-11-06T10:00:00Z");
  });
});

describe("GroupIssuer", () => {
  it("names its group <DID>#<name> and publishes signed roots in a hash chain", async () => {
    const { clock, issuer } = setup();
    expect(issuer.groupId).toBe(`${acme.did}#employees`);
    const a = issuer.enroll("did:key:alice", 11n);
    const b = issuer.enroll("did:key:bob", 22n);
    expect([a.index, b.index]).toEqual([0, 1]);
    const r0 = issuer.publish();
    expect(r0.root).toMatchObject({ type: "anon-membership/root", v: 1, issuer: acme.did, group: issuer.groupId, epoch: "2026-11-06", seq: 0, prev: null, length: 2, size: 2 });
    expect(r0.root.groupId).toBe(fieldToHex(groupFieldOf(issuer.groupId)));
    expect(r0.root.root).toBe(fieldToHex(GroupTree.fromLeaves([leafHash(plainLeaf(11n)), leafHash(plainLeaf(22n))]).root()));
    expect(snapshotMatches(r0.root, r0.snapshot)).toBe(true);
    expect(() => issuer.publish()).toThrow(/already/);
    clock.advance(DAY);
    issuer.revoke("did:key:alice");
    const r1 = issuer.publish();
    expect(r1.root).toMatchObject({ seq: 1, epoch: "2026-11-07", prev: rootDocHash(r0.root), length: 2, size: 1 });
    expect(issuer.log()).toHaveLength(2);
    expect(issuer.snapshot("2026-11-06")).toEqual(r0.snapshot);
    const check = await checkRootLog(issuer.log(), acme.did, clock);
    expect(check).toMatchObject({ ok: true, head: { seq: 1 } });
  });

  it("re-enrolling zeroes the old leaf and appends a new one; indices are never reused", () => {
    const { issuer } = setup();
    issuer.enroll("did:key:alice", 11n);
    const again = issuer.enroll("did:key:alice", 33n);
    expect(again.index).toBe(1);
    expect(issuer.tree().leaf(0)).toBe(0n);
    expect(issuer.tree().size()).toBe(1);
    issuer.revoke("did:key:alice");
    expect(issuer.enroll("did:key:carol", 44n).index).toBe(2);
    expect(() => issuer.revoke("did:key:nobody")).toThrow();
  });

  it("records attribute leaves when given fields", () => {
    const { issuer } = setup();
    const fields = { schemaId: 5n, validUntilDay: 21000, registeredDay: 20763, attrs: [1n, 2n, 3n, 4n] as [bigint, bigint, bigint, bigint] };
    const { leaf } = issuer.enroll("did:key:alice", 11n, fields);
    expect(leaf).toEqual({ ...fields, commitment: 11n });
    expect(issuer.tree().leaf(0)).toBe(leafHash(leaf));
  });

  it("survives state() and back", () => {
    const { clock, issuer } = setup();
    issuer.enroll("did:key:alice", 11n);
    issuer.publish();
    const copy = new GroupIssuer({ identity: acme, clock, name: "employees", state: JSON.parse(JSON.stringify(issuer.state())) });
    expect(copy.tree().root()).toBe(issuer.tree().root());
    expect(copy.log()).toEqual(issuer.log());
    expect(copy.snapshot("2026-11-06")).toEqual(issuer.snapshot("2026-11-06"));
    expect(() => copy.publish()).toThrow(/already/);
    expect(copy.enroll("did:key:alice", 12n).index).toBe(1);
  });

  it("treeFromRoot rebuilds the tree and refuses a snapshot that doesn't match", () => {
    const { issuer } = setup();
    issuer.enroll("did:key:alice", 11n);
    const { root, snapshot } = issuer.publish();
    expect(treeFromRoot(root, snapshot).root()).toBe(issuer.tree().root());
    const bad = new Uint8Array(snapshot);
    bad[31] ^= 1;
    expect(snapshotMatches(root, bad)).toBe(false);
    expect(() => treeFromRoot(root, bad)).toThrow(/snapshot/);
  });
});

describe("checkRootLog", () => {
  async function chain(n: number) {
    const { clock, issuer } = setup();
    for (let i = 0; i < n; i++) {
      issuer.enroll(`did:key:m${i}`, BigInt(100 + i));
      issuer.publish();
      clock.advance(DAY);
    }
    return { clock, issuer, log: issuer.log() };
  }
  const resign = (doc: GroupRoot, clock: DemoClock, who = acme): GroupRoot => {
    const { proof: _p, ...rest } = doc;
    return signDocument(rest, who, clock);
  };

  it("refuses an empty log, a wrong issuer and a bad signature", async () => {
    const { clock, log } = await chain(2);
    expect(await checkRootLog([], acme.did, clock)).toMatchObject({ ok: false, reason: "chain" });
    expect(await checkRootLog(log, mallory.did, clock)).toMatchObject({ ok: false, reason: "issuer" });
    const tampered = [log[0], { ...log[1], size: 99 }];
    expect(await checkRootLog(tampered, acme.did, clock)).toMatchObject({ ok: false, reason: "signature" });
    // Mallory signs a document claiming to be Acme's.
    const forged = { ...log[1], proof: resign({ ...log[1], issuer: mallory.did }, clock, mallory).proof };
    expect((await checkRootLog([log[0], forged], acme.did, clock)).ok).toBe(false);
  });

  it("refuses a gap in seq, a broken prev, and epochs out of order", async () => {
    const { clock, log } = await chain(3);
    expect(await checkRootLog([log[0], log[2]], acme.did, clock)).toMatchObject({ ok: false, reason: "chain" });
    const badPrev = resign({ ...log[1], prev: "00".repeat(32) }, clock);
    expect(await checkRootLog([log[0], badPrev], acme.did, clock)).toMatchObject({ ok: false, reason: "chain" });
    const backwards = resign({ ...log[1], epoch: "2026-11-05" }, clock);
    expect(await checkRootLog([log[0], backwards], acme.did, clock)).toMatchObject({ ok: false, reason: "chain" });
    expect(await checkRootLog([log[1], log[0]], acme.did, clock)).toMatchObject({ ok: false, reason: "chain" });
  });

  it("returns two validly signed roots for one epoch as evidence of equivocation", async () => {
    const { clock, issuer, log } = await chain(2);
    // A second, tailored root for the second epoch, properly chained and signed.
    const tailored = resign({ ...log[1], root: fieldToHex(12345n), size: 60, id: "urn:uuid:tailored" }, clock);
    const r = await checkRootLog([log[0], log[1], tailored], acme.did, clock);
    expect(r).toMatchObject({ ok: false, reason: "equivocation" });
    expect(r.ok === false && r.evidence?.map((d) => d.id).sort()).toEqual([log[1].id, "urn:uuid:tailored"].sort());
    // Seen in two logs: each is fine alone, together they are evidence.
    const mirror = [log[0], tailored];
    expect((await checkRootLog(mirror, acme.did, clock)).ok).toBe(true);
    expect((await checkRootLog([...issuer.log(), ...mirror], acme.did, clock)).ok).toBe(false);
    // An exact duplicate is not equivocation.
    expect(await checkRootLog([log[0], log[1], log[1]], acme.did, clock)).toMatchObject({ ok: false, reason: "chain" });
  });

  it("rootDocHash is SHA-256 of the JCS of the signed document", async () => {
    const { log } = await chain(1);
    expect(rootDocHash(log[0])).toBe(bytesToHex(sha256(new TextEncoder().encode(canonicalJson(log[0])))));
  });
});

describe("the anon-membership/enroll Trust Task", () => {
  it("enrolls a member over TSP, and the issuer learns only the DID and the commitment", async () => {
    const clock = new DemoClock("2026-11-06T09:00:00Z");
    const bus = new Bus(clock);
    const issuerEp = new Endpoint({ identity: acme, transport: bus, clock });
    const alice = identityFromSeed(seedFrom("am/alice"));
    const aliceEp = new Endpoint({ identity: alice, transport: bus, clock });
    const issuer = new GroupIssuer({ identity: acme, clock, name: "employees" });
    const roster = new Set([alice.did]);
    issuer.serve(issuerEp, (did) => roster.has(did));
    expect(ENROLL.typeUri).toBe("https://zk-toip.example/spec/anon-membership/enroll/0.1");

    const seed = seedFrom("am/alice-wallet");
    const secret = memberSecret(seed, issuer.groupId);
    const res = await enroll(aliceEp, acme.did, issuer.groupId, secret);
    expect(res).toMatchObject({ group: issuer.groupId, index: 0, firstEpoch: "2026-11-06" });
    expect(res.leaf).toEqual(plainLeaf(commitmentOf(secret, groupFieldOf(issuer.groupId))));
    expect(issuer.member(alice.did)).toEqual({ index: 0, leaf: res.leaf });

    // The issuer's whole state holds the commitment, never the secret.
    const state = JSON.stringify(issuer.state());
    expect(state).not.toContain(fieldToHex(secret).slice(2));
    expect(state).toContain(alice.did);

    // Off the roster: refused.
    const eve = identityFromSeed(seedFrom("am/eve"));
    const eveEp = new Endpoint({ identity: eve, transport: bus, clock });
    await expect(enroll(eveEp, acme.did, issuer.groupId, 5n)).rejects.toThrow(/not admitted/);
    // Another group: refused.
    await expect(enroll(aliceEp, acme.did, `${acme.did}#other`, secret)).rejects.toThrow(/group/);
    // After today's root, a new member's first epoch is tomorrow.
    issuer.publish();
    roster.add(eve.did);
    expect((await enroll(eveEp, acme.did, issuer.groupId, 5n)).firstEpoch).toBe("2026-11-07");
  });

  it("lets admit() supply the leaf's attributes", async () => {
    const clock = new DemoClock("2026-11-06T09:00:00Z");
    const bus = new Bus(clock);
    const issuerEp = new Endpoint({ identity: acme, transport: bus, clock });
    const alice = identityFromSeed(seedFrom("am/alice"));
    const aliceEp = new Endpoint({ identity: alice, transport: bus, clock });
    const issuer = new GroupIssuer({ identity: acme, clock, name: "nurses" });
    const fields = { schemaId: 9n, validUntilDay: 21000, registeredDay: 20763, attrs: [7n, 0n, 0n, 0n] as [bigint, bigint, bigint, bigint] };
    issuer.serve(issuerEp, (_did, req) => (req.credential === "a license" ? fields : false));
    const res = await enroll(aliceEp, acme.did, issuer.groupId, 77n, { credential: "a license" });
    expect(res.leaf).toEqual({ ...fields, commitment: commitmentOf(77n, groupFieldOf(issuer.groupId)) });
    await expect(enroll(aliceEp, acme.did, issuer.groupId, 77n)).rejects.toThrow(/not admitted/);
  });

  it("lets admit() refuse with its own code, and carries a replace request", async () => {
    const clock = new DemoClock("2026-11-06T09:00:00Z");
    const bus = new Bus(clock);
    const issuerEp = new Endpoint({ identity: acme, transport: bus, clock });
    const alice = identityFromSeed(seedFrom("am/alice"));
    const aliceEp = new Endpoint({ identity: alice, transport: bus, clock });
    const issuer = new GroupIssuer({ identity: acme, clock, name: "rotating" });
    const seen: (boolean | undefined)[] = [];
    issuer.serve(issuerEp, (did, req) => {
      seen.push(req.replace);
      if (issuer.member(did) && !req.replace) return new Refusal("alreadyMember", "already a member; ask to replace your leaf instead");
      return true;
    });
    const first = await enroll(aliceEp, acme.did, issuer.groupId, 1n);
    await expect(enroll(aliceEp, acme.did, issuer.groupId, 2n)).rejects.toMatchObject({ code: "alreadyMember" });
    const second = await enroll(aliceEp, acme.did, issuer.groupId, 2n, { replace: true });
    expect(seen).toEqual([undefined, undefined, true]);
    expect(second.index).toBe(first.index + 1);
    expect(issuer.tree().leaf(first.index)).toBe(0n);
    expect(issuer.member(alice.did)?.leaf.commitment).toBe(commitmentOf(2n, groupFieldOf(issuer.groupId)));
  });
});
