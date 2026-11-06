import { describe, expect, it } from "vitest";
import { ListModel } from "../src/todo/model";
import { signOp, type Op } from "../src/todo/ops";
import { fixture } from "./helpers";

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

async function ops() {
  const f = await fixture();
  const m = f.memberships;
  const op = (who: "alice" | "bob", body: Omit<Parameters<typeof signOp>[2], "list" | "membershipId">) => {
    const o = signOp(f.people[who], f.clock, { list: f.list.did, membershipId: m[who].id, ...body });
    f.clock.advance(1000);
    return o;
  };
  const list: Op[] = [
    op("bob", { kind: "add", itemId: "milk", text: "Milk" }),
    op("alice", { kind: "add", itemId: "porch", text: "Fix the porch light" }),
    op("alice", { kind: "check", itemId: "milk" }),
    op("bob", { kind: "uncheck", itemId: "milk" }),
    op("bob", { kind: "edit", itemId: "milk", text: "Oat milk" }),
    op("alice", { kind: "delete", itemId: "porch" }),
  ];
  return { f, list };
}

describe("ListModel (design 4.6)", () => {
  it("converges: every arrival order of the same ops gives the same list", async () => {
    const { list } = await ops();
    const results = new Set<string>();
    for (const order of permutations(list)) {
      const model = new ListModel();
      for (const o of order) model.insert(o);
      results.add(JSON.stringify(model.items()));
    }
    expect(results.size).toBe(1);
    expect(JSON.parse([...results][0])).toMatchObject([{ id: "milk", text: "Oat milk", checked: false }]);
  });

  it("last write wins by time, then author, then id", async () => {
    const { f } = await ops();
    const model = new ListModel();
    const add = signOp(f.people.bob, f.clock, { list: f.list.did, membershipId: "x", kind: "add", itemId: "i", text: "a" });
    const later = new Date(f.clock.now() + 60_000).toISOString();
    const check = { ...signOp(f.people.alice, f.clock, { list: f.list.did, membershipId: "x", kind: "check", itemId: "i" }) };
    f.clock.advance(60_000);
    const uncheck = signOp(f.people.bob, f.clock, { list: f.list.did, membershipId: "x", kind: "uncheck", itemId: "i" });
    model.insert(uncheck);
    model.insert(check);
    model.insert(add);
    expect(uncheck.at).toBe(later);
    expect(model.item("i")?.checked).toBe(false);
  });

  it("keeps a deleted item deleted", async () => {
    const { f } = await ops();
    const model = new ListModel();
    model.insert(signOp(f.people.bob, f.clock, { list: f.list.did, membershipId: "x", kind: "add", itemId: "i", text: "a" }));
    model.insert(signOp(f.people.bob, f.clock, { list: f.list.did, membershipId: "x", kind: "delete", itemId: "i" }));
    f.clock.advance(1000);
    model.insert(signOp(f.people.bob, f.clock, { list: f.list.did, membershipId: "x", kind: "edit", itemId: "i", text: "back?" }));
    expect(model.has("i")).toBe(false);
    expect(model.items()).toEqual([]);
  });

  it("identifies ops by author and id: an identical copy is a duplicate, different content a conflict", async () => {
    const { list } = await ops();
    const model = new ListModel();
    expect(model.insert(list[0])).toBe("new");
    const reordered = Object.fromEntries(Object.entries(list[0]).reverse()) as Op;
    expect(model.insert(reordered)).toBe("duplicate");
    expect(model.insert({ ...list[0], text: "Beer" })).toBe("conflict");
    expect(model.item("milk")?.text).toBe("Milk");
  });

  it("shows readable private text, and readers from the sealed keys", async () => {
    const { f } = await ops();
    const model = new ListModel();
    const op = signOp(f.people.alice, f.clock, {
      list: f.list.did,
      membershipId: "x",
      kind: "add",
      itemId: "p",
      sealed: { nonce: "n", ciphertext: "c", keys: [{ to: f.people.alice.did, enc: "e", wrapped: "w" }] },
      readers: [f.people.alice.did, f.people.bob.did],
    });
    model.insert(op);
    expect(model.item("p")).toMatchObject({ locked: true, private: true, readers: [f.people.alice.did] });
    const model2 = new ListModel();
    model2.insert(op, "Carol's birthday present");
    expect(model2.item("p")).toMatchObject({ locked: false, text: "Carol's birthday present" });
  });
});

describe("review fixes: ordering compares times as numbers (I2)", () => {
  it("orders a millisecond-precision time and a whole-second time by value", async () => {
    const { f } = await ops();
    const model = new ListModel();
    model.insert(signOp(f.people.bob, f.clock, { list: f.list.did, membershipId: "x", kind: "add", itemId: "i", text: "a" }));
    const base = f.clock.now() + 5000;
    const e1 = { ...signOp(f.people.alice, f.clock, { list: f.list.did, membershipId: "x", kind: "edit", itemId: "i", text: "later" }), at: new Date(base + 500).toISOString() };
    const e2 = { ...signOp(f.people.bob, f.clock, { list: f.list.did, membershipId: "x", kind: "edit", itemId: "i", text: "earlier" }), at: new Date(base).toISOString().replace(".000Z", "Z") };
    model.insert(e1);
    model.insert(e2);
    expect(model.item("i")?.text).toBe("later");
  });
});
