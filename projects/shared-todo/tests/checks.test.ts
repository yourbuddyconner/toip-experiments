import { describe, expect, it } from "vitest";
import { checkOp } from "../src/todo/checks";
import { ListModel } from "../src/todo/model";
import { signOp, tamperOp, type OpBody } from "../src/todo/ops";
import type { RosterDoc } from "../src/todo/roster";
import { fixture } from "./helpers";

type Who = "alice" | "bob" | "carol";

async function setup() {
  const f = await fixture();
  const model = new ListModel();
  let roster: RosterDoc = f.roster(1);
  const op = (who: Who | "mallory", body: Partial<OpBody> & { itemId: string }, membershipId?: string) =>
    signOp(f.people[who], f.clock, {
      list: f.list.did,
      kind: "add",
      text: "x",
      membershipId: membershipId ?? (who === "mallory" ? f.memberships.bob.id : f.memberships[who].id),
      ...body,
    });
  const check = (o: unknown, opts: { membership?: Who | null; from?: string; forwarded?: boolean } = {}) =>
    checkOp({
      op: o,
      membership: opts.membership === null ? undefined : f.memberships[opts.membership ?? ((o as { issuer?: string }).issuer === f.people.alice.did ? "alice" : (o as { issuer?: string }).issuer === f.people.carol.did ? "carol" : "bob")],
      roster,
      directSender: opts.forwarded ? undefined : (opts.from ?? (o as { issuer: string }).issuer),
      forwarded: opts.forwarded ?? false,
      listDid: f.list.did,
      model,
      policies: f.policies,
      clock: f.clock,
    });
  return { f, model, op, check, setRoster: (r: RosterDoc) => (roster = r) };
}

describe("checkOp v2 (design 4.5)", () => {
  it("accepts a good op from its author", async () => {
    const { op, check } = await setup();
    expect(await check(op("bob", { itemId: "milk" }))).toEqual({ ok: true });
  });

  it("1. refuses a malformed op, including a malformed sealed part", async () => {
    const { op, check } = await setup();
    expect(await check({ hello: 1 })).toEqual({ ok: false, reason: "malformed operation" });
    const bad = { ...op("bob", { itemId: "p", text: undefined }), sealed: { nonce: "n", ciphertext: "c", keys: "nope" } };
    expect(await check(bad)).toEqual({ ok: false, reason: "malformed operation" });
  });

  it("2. refuses an op for a different list", async () => {
    const { f, check } = await setup();
    const o = signOp(f.people.bob, f.clock, { list: f.people.carol.did, kind: "add", itemId: "m", text: "x", membershipId: f.memberships.bob.id });
    expect(await check(o)).toEqual({ ok: false, reason: "for a different list" });
  });

  it("3. refuses a tampered op", async () => {
    const { op, check } = await setup();
    expect(await check(tamperOp(op("bob", { itemId: "milk" }), "Beer"))).toEqual({ ok: false, reason: "operation: signature does not verify" });
  });

  it("4. refuses a direct op from someone other than its author, but accepts it forwarded", async () => {
    const { f, op, check } = await setup();
    const o = op("bob", { itemId: "milk" });
    expect(await check(o, { from: f.people.carol.did })).toEqual({ ok: false, reason: "not from its author" });
    expect(await check(o, { forwarded: true })).toEqual({ ok: true });
  });

  it("5. refuses an op from more than 5 minutes in the future", async () => {
    const { f, op, check } = await setup();
    f.clock.advance(6 * 60_000);
    const o = op("bob", { itemId: "milk" });
    f.clock.advance(-6 * 60_000);
    expect(await check(o)).toEqual({ ok: false, reason: "from the future" });
  });

  it("5. accepts an op from a device whose clock is up to 5 minutes ahead", async () => {
    const { f, op, check } = await setup();
    f.clock.advance(4 * 60_000);
    const o = op("bob", { itemId: "milk" });
    f.clock.advance(-4 * 60_000);
    expect(await check(o)).toEqual({ ok: true });
  });

  it("6. refuses someone else's credential, a forged credential, and a non-member", async () => {
    const { f, op, check } = await setup();
    expect(await check(op("mallory", { itemId: "m" }), { membership: "bob" })).toEqual({ ok: false, reason: "credential is for someone else" });
    expect(await check(op("bob", { itemId: "milk" }), { membership: null })).toEqual({ ok: false, reason: "not a member" });
    const forged = structuredClone(f.memberships.carol);
    forged.credentialSubject.role = "admin";
    const o = op("carol", { itemId: "r", text: "Raise rent" });
    const r = await checkOp({ op: o, membership: forged, roster: f.roster(1), directSender: o.issuer, forwarded: false, listDid: f.list.did, model: new ListModel(), policies: f.policies, clock: f.clock });
    expect(r).toEqual({ ok: false, reason: "membership: signature does not verify" });
  });

  it("6. refuses a valid credential the roster doesn't list", async () => {
    const { f, op, check, setRoster } = await setup();
    const { signRoster } = await import("../src/todo/roster");
    setRoster(signRoster(f.list, f.clock, { name: "Maple St House", version: 2, members: [] }));
    expect(await check(op("bob", { itemId: "milk" }))).toEqual({ ok: false, reason: "not a member" });
  });

  it("7. a removed member: only the ops the removal roster kept are valid, however they arrive (review I1)", async () => {
    const { f, op, check, setRoster } = await setup();
    const kept = op("bob", { itemId: "milk" });
    const dropped = op("bob", { itemId: "beer" });
    setRoster(f.roster(2, { bob: { removedAt: f.clock.iso(), keptOps: [kept.id] } }));
    const later = op("bob", { itemId: "eggs" });
    expect(await check(kept)).toEqual({ ok: true });
    expect(await check(kept, { forwarded: true })).toEqual({ ok: true });
    expect(await check(dropped, { forwarded: true })).toEqual({ ok: false, reason: "membership revoked" });
    expect(await check(later)).toEqual({ ok: false, reason: "membership revoked" });
  });

  it("8. applies the role rules from the signed roster", async () => {
    const { op, check } = await setup();
    expect(await check(op("carol", { itemId: "r", text: "Raise rent" }))).toEqual({ ok: false, reason: "viewer may not add" });
  });

  it("holds an op on an item it hasn't seen yet", async () => {
    const { op, check } = await setup();
    expect(await check(op("bob", { kind: "check", itemId: "ghost", text: undefined }))).toEqual({ ok: false, reason: "no such item", holdable: true });
  });

  it("enforces private-item readers from the sealed keys", async () => {
    const { f, model, op, check } = await setup();
    const priv = op("alice", { itemId: "p", text: undefined, sealed: { nonce: "n", ciphertext: "c", keys: [{ to: f.people.alice.did, enc: "e", wrapped: "w" }] }, readers: [f.people.alice.did, f.people.bob.did] });
    model.insert(priv);
    expect(await check(op("bob", { kind: "check", itemId: "p", text: undefined }))).toEqual({ ok: false, reason: "not a reader of this item" });
  });

  it("treats an identical copy as a duplicate and a changed copy as tampered", async () => {
    const { model, op, check } = await setup();
    const o = op("bob", { itemId: "milk" });
    model.insert(o);
    expect(await check(o, { forwarded: true })).toEqual({ ok: true, duplicate: true });
    expect(await check(tamperOp(o, "Beer"), { forwarded: true })).toEqual({ ok: false, reason: "operation: signature does not verify" });
  });
});

describe("review fixes: timestamps (I2)", () => {
  it("refuses an op whose time isn't strict UTC ISO", async () => {
    const { f, check } = await setup();
    const { signDocument } = await import("@zk-toip/trust-core");
    const body = { id: "x1", type: "todo/op", issuer: f.people.bob.did, list: f.list.did, kind: "add", itemId: "z", text: "Z", membershipId: f.memberships.bob.id };
    for (const at of [new Date(f.clock.now()).toUTCString(), "2026-11-05T14:30:00+14:00", "2026-11-05 14:30:00Z"]) {
      const o = signDocument({ ...body, id: `x-${at}`, at }, f.people.bob, f.clock);
      expect(await check(o)).toMatchObject({ ok: false, reason: "malformed operation" });
    }
  });
});
