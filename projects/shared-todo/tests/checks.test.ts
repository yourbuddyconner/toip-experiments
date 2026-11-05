import { describe, expect, it } from "vitest";
import { checkOp } from "../src/todo/checks";
import { ListState } from "../src/todo/list";
import { signOp, tamperOp, type OpBody } from "../src/todo/ops";
import { fixture } from "./helpers";

async function setup() {
  const f = await fixture();
  const state = new ListState();
  const add = (who: "alice" | "bob", body: Partial<OpBody> & { itemId: string }) =>
    signOp(f.people[who], f.clock, { list: f.list.did, kind: "add", text: "x", membershipId: f.memberships[who].id, ...body });
  const check = (op: ReturnType<typeof add>, membership = f.memberships.bob, directSender?: string) =>
    checkOp({ op, membership, directSender, listDid: f.list.did, status: f.statusDoc(), state, policies: f.policies, clock: f.clock });
  return { f, state, add, check };
}

describe("checkOp (design 4.5)", () => {
  it("accepts a good op from its author", async () => {
    const { f, add, check } = await setup();
    expect(await check(add("bob", { itemId: "milk" }), f.memberships.bob, f.people.bob.did)).toEqual({ ok: true });
  });

  it("1. rejects a tampered op", async () => {
    const { add, check } = await setup();
    expect(await check(tamperOp(add("bob", { itemId: "milk" }), "Beer"))).toEqual({ ok: false, reason: "operation: signature does not verify" });
  });

  it("2. rejects an op delivered by someone other than its author", async () => {
    const { f, add, check } = await setup();
    expect(await check(add("bob", { itemId: "milk" }), f.memberships.bob, f.people.mallory.did)).toEqual({ ok: false, reason: "not from its author" });
  });

  it("2. accepts a forwarded op without a direct sender", async () => {
    const { add, check } = await setup();
    expect(await check(add("bob", { itemId: "milk" }))).toEqual({ ok: true });
  });

  it("3. rejects without a membership", async () => {
    const { f, state, add } = await setup();
    const r = await checkOp({ op: add("bob", { itemId: "milk" }), membership: undefined, listDid: f.list.did, status: f.statusDoc(), state, policies: f.policies, clock: f.clock });
    expect(r).toEqual({ ok: false, reason: "not a member" });
  });

  it("3. rejects someone else's membership", async () => {
    const { f, check } = await setup();
    const op = signOp(f.people.mallory, f.clock, { list: f.list.did, kind: "add", itemId: "m", text: "Let Mallory in", membershipId: f.memberships.bob.id });
    expect(await check(op, f.memberships.bob, f.people.mallory.did)).toEqual({ ok: false, reason: "credential is for someone else" });
  });

  it("3. rejects a tampered membership", async () => {
    const { f, add, check } = await setup();
    const forged = structuredClone(f.memberships.carol);
    forged.credentialSubject.role = "admin";
    const op = signOp(f.people.carol, f.clock, { list: f.list.did, kind: "add", itemId: "r", text: "Raise rent", membershipId: forged.id });
    expect(await check(op, forged)).toEqual({ ok: false, reason: "membership: signature does not verify" });
    void add;
  });

  it("3. rejects a revoked membership", async () => {
    const { f, add, check } = await setup();
    f.status.revoke(f.memberships.bob.credentialStatus!.statusListIndex);
    expect(await check(add("bob", { itemId: "milk" }))).toEqual({ ok: false, reason: "membership revoked" });
  });

  it("4. rejects an op on an item that doesn't exist", async () => {
    const { f, check } = await setup();
    const op = signOp(f.people.bob, f.clock, { list: f.list.did, kind: "check", itemId: "ghost", membershipId: f.memberships.bob.id });
    expect(await check(op)).toEqual({ ok: false, reason: "no such item" });
  });

  it("5. applies the policy with the member's role", async () => {
    const { f, check } = await setup();
    const op = signOp(f.people.carol, f.clock, { list: f.list.did, kind: "add", itemId: "r", text: "Raise rent", membershipId: f.memberships.carol.id });
    expect(await check(op, f.memberships.carol)).toEqual({ ok: false, reason: "viewer may not add" });
  });

  it("5. enforces private-item readers", async () => {
    const { f, state, check } = await setup();
    const priv = signOp(f.people.alice, f.clock, {
      list: f.list.did, kind: "add", itemId: "p", sealed: { nonce: "", ciphertext: "", keys: [] }, readers: [f.people.alice.did], membershipId: f.memberships.alice.id,
    });
    state.apply(priv);
    const op = signOp(f.people.bob, f.clock, { list: f.list.did, kind: "check", itemId: "p", membershipId: f.memberships.bob.id });
    expect(await check(op)).toEqual({ ok: false, reason: "not a reader of this item" });
  });

  it("treats an identical op it already applied as a no-op success", async () => {
    const { state, add, check } = await setup();
    const op = add("bob", { itemId: "milk" });
    state.apply(op);
    expect(await check(op)).toEqual({ ok: true, duplicate: true });
  });

  it("rejects a known op id with different content for its signature, keeping the original", async () => {
    const { state, add, check } = await setup();
    const op = add("bob", { itemId: "milk", text: "Milk" });
    state.apply(op);
    expect(await check(tamperOp(op, "Beer"))).toEqual({ ok: false, reason: "operation: signature does not verify" });
    expect(state.item("milk")?.text).toBe("Milk");
  });
});
