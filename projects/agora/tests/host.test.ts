/** The host's rules one at a time (design §8, §12.4 "Host"), and a restart on SQLite. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityFromSeed, seedFrom, signDocument } from "@toip-tools/trust-core";
import type { AgoraClient } from "../src/client/client";
import type { AgoraError } from "../src/client/http";
import type { ForumPolicy, Gate, NymPass } from "../src/protocol/documents";
import { docHash, newId } from "../src/protocol/documents";
import { DAY, HOUR, nursingClaims, residencyClaims, testWorld, type TestWorld } from "./helpers";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as AgoraError).code ?? String(e);
  }
};

let w: TestWorld;
let ana: AgoraClient, ben: AgoraClient, dee: AgoraClient;
let gate: Gate;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agora-host-"));
  w = await testWorld({ dataDir: dir, simulated: 30 });
  [ana, ben, dee] = await Promise.all(["h-ana", "h-ben", "h-dee"].map((n) => w.member(n)));
  await ana.requestCredential(w.byKey.riverton.did, residencyClaims("7"));
  await ben.requestCredential(w.byKey.riverton.did, residencyClaims("2"));
  await ana.join(w.byKey.riverton.registrar.groupId);
  await ben.join(w.byKey.riverton.registrar.groupId);
  await w.advance(HOUR);
  gate = { anyOf: [{ group: w.byKey.riverton.registrar.groupId, registrar: w.byKey.riverton.did }], where: [], minRegisteredDays: 0, minAnonymitySet: 25 };
}, 120_000);
afterAll(async () => {
  await w?.close();
  rmSync(dir, { recursive: true, force: true });
});

const forum = (o: Partial<Parameters<AgoraClient["createForum"]>[0]> = {}) => dee.createForum({ title: "Test", slug: "test", description: "", gate, ...o });

describe("the host", () => {
  it("rate-limits a nym, and a moderator can slow one nym further", async () => {
    const f = await forum({ rate: { posts: 3, perSeconds: 3600 } });
    const t = await ana.startThread({ forum: f.forum.id, title: "Rates", body: "1" });
    await ana.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "2" });
    await ana.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "3" });
    expect(await code(ana.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "4" }))).toBe("rateLimited");
    expect(await code(ben.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "other nym" }))).toBe("ok");
    w.clock.advance(HOUR + 1000);
    expect(await code(ana.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "5" }))).toBe("ok");
    await dee.moderate(f.forum.id, "slow-nym", ben.nymFor(f.forum.id), "Cool off.", { rate: { posts: 1, perSeconds: 86400 }, until: null });
    expect(await code(ben.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "again" }))).toBe("rateLimited");
  });

  it("bans until a time, then lets the nym back; locks threads", async () => {
    const f = await forum();
    const t = await ana.startThread({ forum: f.forum.id, title: "Bans", body: "hello" });
    await ben.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "rude" });
    await dee.moderate(f.forum.id, "ban-nym", ben.nymFor(f.forum.id), "Be kind.", { until: new Date(w.clock.now() + DAY).toISOString() });
    expect(await code(ben.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "x" }))).toBe("nymBanned");
    await w.advance(DAY + HOUR);
    expect(await code(ben.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "sorry" }))).toBe("ok");
    await dee.moderate(f.forum.id, "lock-thread", t.id, "Done here.");
    expect(await code(ana.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "x" }))).toBe("threadLocked");
    await dee.moderate(f.forum.id, "unlock-thread", t.id, "Open again.");
    expect(await code(ana.reply({ forum: f.forum.id, thread: t.id, threadScope: "forum", body: "x" }))).toBe("ok");
    expect(await code(ben.moderate(f.forum.id, "unlock-thread", t.id, "me too"))).toBe("notModerator");
  });

  it("lets a thread ask for its own nym scope; a ban there covers only that thread", async () => {
    const f = await forum();
    const t = await ana.startThread({ forum: f.forum.id, title: "Private-ish", body: "a thread nym", nymScope: "thread" });
    const view = await w.reader().read(f.forum.id);
    const thread = view.threads.find((x) => x.id === t.id)!;
    expect(thread.scope).toBe("thread");
    expect(t.nym).toBe(ana.nymFor(f.forum.id, t.id));
    expect(t.nym).not.toBe(ana.nymFor(f.forum.id));
    // A forum pass can't post in it.
    await ben.startThread({ forum: f.forum.id, title: "Forum thread", body: "forum nym" });
    const benForum = (await ben.ensurePass(f.forum.id, null)).pass.nym;
    await ben.reply({ forum: f.forum.id, thread: t.id, threadScope: "thread", body: "thread nym" });
    const benThread = ben.nymFor(f.forum.id, t.id);
    expect(benThread).not.toBe(benForum);
    await dee.moderate(f.forum.id, "ban-nym", benThread, "Off topic.", { until: null });
    expect(await code(ben.reply({ forum: f.forum.id, thread: t.id, threadScope: "thread", body: "x" }))).toBe("nymBanned");
    expect(await code(ben.startThread({ forum: f.forum.id, title: "Still here", body: "forum nym is fine" }))).toBe("ok");
  });

  it("lets only the author's nym delete a post, and keeps the chain valid", async () => {
    const f = await forum();
    const t = await ana.startThread({ forum: f.forum.id, title: "Delete me", body: "oops" });
    expect(await code(ben.deletePost(f.forum.id, t.id))).toBe("passUnknown");
    await ana.deletePost(f.forum.id, t.id);
    const v = await w.reader().read(f.forum.id);
    expect(v.warnings).toEqual([]);
    expect(v.threads[0].posts[0]).toMatchObject({ status: "deleted" });
    expect(JSON.stringify((await w.host.feed(f.forum.id)).bodies)).not.toContain("oops");
  });

  it("refuses a pass for an old policy version, an over-long pass, and an unsigned one", async () => {
    const f = await forum();
    const info = await ana.host.forum(f.forum.id);
    const old = await ana.provePass(info, null, undefined, { send: false });
    const next = signDocument<ForumPolicy>({ ...f, id: newId(), issuedAt: w.clock.iso(), previous: docHash(f), rules: ["Be kind."], proof: undefined }, dee.identity, w.clock);
    expect(await code(ana.host.updatePolicy(f.forum.id, signDocument<ForumPolicy>({ ...next, proof: undefined, issuer: ben.did }, ben.identity, w.clock)))).toBe("notOwner");
    await ana.host.updatePolicy(f.forum.id, next);
    expect(await code(ana.host.pass(f.forum.id, old.pass))).toBe("policyMismatch");
    const session = identityFromSeed(seedFrom("long"));
    const { proof: _p, ...rest } = old.pass;
    const long = signDocument<NymPass>({ ...rest, issuer: session.did, policy: docHash(next), validUntil: new Date(w.clock.now() + 2 * DAY).toISOString() }, session, w.clock);
    expect(await code(ana.host.pass(f.forum.id, long))).toBe("passExpired");
    // Change the nym's last character to a different one (replacing it with a fixed "0" is no change one time in 16).
    const tampered = long.nym.slice(0, -1) + (long.nym.endsWith("0") ? "1" : "0");
    expect(await code(ana.host.pass(f.forum.id, { ...long, nym: tampered }))).toBe("signatureInvalid");
  });

  it("accepts a vote proved yesterday, and refuses one proved two days ago", async () => {
    const f = await forum();
    const poll = await dee.openPoll({ forum: f.forum.id, question: "Q?", choices: ["A", "B"], closesAt: new Date(w.clock.now() + 5 * DAY).toISOString() });
    const a = await ana.prepareVote(poll, 0);
    const b = await ben.prepareVote(poll, 1);
    await w.advance(DAY);
    expect(await code(ana.sendVote(f.forum.id, a))).toBe("ok");
    await w.advance(DAY);
    expect(await code(ben.sendVote(f.forum.id, b))).toBe("statementMismatch");
  });

  it("tells subscribers when the feed grows", async () => {
    const f = await forum();
    const seen: number[] = [];
    const off = w.host.subscribe(f.forum.id, (s) => seen.push(s));
    await ana.startThread({ forum: f.forum.id, title: "SSE", body: "ping" });
    off();
    expect(seen.length).toBe(2); // the pass and the post
  });
});

describe("a restart", () => {
  it("keeps every forum, post, ban and vote, and the feed still verifies; the database holds no wallet DIDs", async () => {
    const f = await forum({ title: "Kept", slug: "kept" });
    await ana.startThread({ forum: f.forum.id, title: "Before restart", body: "still here?" });
    const poll = await dee.openPoll({ forum: f.forum.id, question: "Keep?", choices: ["Yes", "No"], closesAt: new Date(w.clock.now() + DAY).toISOString() });
    await ana.sendVote(f.forum.id, await ana.prepareVote(poll, 0));
    const before = await w.reader().read(f.forum.id);
    const forums = w.host.forumList().length;
    await w.close();

    // The only address in the database is the host's own URL, which forum policies name.
    const db = readFileSync(join(dir, "host.db")).toString("latin1").split(w.hostServer.url).join("");
    for (const c of [ana, ben]) expect(db).not.toContain(c.did);
    expect(db).not.toMatch(/127\.0\.0\.1|user-agent|Mozilla/i);

    const clock = w.clock;
    w = { ...(await testWorld({ dataDir: dir, simulated: 30, start: clock.iso() })) };
    expect(w.host.forumList()).toHaveLength(forums);
    const after = await w.reader().read(f.forum.id);
    expect(after.warnings).toEqual([]);
    expect(after.head).toEqual(before.head);
    expect(after.threads[0].posts[0].body).toBe("still here?");
    expect(w.host.poll(f.forum.id, poll.id).tally).toEqual([1, 0]);
    expect(w.byKey.riverton.registrar.isMember(ana.did)).toBe(true);
  });
});
