import { describe, expect, it } from "vitest";
import { sealItem } from "@toip-tools/trust-core";
import { readableText, signOp, tamperOp, verifyOp } from "../src/todo/ops";
import { fixture } from "./helpers";

describe("operations", () => {
  it("are signed by their author and verify", async () => {
    const f = await fixture();
    const op = signOp(f.people.bob, f.clock, { list: f.list.did, kind: "add", itemId: "i1", text: "Milk", membershipId: f.memberships.bob.id });
    expect(op.issuer).toBe(f.people.bob.did);
    expect(op.type).toBe("todo/op");
    expect(op.at).toBe("2026-11-05T14:30:00.000Z");
    expect(await verifyOp(op, f.clock)).toBe(true);
  });

  it("fail to verify once tampered", async () => {
    const f = await fixture();
    const op = signOp(f.people.alice, f.clock, { list: f.list.did, kind: "add", itemId: "i1", text: "Fix the porch light", membershipId: f.memberships.alice.id });
    const bad = tamperOp(op, "Give Bob his deposit back");
    expect(bad.text).toBe("Give Bob his deposit back");
    expect(await verifyOp(bad, f.clock)).toBe(false);
  });

  it("reads private text only as a reader, and a corrupted key reads as nothing", async () => {
    const f = await fixture();
    const r = (id: typeof f.people.alice) => ({ did: id.did, encryptionPublic: id.encryptionPublic });
    const { sealed } = await sealItem("Carol's birthday present", [r(f.people.alice), r(f.people.bob)]);
    const op = signOp(f.people.alice, f.clock, {
      list: f.list.did, kind: "add", itemId: "p1", sealed, readers: [f.people.alice.did, f.people.bob.did], membershipId: f.memberships.alice.id,
    });
    expect(JSON.stringify(op)).not.toContain("birthday");
    expect(await readableText(op, f.people.bob)).toBe("Carol's birthday present");
    expect(await readableText(op, f.people.carol)).toBeUndefined();
    const corrupted = { ...op, sealed: { ...sealed, keys: sealed.keys.map((k) => ({ ...k, wrapped: "AAAA" + k.wrapped.slice(4) })) } };
    expect(await readableText(corrupted, f.people.bob)).toBeUndefined();
  });
});
