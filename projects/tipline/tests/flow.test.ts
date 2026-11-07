// The whole protocol over a real relay with real proofs (design §12.4): enrollment, root publication,
// a tip with a file from a fresh DID, Source A and B, replies the source reads with the tip code alone,
// refusals (non-member, lifted proof, wrong scope, unknown and stale roots, equivocation), and what
// the organization and the relay can see.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  GroupTree,
  MembershipError,
  commitmentOf,
  encodeMembershipCode,
  fieldToHex,
  groupFieldOf,
  leafHash,
  membershipInputs,
  plainLeaf,
  dayOf,
  rootDocHash,
  type GroupRoot,
} from "@zk-toip/anon-membership";
import { TaskError, fromB64u, identityFromSeed, seedFrom, toB64u, CoarseClock, Endpoint } from "@zk-toip/trust-core";
import { newTipCode, tipKeys } from "../src/protocol/codes";
import { SUBMIT, tipScope, tipSignal, type SubmitPayload } from "../src/protocol/messages";
import { SOURCE_WIRE_BYTES, sealPadded, sourceSize } from "../src/protocol/padding";
import { storyOf } from "../src/protocol/descriptor";
import { findMetadata, stripMetadata } from "../src/sanitize/metadata";
import { InboxAgent } from "../src/agents/inbox";
import { buildTip, checkGroup, deliver, findMembership, TipConversation, type GroupView, type Membership } from "../src/agents/source";
import { checkMembership, enrollWallet, membershipCode, walletCommitment } from "../src/agents/wallet";
import { ACME_URL, OTHER_STORY, OUTLET_URL, STORY, makeWorld, until, type World } from "./harness";
import { syntheticJpeg, withExif } from "./fixtures/images";

// Nothing in this file may fetch from the network: in particular, no CRS download for proving.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = vi.fn(async (u: unknown) => {
    throw new Error(`network fetch attempted: ${String(u)}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

let w: World;
let inbox: InboxAgent;
let priya: Awaited<ReturnType<World["wallet"]>>;
let marcus: Awaited<ReturnType<World["wallet"]>>;
let view: GroupView;
const sent: Uint8Array[] = [];
let firstTip: { code: string; tipId: string; did: string; nullifier: string };

const logUrl = `${ACME_URL}groups/employees/log.json`;
const snapshotUrl = (e: string) => `${ACME_URL}groups/employees/snapshot/${e}.bin`;
const story = () => storyOf(w.descriptor, STORY)!;
const group = () => story().groups[0];

async function loadGroup(): Promise<GroupView> {
  const c = await checkGroup({ outletUrl: OUTLET_URL, group: group(), fetcher: w.fetcher, clock: w.clock, alsoOrganization: true, organization: "Acme" });
  if (!c.ok) throw new Error(c.why);
  return c.view;
}

async function member(code: string, v = view): Promise<Membership> {
  const m = await findMembership({ code, view: v, outletUrl: OUTLET_URL, fetcher: w.fetcher });
  if (!m.ok) throw new Error(m.why);
  return m.membership;
}

async function tip(o: { code: string; membership: Membership; storyId?: string; subject?: string; files?: Uint8Array[] }) {
  const built = await buildTip({
    code: o.code,
    descriptor: w.descriptor,
    story: storyOf(w.descriptor, o.storyId ?? STORY)!,
    membership: o.membership,
    body: { subject: o.subject ?? "Valve log", text: "The pressure log for valve 7 was rewritten after the incident." },
    files: (o.files ?? []).map((bytes) => ({ bytes, mediaType: "image/jpeg", cleaned: "reencoded" as const })),
    prover: w.prover,
    clock: w.clock,
  });
  sent.push(...built.wires);
  await deliver(built, { relayUrl: w.relay.url });
  return built;
}

const tipsNow = () => inbox.list().length;
const refusedNow = () => inbox.refusals().length;

beforeAll(async () => {
  w = await makeWorld();
  w.acme.seed(58);
  priya = await w.wallet("priya");
  marcus = await w.wallet("marcus");
}, 60_000);
afterAll(async () => w?.close());

describe("enrollment and roots", () => {
  it("enrolls roster members over TSP and refuses anyone else", async () => {
    w.acme.addEmployee("Priya Raman", priya.identity.did);
    w.acme.addEmployee("Marcus Bell", marcus.identity.did);
    const e = await enrollWallet(priya.endpoint, w.acme.identity.did, w.acme.groupId, priya.seed);
    expect(e.index).toBe(58);
    expect(fieldToHex(e.leaf.commitment)).toBe(walletCommitment(priya.seed, w.acme.groupId));
    expect((await enrollWallet(marcus.endpoint, w.acme.identity.did, w.acme.groupId, marcus.seed)).index).toBe(59);

    const stranger = await w.wallet("stranger");
    await expect(enrollWallet(stranger.endpoint, w.acme.identity.did, w.acme.groupId, stranger.seed)).rejects.toMatchObject({ code: "notAdmitted" });
    expect(TaskError).toBeDefined();
  });

  it("shows HR each member's DID next to their commitment, and nothing more", () => {
    const p = w.acme.members().find((m) => m.did === priya.identity.did)!;
    expect(p).toMatchObject({ name: "Priya Raman", index: 58, commitment: walletCommitment(priya.seed, w.acme.groupId) });
    expect(JSON.stringify(w.acme.state())).not.toContain(membershipCode(priya.seed, w.acme.groupId).replace(/-/g, ""));
  });

  it("publishes one signed root a day, which the wallet finds its leaf in", async () => {
    const before = await checkMembership({ walletSeed: priya.seed, groupId: w.acme.groupId, issuer: w.acme.identity.did, logUrl, snapshotUrl, fetcher: w.fetcher, clock: w.clock });
    expect(before.state).toBe("pending");
    const root = w.acme.publish();
    expect(root).toMatchObject({ epoch: "2026-11-06", seq: 0, size: 60, prev: null });
    expect(() => w.acme.publish()).toThrow(/already has a root/);
    expect(w.acme.publishIfDue()).toBeNull();
    const after = await checkMembership({ walletSeed: priya.seed, groupId: w.acme.groupId, issuer: w.acme.identity.did, logUrl, snapshotUrl, fetcher: w.fetcher, clock: w.clock });
    expect(after).toEqual({ state: "in", epoch: "2026-11-06", size: 60, index: 58 });
    await w.mirror.refresh();
    expect(w.mirror.state()).toMatchObject({ ok: true, head: { epoch: "2026-11-06", size: 60 } });
  });

  it("lets the source check the group at the mirror against Acme's own copy", async () => {
    view = await loadGroup();
    expect(view.head.size).toBe(60);
    expect(view.checkedOrganization).toBe(true);
    const m = await member(membershipCode(priya.seed, w.acme.groupId));
    expect(m.newest).toBe(true);
  });

  it("refuses a group below the drop box's minimum size", async () => {
    const c = await checkGroup({ outletUrl: OUTLET_URL, group: { ...group(), minSize: 61 }, fetcher: w.fetcher, clock: w.clock, alsoOrganization: false });
    expect(c).toMatchObject({ ok: false, why: /only 60 members/ });
  });
});

describe("a tip, Source A, and a reply", () => {
  let photo: Uint8Array;

  it("waits on the relay while the inbox is offline, and is verified when it starts", async () => {
    const original = withExif(syntheticJpeg(), { model: "Pixel 8", lat: 29.76, lon: -95.37, serial: "X1" });
    photo = stripMetadata(original);
    expect(findMetadata(photo)).toEqual([]);
    const code = newTipCode();
    const built = await tip({ code, membership: await member(membershipCode(priya.seed, w.acme.groupId)), files: [photo] });
    firstTip = { code, tipId: built.tipId, did: built.identity.did, nullifier: built.nullifier };
    expect(w.relay.queued(w.sam.did)).toBe(2); // the submit and one chunk

    inbox = w.startInbox();
    await until(() => inbox.tip(built.tipId)?.status === "complete", 20_000, "the tip");
    const t = inbox.tip(built.tipId)!;
    expect(t).toMatchObject({ label: "Source A", firstFromSource: true, story: STORY, from: built.identity.did, epoch: "2026-11-06", size: 60, subject: "Valve log" });
    expect(t.attachments).toMatchObject([{ id: "a1", name: "attachment-1.jpg", status: "ok", findings: [] }]);
    expect(await inbox.file(built.tipId, "a1")).toEqual(photo);
    expect(inbox.sources(STORY)).toBe(1);
  }, 60_000);

  it("came from a fresh did:key, in messages that all look the same to the relay", () => {
    const toDropbox = w.stored.filter((m) => m.to === w.sam.did);
    expect(toDropbox).toHaveLength(2);
    expect(new Set(toDropbox.map((m) => m.from))).toEqual(new Set([firstTip.did]));
    expect(new Set(toDropbox.map((m) => m.bytes)).size).toBe(1);
    expect(toDropbox[0].bytes).toBeGreaterThan(SOURCE_WIRE_BYTES - 3);
    expect(firstTip.did).not.toBe(priya.identity.did);
  });

  it("delivers the journalist's reply to a source who comes back with the tip code alone", async () => {
    await inbox.reply(firstTip.tipId, "Thank you. Who else saw the original log?");
    const convo = new TipConversation({ code: firstTip.code, descriptor: w.descriptor, relayUrl: w.relay.url, clock: w.clock });
    w.clock.advance(3_600_000);
    await convo.start();
    await until(() => convo.messages.some((m) => m.text.startsWith("Thank you")) && !!convo.receipt, 20_000, "the reply");
    expect(convo.receipt).toMatchObject({ status: "verified" });
    expect(convo.did).toBe(firstTip.did);
    // The thread resend also gives back the source's own tip, which nothing on the device kept.
    await until(() => convo.messages.some((m) => m.from === "source" && m.text.includes("valve 7")), 20_000, "the resent thread");
    await convo.send("Two shift supervisors. I can describe the night it happened.");
    await convo.flushed();
    await until(() => inbox.tip(firstTip.tipId)!.thread.some((m) => m.from === "source" && m.text.startsWith("Two shift")), 20_000, "the answer");
    convo.close();
  }, 60_000);

  it("recognizes a second tip from the same member on the same story as Source A", async () => {
    const before = tipsNow();
    const built = await tip({ code: newTipCode(), membership: await member(membershipCode(priya.seed, w.acme.groupId)), subject: "Second" });
    await until(() => tipsNow() === before + 1 && inbox.tip(built.tipId)?.status === "complete", 20_000, "the second tip");
    expect(inbox.tip(built.tipId)).toMatchObject({ label: "Source A", firstFromSource: false, nullifier: firstTip.nullifier });
    expect(built.identity.did).not.toBe(firstTip.did);
    expect(inbox.sources(STORY)).toBe(1);
  }, 60_000);

  it("labels a different member Source B", async () => {
    const built = await tip({ code: newTipCode(), membership: await member(membershipCode(marcus.seed, w.acme.groupId)), subject: "From maintenance" });
    await until(() => inbox.tip(built.tipId)?.status === "complete", 20_000, "Marcus's tip");
    expect(inbox.tip(built.tipId)).toMatchObject({ label: "Source B", firstFromSource: true });
    expect(inbox.sources(STORY)).toBe(2);
  }, 60_000);

  it("gives the same member an unrelated nullifier on another story", async () => {
    const built = await tip({ code: newTipCode(), membership: await member(membershipCode(priya.seed, w.acme.groupId)), storyId: OTHER_STORY });
    await until(() => inbox.tip(built.tipId)?.status === "complete", 20_000, "the other story's tip");
    expect(inbox.tip(built.tipId)).toMatchObject({ label: "Source A", story: OTHER_STORY });
    expect(built.nullifier).not.toBe(firstTip.nullifier);
    expect(inbox.sources(OTHER_STORY)).toBe(1);
  }, 60_000);
});

describe("refusals", () => {
  it("can't make a proof for a non-member", async () => {
    const strangerCode = encodeMembershipCode(123456789n, w.acme.groupId);
    expect(await findMembership({ code: strangerCode, view, outletUrl: OUTLET_URL, fetcher: w.fetcher })).toMatchObject({ ok: false, why: /isn't in the group/ });
    expect(await findMembership({ code: "ABCD-EFGH", view, outletUrl: OUTLET_URL, fetcher: w.fetcher })).toMatchObject({ ok: false, why: /typo/ });
    expect(() =>
      membershipInputs({ secret: 123456789n, groups: [{ group: w.acme.groupId, tree: view.tree }], scope: tipScope(w.sam.did, STORY), signal: 1n, today: dayOf(w.clock.now()) }),
    ).toThrow(MembershipError);
  });

  /** Sends a hand-made submit from `identity`, as a forger would. */
  async function forge(identity: ReturnType<typeof identityFromSeed>, payload: Omit<SubmitPayload, "padding">) {
    const ep = new Endpoint({ identity, transport: { attach() {}, detach() {}, post: async () => "undelivered" }, clock: new CoarseClock(w.clock) });
    const wire = await sealPadded(ep, w.sam.did, SUBMIT, payload, sourceSize);
    await deliver({ code: "", tipId: payload.tipId, identity, dropbox: w.sam.did, wires: [wire], proveMs: 0, nullifier: "" }, { relayUrl: w.relay.url });
  }

  async function provedPayload(o: { code: string; storyId?: string; replyTo?: string; tree?: GroupTree; secret?: bigint }) {
    const k = tipKeys(o.code);
    const body = { subject: "s", text: "t" };
    const storyId = o.storyId ?? STORY;
    const m = await member(membershipCode(priya.seed, w.acme.groupId));
    const { statement, witness } = membershipInputs({
      secret: o.secret ?? m.secret,
      groups: [{ group: w.acme.groupId, tree: o.tree ?? m.tree }],
      scope: tipScope(w.sam.did, storyId),
      signal: tipSignal({ dropbox: w.sam.did, story: storyId, tipId: k.tipId, replyTo: o.replyTo ?? k.identity.did, body, attachments: [] }),
      today: dayOf(w.clock.now()),
    });
    const membership = await w.prover.prove(statement, witness);
    return { k, payload: { v: 1 as const, tipId: k.tipId, story: STORY, body, attachments: [], chunks: 1, membership } };
  }

  const lastRefusal = async (n: number) => {
    await until(() => refusedNow() > n, 20_000, "a refusal");
    return inbox.refusals().at(-1)!;
  };

  it("refuses a proof lifted onto another sender", async () => {
    const { payload } = await provedPayload({ code: newTipCode() });
    const n = refusedNow();
    await forge(identityFromSeed(seedFrom("lifter")), payload);
    expect(await lastRefusal(n)).toMatchObject({ reason: "signal" });
  }, 30_000);

  it("refuses a proof with a changed body", async () => {
    const { k, payload } = await provedPayload({ code: newTipCode() });
    const n = refusedNow();
    await forge(k.identity, { ...payload, body: { subject: "s", text: "changed" } });
    expect(await lastRefusal(n)).toMatchObject({ reason: "signal" });
  }, 30_000);

  it("refuses a proof made for another story (wrong scope)", async () => {
    const { k, payload } = await provedPayload({ code: newTipCode(), storyId: OTHER_STORY });
    const n = refusedNow();
    await forge(k.identity, payload);
    expect(await lastRefusal(n)).toMatchObject({ reason: "scope" });
  }, 30_000);

  it("refuses a non-member's proof against a group root Acme never signed", async () => {
    const secret = 987654321n;
    const own = GroupTree.fromLeaves([leafHash(plainLeaf(commitmentOf(secret, groupFieldOf(w.acme.groupId)))), ...Array.from({ length: 59 }, (_, i) => BigInt(i + 7))]);
    const { k, payload } = await provedPayload({ code: newTipCode(), tree: own, secret });
    const n = refusedNow();
    await forge(k.identity, payload);
    expect(await lastRefusal(n)).toMatchObject({ reason: "unknownRoot" });
  }, 30_000);

  it("refuses a second submit reusing a tip id", async () => {
    const k = tipKeys(firstTip.code);
    const { payload } = await provedPayload({ code: firstTip.code });
    const n = refusedNow();
    await forge(k.identity, payload);
    expect(await lastRefusal(n)).toMatchObject({ reason: "duplicate", tipId: firstTip.tipId });
  }, 30_000);

  it("ignores the same sealed document sent twice (replay guard)", async () => {
    const before = { tips: tipsNow(), refused: refusedNow() };
    const t = new (await import("@zk-toip/trust-core")).RelayTransport({ url: w.relay.url, identity: tipKeys(firstTip.code).identity });
    t.start();
    await until(() => t.status === "connected");
    await t.post(firstTip.did, w.sam.did, sent[0]);
    await until(() => t.pending() === 0);
    t.stop();
    await new Promise((r) => setTimeout(r, 500));
    await inbox.idle();
    expect({ tips: tipsNow(), refused: refusedNow() }).toEqual(before);
  }, 30_000);
});

describe("revocation and freshness", () => {
  let oldMarcus: Membership;

  it("removes a leaver from the next root; an old root is accepted within 3 days and refused after", async () => {
    w.acme.removeEmployee(marcus.identity.did);
    oldMarcus = await member(membershipCode(marcus.seed, w.acme.groupId));
    await w.skipDays(1);
    view = await loadGroup();
    expect(view.head).toMatchObject({ epoch: "2026-11-07", size: 59 });
    const now = await findMembership({ code: membershipCode(marcus.seed, w.acme.groupId), view, outletUrl: OUTLET_URL, fetcher: w.fetcher });
    expect(now).toMatchObject({ ok: true, membership: { newest: false } });
    const wallet = await checkMembership({ walletSeed: marcus.seed, groupId: w.acme.groupId, issuer: w.acme.identity.did, logUrl, snapshotUrl, fetcher: w.fetcher, clock: w.clock });
    expect(wallet).toMatchObject({ state: "removed", lastSeen: "2026-11-06" });

    // A day later, Marcus can still prove against the 2026-11-06 root.
    const built = await tip({ code: newTipCode(), membership: oldMarcus, subject: "Still within the window" });
    await until(() => inbox.tip(built.tipId)?.status === "complete", 20_000, "the within-window tip");
    expect(inbox.tip(built.tipId)).toMatchObject({ label: "Source B", epoch: "2026-11-06" });

    await w.skipDays(3);
    const n = refusedNow();
    const stale = await tip({ code: newTipCode(), membership: oldMarcus, subject: "Too late" });
    await until(() => refusedNow() > n, 20_000, "the stale refusal");
    expect(inbox.refusals().at(-1)).toMatchObject({ reason: "stale", tipId: stale.tipId });
    // His earlier tips stay, marked with the root they used.
    expect(inbox.list().filter((t) => t.label === "Source B" && t.story === STORY).every((t) => t.epoch === "2026-11-06")).toBe(true);
  }, 90_000);
});

describe("equivocation", () => {
  it("is caught by the source app and the inbox, which keep both signed roots", async () => {
    const head = w.acme.log().at(-1)!;
    const fork = w.acme.forkRoot(priya.identity.did);
    expect(fork.root).toMatchObject({ epoch: head.epoch, seq: head.seq, size: 60 });
    w.mirror.tamper(fork.root, fork.snapshot);

    const c = await checkGroup({ outletUrl: OUTLET_URL, group: group(), fetcher: w.fetcher, clock: w.clock, alsoOrganization: true, organization: "Acme" });
    expect(c).toMatchObject({ ok: false, why: /two different roots/ });
    if (!c.ok) expect(new Set(c.evidence!.map(rootDocHash))).toEqual(new Set([rootDocHash(head), rootDocHash(fork.root)]));

    const status = await inbox.groupStatus();
    expect(status[0]).toMatchObject({ ok: false });
    expect(status[0].evidence!.map((d: GroupRoot) => d.root).sort()).toEqual([head.root, fork.root.root].sort());

    // A fresh, honest proof is refused too while the evidence stands.
    w.mirror.untamper();
    const honest = await loadGroup();
    const n = refusedNow();
    await tip({ code: newTipCode(), membership: await member(membershipCode(priya.seed, w.acme.groupId), honest) });
    await until(() => refusedNow() > n, 20_000, "the equivocation refusal");
    expect(inbox.refusals().at(-1)).toMatchObject({ reason: "equivocation" });
  }, 60_000);
});

describe("what the organization and the relay see", () => {
  it("finds the employee DID and commitment only in Acme's roster, and the nullifier only in the inbox", () => {
    const did = priya.identity.did;
    const commitment = walletCommitment(priya.seed, w.acme.groupId);
    const nullifier = firstTip.nullifier;
    const forms = (hex: string) => [hex, hex.slice(2), toB64u(Uint8Array.from(hex.slice(2).match(/../g)!.map((b) => parseInt(b, 16))))];

    const acmeState = JSON.stringify(w.acme.state());
    expect(acmeState).toContain(did);
    expect(acmeState).toContain(commitment);
    for (const f of forms(nullifier)) expect(acmeState).not.toContain(f);

    // Every wire a source sent: sealed, so none of the three appear in any form.
    for (const wire of sent) {
      const text = new TextDecoder("latin1").decode(wire);
      const b64 = toB64u(wire);
      for (const needle of [did, ...forms(commitment), ...forms(nullifier)]) {
        expect(text).not.toContain(needle);
        expect(b64).not.toContain(needle);
      }
    }
    // What the relay recorded about tip traffic: tip DIDs, never the employee's.
    const tipTraffic = w.stored.filter((m) => m.to === w.sam.did || m.from === w.sam.did);
    expect(tipTraffic.length).toBeGreaterThan(5);
    for (const m of tipTraffic) expect([m.from, m.to]).not.toContain(did);
    // And the relay's database holds only what's still queued, as opaque bytes.
    const db = new DatabaseSync(w.relayDb, { readOnly: true });
    const rows = db.prepare("SELECT sender, recipient, wire FROM messages").all() as { sender: string; recipient: string; wire: Uint8Array }[];
    db.close();
    for (const r of rows) for (const needle of [...forms(commitment), ...forms(nullifier)]) expect(toB64u(r.wire)).not.toContain(needle);
    expect(readFileSync(w.relayDb).includes(Buffer.from(nullifier.slice(2)))).toBe(false);
  });

  it("never had the source fetch anything but the mirror and Acme's log", () => {
    for (const u of w.requests) expect(u.startsWith(OUTLET_URL) || u === logUrl || u.startsWith(`${ACME_URL}groups/employees/snapshot/`)).toBe(true);
  });

  it("keeps the inbox's state as JSON that restores the same labels", () => {
    const again = new InboxAgent({ identity: w.sam, transport: { attach() {}, detach() {}, post: async () => "queued" }, clock: w.clock, verifier: w.verifier, fetcher: w.fetcher, outletUrl: OUTLET_URL, state: JSON.parse(JSON.stringify(inbox.state())) });
    expect(again.list().map((t) => t.label)).toEqual(inbox.list().map((t) => t.label));
    expect(again.sources(STORY)).toBe(2);
    expect(Object.keys(again.knownEvidence())).toEqual([w.acme.groupId]);
    expect(fromB64u).toBeDefined();
  });
});
