/**
 * The demo script (design §12.3) as a test, with real proofs, over real HTTP and TSP on an in-memory bus.
 * Each step depends on the ones before it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MembershipError, fieldToHex, fieldFromHex, membershipInputs, treeFromRoot, type Statement } from "@toip-tools/anon-membership";
import { identityFromSeed, signDocument } from "@toip-tools/trust-core";
import type { AgoraClient } from "../src/client/client";
import { AgoraError } from "../src/client/http";
import type { ForumPolicy, Gate, NymPass, Poll } from "../src/protocol/documents";
import { docHash, newId } from "../src/protocol/documents";
import { compileGate, forumNymScope, passSignal } from "../src/protocol/gate";
import { nymName } from "../src/protocol/names";
import { DAY, HOUR, nursingClaims, residencyClaims, testWorld, type TestWorld } from "./helpers";

let w: TestWorld;
let ana: AgoraClient, ben: AgoraClient, cal: AgoraClient, dee: AgoraClient;
let nightShift: ForumPolicy, townSquare: ForumPolicy;
let anaNym: string;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as AgoraError).code ?? String(e);
  }
};

beforeAll(async () => {
  w = await testWorld();
  [ana, ben, cal, dee] = await Promise.all(["ana", "ben", "cal", "dee"].map((n) => w.member(n)));
}, 120_000);
afterAll(async () => w?.close());

describe("the demo script", () => {
  it("1. issues credentials over TSP", async () => {
    await ana.requestCredential(w.byKey.cascade.did, nursingClaims("RN"));
    await ana.requestCredential(w.byKey.riverton.did, residencyClaims("7"));
    await ben.requestCredential(w.byKey.pine.did, nursingClaims("RN", "OR"));
    await cal.requestCredential(w.byKey.cascade.did, nursingClaims("LPN"));
    await cal.requestCredential(w.byKey.riverton.did, residencyClaims("3"));
    expect(ana.credentials()).toHaveLength(2);
    await expect(ben.requestCredential(w.byKey.pine.did, nursingClaims("MD" as "RN", "OR"))).rejects.toMatchObject({ code: "badClaim" });
  });

  it("2. joins groups seeded with 40 simulated members each", async () => {
    await ana.join(w.byKey.cascade.registrar.groupId);
    await ana.join(w.byKey.riverton.registrar.groupId);
    await ben.join(w.byKey.pine.registrar.groupId);
    await cal.join(w.byKey.cascade.registrar.groupId);
    await cal.join(w.byKey.riverton.registrar.groupId);
    expect(w.byKey.cascade.registrar.size()).toBe(42);
    expect(w.byKey.pine.registrar.size()).toBe(41);
    expect(await code(ana.join(w.byKey.cascade.registrar.groupId))).toBe("alreadyMember");
    await expect(ana.join(w.byKey.pine.registrar.groupId)).rejects.toMatchObject({ code: "noCredential" });
  });

  it("3. Dee creates Night Shift and Town Square; time skips 8 days", async () => {
    const nursing: Gate = {
      anyOf: [
        { group: w.byKey.cascade.registrar.groupId, registrar: w.byKey.cascade.did },
        { group: w.byKey.pine.registrar.groupId, registrar: w.byKey.pine.did },
      ],
      where: [{ attr: "licenseType", op: "eq", value: "RN" }],
      minRegisteredDays: 7,
      minAnonymitySet: 25,
    };
    nightShift = await dee.createForum({ title: "Night Shift", slug: "night-shift", description: "For RNs on nights.", gate: nursing, rules: ["No names of patients or colleagues."] });
    townSquare = await dee.createForum({
      title: "Riverton Town Square",
      slug: "town-square",
      description: "For Riverton residents.",
      gate: { anyOf: [{ group: w.byKey.riverton.registrar.groupId, registrar: w.byKey.riverton.did }], where: [], minRegisteredDays: 0, minAnonymitySet: 25 },
    });
    expect((await ana.eligibility(nightShift.gate)).ok).toBe(false);
    expect(await ana.eligibility(nightShift.gate)).toMatchObject({ code: "tooRecent" });
    await w.advance(8 * DAY);
    expect(await ana.eligibility(nightShift.gate)).toMatchObject({ ok: true });
    await expect(w.host.createForum(nightShift)).rejects.toMatchObject({ code: "duplicate" });
  });

  it("4. Ana and Ben post under different nyms; readers verify", async () => {
    anaNym = ana.nymFor(nightShift.forum.id);
    expect(await ana.anonymitySet(nightShift.gate)).toBeGreaterThanOrEqual(70);
    const stages: string[] = [];
    const t = await ana.startThread({ forum: nightShift.forum.id, title: "Float pool on 4 West?", body: "Is anyone else being floated every shift?", onProgress: (p) => stages.push(p.stage) });
    expect(stages).toContain("proving");
    await ana.reply({ forum: nightShift.forum.id, thread: t.id, threadScope: "forum", body: "Second post, same pass, no new proof." });
    await ben.reply({ forum: nightShift.forum.id, thread: t.id, threadScope: "forum", body: "Every other shift for me." });
    const v = await w.reader().read(nightShift.forum.id);
    expect(v.warnings).toEqual([]);
    const posts = v.threads[0].posts;
    expect(posts.map((p) => p.status)).toEqual(["verified", "verified", "verified"]);
    expect(posts[0].nym).toBe(anaNym);
    expect(posts[1].nym).toBe(anaNym);
    expect(posts[2].nym).not.toBe(anaNym);
    expect(posts[0].name).toBe(nymName(anaNym));
    expect(v.gateWords).toMatch(/license type RN/);
  });

  it("5. Cal (LPN) is refused before any proof, the prover can't prove, and a weaker statement is refused", async () => {
    const el = await cal.eligibility(nightShift.gate);
    expect(el).toMatchObject({ ok: false, code: "attribute", reason: "This forum is for license type RN; yours is LPN." });
    await expect(cal.startThread({ forum: nightShift.forum.id, title: "x", body: "y" })).rejects.toMatchObject({ code: "notEligible" });

    // Force the prover with the real statement: the predicate fails.
    const info = await cal.host.forum(nightShift.forum.id);
    const descs = info.groups;
    const trees = await Promise.all(nightShift.gate.anyOf.map(async (g) => (await cal.syncGroup(g.group)).tree));
    const session = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const draft: Omit<NymPass, "zk" | "proof"> = {
      type: "agora/nym-pass",
      version: 1,
      id: newId(),
      issuer: session.did,
      issuedAt: w.clock.iso(),
      forum: nightShift.forum.id,
      policy: info.policyHash,
      thread: null,
      nym: cal.nymFor(nightShift.forum.id),
      validUntil: new Date(w.clock.now() + DAY - 1000).toISOString(),
    };
    const m = cal.memberships().find((x) => x.group === w.byKey.cascade.registrar.groupId)!;
    const { commitment: _c, ...leafFields } = {
      ...m.leaf,
      schemaId: fieldFromHex(m.leaf.schemaId),
      attrs: m.leaf.attrs.map(fieldFromHex) as [bigint, bigint, bigint, bigint],
      commitment: 0n,
    };
    const real = compileGate({ gate: nightShift.gate, descs, roots: trees.map((t) => t.root()), today: cal.today(), scope: forumNymScope(nightShift.forum.id), signal: passSignal(draft) });
    const inputs = (s: Statement) =>
      membershipInputs({
        secret: cal.secret(),
        groups: nightShift.gate.anyOf.map((g, i) => ({ group: g.group, tree: trees[i] })),
        leaf: leafFields,
        scope: s.scope,
        signal: s.signal,
        today: s.today,
        registeredBy: s.registeredBy,
        schemaId: s.schemaId,
        predicates: s.predicates,
      });
    const forced = inputs(real);
    await expect(w.prover.prove(real, forced.witness)).rejects.toBeInstanceOf(MembershipError);

    // Drop the licenseType predicate (op 0): it proves, but the host compiles the statement itself.
    const weaker = { ...real, predicates: [] };
    const { witness } = inputs(weaker);
    const zk = await w.prover.prove(weaker, witness);
    const pass = signDocument<NymPass>({ ...draft, zk }, session, w.clock);
    expect(await code(cal.host.pass(nightShift.forum.id, pass))).toBe("statementMismatch");
  });

  it("6. one nym: Ana's second device, from her backup code, is the same nym; a second leaf is refused", async () => {
    const again = await w.member("ana-laptop", ana["seed"] as Uint8Array);
    expect(again.did).toBe(ana.did);
    const found = await again.recover();
    expect(found.map((m) => m.group).sort()).toEqual([w.byKey.cascade.registrar.groupId, w.byKey.riverton.registrar.groupId].sort());
    const v0 = await w.reader().read(nightShift.forum.id);
    await again.reply({ forum: nightShift.forum.id, thread: v0.threads[0].id, threadScope: "forum", body: "From my laptop." });
    const v = await w.reader().read(nightShift.forum.id);
    expect(v.threads[0].posts.at(-1)).toMatchObject({ nym: anaNym, status: "verified" });
    // Two session DIDs, one nym.
    const passes = (await w.host.feed(nightShift.forum.id)).bodies.map((b) => (b as unknown as { doc: NymPass }).doc).filter((d) => d.type === "agora/nym-pass" && d.nym === anaNym);
    expect(new Set(passes.map((p) => p.issuer)).size).toBe(2);
    await again.requestCredential(w.byKey.cascade.did, nursingClaims("RN"));
    expect(await code(again.join(w.byKey.cascade.registrar.groupId))).toBe("alreadyMember");
  });

  it("7. unlinkable across forums: a different nym, nothing shared, no wallet DIDs on the host", async () => {
    w.clock.advance(7 * 60_000);
    await ana.startThread({ forum: townSquare.forum.id, title: "Elm St on Sundays", body: "Should we close it to cars?" });
    const tsNym = ana.nymFor(townSquare.forum.id);
    expect(tsNym).not.toBe(anaNym);
    const passOf = async (forum: string, nym: string) => (await w.host.feed(forum)).bodies.map((b) => (b as unknown as { doc: NymPass }).doc).find((d) => d.type === "agora/nym-pass" && d.nym === nym)!;
    const a = await passOf(nightShift.forum.id, anaNym);
    const b = await passOf(townSquare.forum.id, tsNym);
    expect(a.issuer).not.toBe(b.issuer);
    // The two passes share no value except public constants.
    const values = (x: unknown): string[] => (typeof x === "object" && x ? Object.values(x).flatMap(values) : [String(x)]);
    const shared = values(a).filter((x) => values(b).includes(x));
    const allowed = new Set([String(ana.today()), "agora/nym-pass", "1", "null", "ultrahonk-zk/noir-recursive", "anon-membership/v1/gate-d20", a.zk.vkHash, "0x" + "0".repeat(64), "eddsa-jcs-2022", "DataIntegrityProof", "assertionMethod", "any"]);
    expect(shared.filter((x) => !allowed.has(x) && x.length > 3)).toEqual([]);
    // Two proofs of statements by one person are different bytes.
    expect(a.zk.proof).not.toBe(b.zk.proof);
    // No wallet DID is anywhere in the host's store.
    const dump = JSON.stringify((w.store as unknown as { dump(): unknown }).dump());
    for (const c of [ana, ben, cal]) expect(dump).not.toContain(c.did);
    expect(dump).toContain(dee.did); // the owner and moderator acts under her own DID
  });

  it("8. replay: a copied pass with a new session DID, or for another forum, is refused", async () => {
    const pass = (await w.host.feed(nightShift.forum.id)).bodies.map((b) => (b as unknown as { doc: NymPass }).doc).find((d) => d.type === "agora/nym-pass")!;
    expect(await code(w.host.submitPass(nightShift.forum.id, pass))).toBe("duplicate");
    const thief = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const { proof: _p, ...rest } = pass;
    const stolen = signDocument<NymPass>({ ...rest, id: newId(), issuer: thief.did }, thief, w.clock);
    expect(await code(w.host.submitPass(nightShift.forum.id, stolen))).toBe("statementMismatch");
    const info = await w.host.forumInfo(townSquare.forum.id);
    const moved = signDocument<NymPass>({ ...rest, id: newId(), issuer: thief.did, forum: townSquare.forum.id, policy: info.policyHash }, thief, w.clock);
    expect(await code(w.host.submitPass(townSquare.forum.id, moved))).toBe("statementMismatch");
    // The host can't post as someone: it has no session key, and a post it signs itself names no pass.
    const v = await w.reader().read(nightShift.forum.id);
    const forged = signDocument({ type: "agora/post", version: 1, id: newId(), issuer: w.host.identity.did, issuedAt: w.clock.iso(), forum: nightShift.forum.id, thread: v.threads[0].id, parent: null, body: "I am Ana.", nym: anaNym, pass: docHash(pass) }, w.host.identity, w.clock);
    expect(await code(w.host.submitPost(nightShift.forum.id, forged as never))).toBe("passUnknown");
  });

  it("9. moderation: Ana reports Ben, Dee hides it and bans his nym; he rotates, and still waits", async () => {
    const thread = (await w.reader().read(nightShift.forum.id)).threads[0].id;
    const bad = await ben.reply({ forum: nightShift.forum.id, thread, threadScope: "forum", body: "Patient J. Doe in 4W was a nightmare." });
    await ana.report(nightShift.forum.id, bad.id, "Names a patient (rule 1).");
    expect(await code(cal.moderate(nightShift.forum.id, "hide-post", bad.id, "rule 1"))).toBe("notModerator");
    await dee.moderate(nightShift.forum.id, "hide-post", bad.id, "No names of patients or colleagues.");
    await dee.moderate(nightShift.forum.id, "ban-nym", bad.nym, "No names of patients or colleagues.", { until: new Date(w.clock.now() + 7 * DAY).toISOString() });
    const v = await w.reader().read(nightShift.forum.id);
    expect(v.warnings).toEqual([]);
    const hidden = v.threads[0].posts.find((p) => p.id === bad.id)!;
    expect(hidden).toMatchObject({ status: "hidden", note: "Removed by a moderator: No names of patients or colleagues." });
    expect(hidden.body).toBeUndefined();
    expect(v.reports).toHaveLength(1);
    expect(v.nyms.get(bad.nym)?.banned).toBeTruthy();
    expect(JSON.stringify((await w.host.feed(nightShift.forum.id)).bodies)).not.toContain("J. Doe");
    expect(await code(ben.reply({ forum: nightShift.forum.id, thread, threadScope: "forum", body: "Again." }))).toBe("nymBanned");

    await ben.rotate();
    await w.advance(HOUR);
    expect(ben.nymFor(nightShift.forum.id)).not.toBe(bad.nym);
    expect(await ben.eligibility(nightShift.gate)).toMatchObject({ ok: false, code: "tooRecent" });
    // Restore is logged too.
    await dee.moderate(nightShift.forum.id, "restore-post", bad.id, "Restored after review.");
    expect((await w.reader().read(nightShift.forum.id)).threads[0].posts.find((p) => p.id === bad.id)?.status).toBe("verified");
  });

  let poll: Poll;
  it("10. a poll for district 7: last vote counts while open; district 3 is told why; closing is final", async () => {
    poll = await dee.openPoll({ forum: townSquare.forum.id, question: "Close Elm St to cars on Sundays?", choices: ["Yes", "No", "Abstain"], closesAt: new Date(w.clock.now() + 2 * DAY).toISOString(), where: [{ attr: "district", op: "eq", value: "7" }] });
    expect(poll.pinned).toHaveLength(1);
    const yes = await ana.prepareVote(poll, 0);
    expect(await ana.sendVote(townSquare.forum.id, yes)).toMatchObject({ replaced: false });
    expect(await code(ana.sendVote(townSquare.forum.id, yes))).toBe("nullifierUsed");
    const no = await ana.prepareVote(poll, 1);
    expect(no.nullifier).toBe(yes.nullifier);
    expect(await ana.sendVote(townSquare.forum.id, no)).toMatchObject({ replaced: true });
    expect(w.host.poll(townSquare.forum.id, poll.id).tally).toEqual([0, 1, 0]);
    // A vote for one choice can't be passed off as another.
    expect(await code(w.host.vote(townSquare.forum.id, poll.id, { ...no, choice: 2 }))).toBe("statementMismatch");
    await expect(cal.prepareVote(poll, 0)).rejects.toThrow("This poll is for district 7; yours is 3.");
    // Ben joins Riverton after the poll opened: his leaf isn't in the pinned root.
    await ben.requestCredential(w.byKey.riverton.did, residencyClaims("7"));
    await ben.join(w.byKey.riverton.registrar.groupId);
    await w.advance(HOUR);
    expect(await code(ben.prepareVote(poll, 0))).toBe("notMember");
    const v = await w.reader().read(townSquare.forum.id);
    expect(v.polls[0]).toMatchObject({ tally: [0, 1, 0], votes: 1, rejected: 0, open: true });
    await w.advance(2 * DAY);
    expect(await code(ana.sendVote(townSquare.forum.id, yes))).toBe("pollClosed");
    expect((await w.reader().read(townSquare.forum.id)).polls[0]).toMatchObject({ tally: [0, 1, 0], closed: true });
  });

  it("11. revocation: a simulated RN's license is revoked; the next root drops the leaf", async () => {
    const before = w.byKey.cascade.registrar.roots().at(-1)!;
    const victim = [...Object.keys(w.byKey.cascade.registrar.state().members)].find((d) => d !== ana.did && d !== cal.did)!;
    w.byKey.cascade.revokeSubject(victim);
    await w.advance(HOUR);
    const after = w.byKey.cascade.registrar.roots().at(-1)!;
    expect(after.seq).toBe(before.seq + 1);
    expect(after.size).toBe(before.size - 1);
    expect(after.ext).toMatchObject({ removed: 1 });
  });

  it("refuses stale roots once their grace has passed", async () => {
    const info = await ana.host.forum(nightShift.forum.id);
    const pass = await ana.provePass(info, null, undefined, { send: false });
    // A new root replaces the one the pass was proved against; then more than rootGraceSeconds pass.
    await w.byKey.cascade.registrar.admitDirect("did:key:z6MkLateJoiner", w.byKey.cascade.issue("did:key:z6MkLateJoiner", { licenseType: "RN", state: "WA", licensedSince: "2020-01-01" }), 424242n);
    await w.advance(HOUR);
    expect(await code(w.host.submitPass(nightShift.forum.id, pass.pass))).toBe("ok"); // just replaced: within grace
    const again = await ana.provePass(await ana.host.forum(nightShift.forum.id), null, undefined, { send: false });
    await w.byKey.cascade.registrar.admitDirect("did:key:z6MkLaterJoiner", w.byKey.cascade.issue("did:key:z6MkLaterJoiner", { licenseType: "RN", state: "WA", licensedSince: "2020-01-01" }), 434343n);
    await w.advance(HOUR);
    await w.advance(2 * HOUR);
    expect(await code(w.host.submitPass(nightShift.forum.id, again.pass))).toBe("rootNotAccepted");
  });

  it("refuses an expired membership, and drops it from the group", async () => {
    await w.advance(740 * DAY);
    expect(await ana.eligibility(nightShift.gate)).toMatchObject({ ok: false });
    expect(w.byKey.cascade.registrar.isMember(ana.did)).toBe(false);
    expect(await code(ana.startThread({ forum: nightShift.forum.id, title: "Still here?", body: "x" }))).toBe("notEligible");
  });
});

describe("feed integrity", () => {
  it("detects a body changed in the host's store, and a rewritten history", async () => {
    const reader = w.reader();
    const ok = await reader.read(nightShift.forum.id);
    expect(ok.historyChanged).toBe(false);
    // Change one stored body: the trail's SAID no longer matches.
    const store = w.store as unknown as { bodies: Map<string, string> };
    const [said, raw] = [...store.bodies].find(([, r]) => r.includes("Every other shift for me."))!;
    store.bodies.set(said, raw.replace("Every other shift", "Never once"));
    const tampered = await reader.read(nightShift.forum.id);
    expect(tampered.warnings.join(" ")).toMatch(/doesn't verify/);
    store.bodies.set(said, raw);
    // Rewrite history: drop the trail's messages after the first and append new ones with the host's own key.
    const byLog = (w.store as unknown as { byLog: Map<string, Map<number, unknown[]>> }).byLog;
    const trailId = [...byLog.keys()].find((k) => byLog.get(k)!.size > 5)!;
    const log = byLog.get(trailId)!;
    const keep = 2;
    for (const s of [...log.keys()]) if (s >= keep) log.delete(s);
    const fresh = await w.reader().read(nightShift.forum.id);
    expect(fresh.historyChanged).toBe(false); // a new reader can't know
    const seen = await reader.read(nightShift.forum.id);
    expect(seen.historyChanged).toBe(true);
    expect(seen.warnings).toContain("This host's history changed since you last read it.");
  });
});
