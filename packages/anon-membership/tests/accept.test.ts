import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DemoClock, identityFromSeed, seedFrom, signDocument } from "@toip-tools/trust-core";
import { loadArtifacts } from "../src/artifacts";
import { acceptMembership, type AcceptPolicy } from "../src/accept";
import { dayOf, groupFieldOf, memberSecret, scopeOf, messageOf } from "../src/encode";
import { fieldToHex } from "../src/field";
import { commitmentOf, initHashing, nullifierOf } from "../src/hash";
import { GroupIssuer } from "../src/issuer";
import { membershipInputs } from "../src/member";
import { NullifierBook } from "../src/nullifiers";
import { MembershipError, MembershipProver, MembershipVerifier, type MembershipProof } from "../src/prove";
import { treeFromRoot, type GroupRoot } from "../src/roots";
import { toB64u, fromB64u } from "@toip-tools/trust-core";

const DAY = 86_400_000;
const acme = identityFromSeed(seedFrom("acc/acme"));
const pine = identityFromSeed(seedFrom("acc/pine"));
let prover: MembershipProver;
let verifier: MembershipVerifier;
let vkHash: string;

beforeAll(async () => {
  await initHashing();
  prover = await MembershipProver.create();
  verifier = await MembershipVerifier.create();
  vkHash = (await loadArtifacts()).vkHash;
}, 60_000);
afterAll(async () => {
  await prover?.destroy();
  await verifier?.destroy();
});

const SCOPE = scopeOf("tipline/v1", "did:key:z6MkBox", "story-1");
const signalFor = (body: string) => messageOf("tipline/v1", { kind: "tip", body });

/** Acme with 5 members; Priya and Marcus among them. Roots published on day 0. */
function world() {
  const clock = new DemoClock("2026-11-06T00:00:05Z");
  const issuer = new GroupIssuer({ identity: acme, clock, name: "employees" });
  const priya = memberSecret(seedFrom("acc/priya-wallet"), issuer.groupId);
  const marcus = memberSecret(seedFrom("acc/marcus-wallet"), issuer.groupId);
  for (let i = 0; i < 3; i++) issuer.enroll(`did:key:filler${i}`, commitmentOf(BigInt(1000 + i), issuer.groupField));
  issuer.enroll("did:key:priya", commitmentOf(priya, issuer.groupField));
  issuer.enroll("did:key:marcus", commitmentOf(marcus, issuer.groupField));
  issuer.publish();
  const policy: AcceptPolicy = { groups: [{ group: issuer.groupId, issuer: acme.did }], vkHashes: [vkHash], maxEpochAge: 3, minSize: 3 };
  return { clock, issuer, priya, marcus, policy };
}

async function proveAgainst(secret: bigint, root: GroupRoot, snapshot: Uint8Array, clock: DemoClock, signal = signalFor("hello")) {
  const tree = treeFromRoot(root, snapshot);
  const { statement, witness } = membershipInputs({ secret, groups: [{ group: root.group, tree }], scope: SCOPE, signal, today: dayOf(clock.now()) });
  return prover.prove(statement, witness);
}

describe("acceptMembership", () => {
  it("accepts a member's proof against a root in the verified log", async () => {
    const { clock, issuer, priya, policy } = world();
    const [root] = issuer.log();
    const proof = await proveAgainst(priya, root, issuer.snapshot(root.epoch)!, clock);
    const r = await acceptMembership(proof, { policy, logs: { [issuer.groupId]: issuer.log() }, verifier, scope: SCOPE, signal: signalFor("hello"), clock });
    expect(r).toMatchObject({ ok: true, nullifier: nullifierOf(priya, SCOPE, 0), size: 5 });
    expect(r.ok && r.roots[0].epoch).toBe("2026-11-06");
  });

  it("refuses with each reason", async () => {
    const { clock, issuer, priya, policy } = world();
    const [root] = issuer.log();
    const proof = await proveAgainst(priya, root, issuer.snapshot(root.epoch)!, clock);
    const logs = { [issuer.groupId]: issuer.log() };
    const ctx = { policy, logs, verifier, scope: SCOPE, signal: signalFor("hello"), clock };
    const reason = async (p: unknown, over: Partial<typeof ctx> = {}) => {
      const r = await acceptMembership(p, { ...ctx, ...over });
      return r.ok ? "ok" : r.reason;
    };
    expect(await reason(proof)).toBe("ok");
    expect(await reason({ ...proof, v: 2 })).toBe("malformed");
    expect(await reason(proof, { policy: { ...policy, vkHashes: ["ab".repeat(32)] } })).toBe("circuit");
    expect(await reason(proof, { policy: { ...policy, groups: [{ group: `${acme.did}#other`, issuer: acme.did }] } })).toBe("group");
    expect(await reason(proof, { policy: { ...policy, groups: [{ group: issuer.groupId, issuer: pine.did }] } })).toBe("log");
    expect(await reason(proof, { logs: {} })).toBe("log");
    expect(await reason(proof, { policy: { ...policy, minSize: 6 } })).toBe("tooSmall");
    expect(await reason(proof, { scope: SCOPE + 1n })).toBe("scope");
    expect(await reason(proof, { signal: signalFor("another body") })).toBe("signal");
    expect(await reason(proof, { policy: { ...policy, limit: 2 } })).toBe("statement");
    expect(await reason(proof, { policy: { ...policy, minRegisteredDays: 1 } })).toBe("statement");
    expect(await reason(proof, { policy: { ...policy, predicates: [{ op: "eq", value: 1n }] } })).toBe("statement");
    const bytes = fromB64u(proof.proof);
    bytes[100] ^= 1;
    expect(await reason({ ...proof, proof: toB64u(bytes) })).toBe("proof");
    // A proof against a root that is not in the log.
    const other = new GroupIssuer({ identity: acme, clock, name: "employees" });
    other.enroll("did:key:priya", commitmentOf(priya, other.groupField));
    other.enroll("did:key:x", 5n);
    other.enroll("did:key:y", 6n);
    const { root: r2, snapshot: s2 } = other.publish();
    expect(await reason(await proveAgainst(priya, r2, s2, clock))).toBe("unknownRoot");
  });

  it("refuses a proof dated two days back, accepts one from yesterday", async () => {
    const { clock, issuer, priya, policy } = world();
    const [root] = issuer.log();
    const proof = await proveAgainst(priya, root, issuer.snapshot(root.epoch)!, clock);
    const ctx = { policy, logs: { [issuer.groupId]: issuer.log() }, verifier, scope: SCOPE, signal: signalFor("hello") };
    clock.advance(DAY);
    expect((await acceptMembership(proof, { ...ctx, clock })).ok).toBe(true);
    clock.advance(DAY);
    expect(await acceptMembership(proof, { ...ctx, clock })).toMatchObject({ ok: false, reason: "statement" });
  });

  it("a removed member can't prove against the new root; the old root expires by policy", async () => {
    const { clock, issuer, marcus, policy } = world();
    const [old] = issuer.log();
    const oldSnap = issuer.snapshot(old.epoch)!;
    clock.advance(DAY);
    issuer.revoke("did:key:marcus");
    const { root: fresh, snapshot } = issuer.publish();
    expect(() =>
      membershipInputs({ secret: marcus, groups: [{ group: issuer.groupId, tree: treeFromRoot(fresh, snapshot) }], scope: SCOPE, signal: 1n, today: dayOf(clock.now()) }),
    ).toThrow(MembershipError);
    // Against the old root, within maxEpochAge: accepted.
    for (let d = 0; d < 3; d++) {
      const p = await proveAgainst(marcus, old, oldSnap, clock);
      const r = await acceptMembership(p, { policy, logs: { [issuer.groupId]: issuer.log() }, verifier, scope: SCOPE, signal: signalFor("hello"), clock });
      expect(r.ok, `day ${d + 1}`).toBe(true);
      clock.advance(DAY);
      issuer.publish();
    }
    // The old root is now 4 epochs old.
    const late = await proveAgainst(marcus, old, oldSnap, clock);
    const r = await acceptMembership(late, { policy, logs: { [issuer.groupId]: issuer.log() }, verifier, scope: SCOPE, signal: signalFor("hello"), clock });
    expect(r).toMatchObject({ ok: false, reason: "stale" });
  }, 60_000);

  it("the head root is accepted however old, so groups that publish only on change still work", async () => {
    const clock = new DemoClock("2026-11-06T10:00:00Z");
    const reg = new GroupIssuer({ identity: pine, clock, name: "nurses", period: 3600 });
    const s = memberSecret(seedFrom("acc/ana"), reg.groupId);
    reg.enroll("did:key:ana", commitmentOf(s, reg.groupField));
    reg.enroll("did:key:b", 7n);
    const { root, snapshot } = reg.publish();
    expect(root.epoch).toBe("2026-11-06T10:00:00Z");
    clock.advance(10 * 3600_000);
    const p = await proveAgainst(s, root, snapshot, clock);
    const policy: AcceptPolicy = { groups: [{ group: reg.groupId, issuer: pine.did }], vkHashes: [vkHash], maxEpochAge: 1, minSize: 2 };
    expect((await acceptMembership(p, { policy, logs: { [reg.groupId]: reg.log() }, verifier, scope: SCOPE, signal: signalFor("hello"), clock })).ok).toBe(true);
  });

  it("refuses a group whose issuer equivocated, and returns both roots", async () => {
    const { clock, issuer, priya, policy } = world();
    const [root] = issuer.log();
    const proof = await proveAgainst(priya, root, issuer.snapshot(root.epoch)!, clock);
    const { proof: _p, ...body } = root;
    const tailored = signDocument({ ...body, id: "urn:uuid:tailored", root: fieldToHex(99n), size: 60 }, acme, clock);
    const r = await acceptMembership(proof, { policy, logs: { [issuer.groupId]: [root, tailored] }, verifier, scope: SCOPE, signal: signalFor("hello"), clock });
    expect(r).toMatchObject({ ok: false, reason: "equivocation" });
    expect(r.ok === false && r.evidence?.length).toBe(2);
  });

  it("checks pinned roots: a proof against a later root fails", async () => {
    const { clock, issuer, priya, policy } = world();
    const [pinned] = issuer.log();
    clock.advance(DAY);
    issuer.enroll("did:key:late", 77n);
    const { root: later, snapshot } = issuer.publish();
    const proof = await proveAgainst(priya, later, snapshot, clock);
    const logs = { [issuer.groupId]: issuer.log() };
    const ctx = { logs, verifier, scope: SCOPE, signal: signalFor("hello"), clock };
    expect((await acceptMembership(proof, { ...ctx, policy })).ok).toBe(true);
    expect(await acceptMembership(proof, { ...ctx, policy: { ...policy, pinnedRoots: [pinned.root] } })).toMatchObject({ ok: false, reason: "unknownRoot" });
  });

  it("accepts proofs from any of several groups, hiding which", async () => {
    const { clock, issuer, priya, policy } = world();
    const reg = new GroupIssuer({ identity: pine, clock, name: "nurses" });
    const ana = memberSecret(seedFrom("acc/ana"), reg.groupId);
    reg.enroll("did:key:ana", commitmentOf(ana, reg.groupField));
    reg.enroll("did:key:b", 8n);
    reg.publish();
    const both: AcceptPolicy = { ...policy, groups: [...policy.groups, { group: reg.groupId, issuer: pine.did }], minSize: 7 };
    const logs = { [issuer.groupId]: issuer.log(), [reg.groupId]: reg.log() };
    const trees = [
      { group: issuer.groupId, tree: treeFromRoot(issuer.log()[0], issuer.snapshot("2026-11-06")!) },
      { group: reg.groupId, tree: treeFromRoot(reg.log()[0], reg.snapshot("2026-11-06")!) },
    ];
    const proofs: MembershipProof[] = [];
    for (const secret of [priya, ana]) {
      const { statement, witness } = membershipInputs({ secret, groups: trees, scope: SCOPE, signal: signalFor("hello"), today: dayOf(clock.now()) });
      proofs.push(await prover.prove(statement, witness));
    }
    expect(proofs[0].statement).toEqual(proofs[1].statement);
    for (const p of proofs) {
      const r = await acceptMembership(p, { policy: both, logs, verifier, scope: SCOPE, signal: signalFor("hello"), clock });
      expect(r).toMatchObject({ ok: true, size: 7 });
    }
    expect(groupFieldOf(reg.groupId)).not.toBe(groupFieldOf(issuer.groupId));
  }, 60_000);
});

describe("NullifierBook", () => {
  it("labels sources in order of first sight, per group and scope", () => {
    const book = new NullifierBook();
    expect(book.label("g", 1n, 100n)).toEqual({ label: "Source A", first: true });
    expect(book.label("g", 1n, 200n)).toEqual({ label: "Source B", first: true });
    expect(book.label("g", 1n, 100n)).toEqual({ label: "Source A", first: false });
    expect(book.label("g", 2n, 200n)).toEqual({ label: "Source A", first: true });
    expect(book.label("h", 1n, 200n)).toEqual({ label: "Source A", first: true });
    expect(book.count("g", 1n)).toBe(2);
    expect(book.count("g", 3n)).toBe(0);
    expect(book.has("g", 1n, 200n)).toBe(true);
  });

  it("goes past Z, and survives state() and back", () => {
    const book = new NullifierBook();
    for (let i = 0; i < 27; i++) book.label("g", 1n, BigInt(i + 1));
    expect(book.label("g", 1n, 27n).label).toBe("Source AA");
    const copy = new NullifierBook(JSON.parse(JSON.stringify(book.state())));
    expect(copy.label("g", 1n, 1n)).toEqual({ label: "Source A", first: false });
    expect(copy.label("g", 1n, 999n)).toEqual({ label: "Source AB", first: true });
    expect(copy.count("g", 1n)).toBe(28);
  });
});
