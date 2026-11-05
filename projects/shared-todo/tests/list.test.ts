import { describe, expect, it } from "vitest";
import { ListState } from "../src/todo/list";
import { signOp } from "../src/todo/ops";
import { fixture } from "./helpers";

describe("ListState", () => {
  it("adds, checks, edits and deletes items, in added order", async () => {
    const f = await fixture();
    const s = new ListState();
    const m = f.memberships;
    const a = signOp(f.people.bob, f.clock, { list: f.list.did, kind: "add", itemId: "milk", text: "Milk", membershipId: m.bob.id });
    f.clock.advance(1000);
    const b = signOp(f.people.bob, f.clock, { list: f.list.did, kind: "add", itemId: "porch", text: "Fix the porch light", membershipId: m.bob.id });
    s.apply(b);
    s.apply(a);
    expect(s.items().map((i) => i.text)).toEqual(["Milk", "Fix the porch light"]);
    s.apply(signOp(f.people.alice, f.clock, { list: f.list.did, kind: "check", itemId: "milk", membershipId: m.alice.id }));
    expect(s.item("milk")?.checked).toBe(true);
    s.apply(signOp(f.people.alice, f.clock, { list: f.list.did, kind: "uncheck", itemId: "milk", membershipId: m.alice.id }));
    expect(s.item("milk")?.checked).toBe(false);
    s.apply(signOp(f.people.bob, f.clock, { list: f.list.did, kind: "edit", itemId: "milk", text: "Oat milk", membershipId: m.bob.id }));
    expect(s.item("milk")?.text).toBe("Oat milk");
    s.apply(signOp(f.people.alice, f.clock, { list: f.list.did, kind: "delete", itemId: "porch", membershipId: m.alice.id }));
    expect(s.has("porch")).toBe(false);
    expect(s.items()).toHaveLength(1);
    expect(s.seen(a.id)).toEqual(a);
  });

  it("applies the same op twice as one", async () => {
    const f = await fixture();
    const s = new ListState();
    const a = signOp(f.people.bob, f.clock, { list: f.list.did, kind: "add", itemId: "milk", text: "Milk", membershipId: f.memberships.bob.id });
    s.apply(a);
    s.apply(a);
    expect(s.items()).toHaveLength(1);
  });

  it("shows a private item it can't read as locked", async () => {
    const f = await fixture();
    const s = new ListState();
    const op = signOp(f.people.alice, f.clock, {
      list: f.list.did, kind: "add", itemId: "p1", sealed: { nonce: "", ciphertext: "", keys: [] }, readers: [f.people.alice.did], membershipId: f.memberships.alice.id,
    });
    s.apply(op);
    expect(s.item("p1")).toMatchObject({ locked: true, readers: [f.people.alice.did], author: f.people.alice.did });
    expect(s.item("p1")?.text).toBeUndefined();
    s.apply(op, "now readable");
    expect(s.item("p1")).toMatchObject({ locked: true });
  });
});
