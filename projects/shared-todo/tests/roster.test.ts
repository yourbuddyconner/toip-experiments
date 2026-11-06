import { describe, expect, it } from "vitest";
import { signDocument } from "@zk-toip/trust-core";
import { acceptRoster } from "../src/todo/roster";
import { fixture } from "./helpers";

describe("acceptRoster (design 4.4)", () => {
  it("accepts a first roster signed by the list", async () => {
    const f = await fixture();
    const r = await acceptRoster(undefined, f.roster(1), f.list.did, f.clock);
    expect(r.ok).toBe(true);
  });

  it("accepts only a newer version", async () => {
    const f = await fixture();
    const v2 = f.roster(2);
    expect(await acceptRoster(v2, f.roster(2), f.list.did, f.clock)).toEqual({ ok: false, reason: "roster is not newer" });
    expect(await acceptRoster(v2, f.roster(1), f.list.did, f.clock)).toEqual({ ok: false, reason: "roster is not newer" });
    expect((await acceptRoster(v2, f.roster(3), f.list.did, f.clock)).ok).toBe(true);
  });

  it("refuses a newer roster that drops a removal", async () => {
    const f = await fixture();
    const held = f.roster(2, { bob: { removedAt: "2026-11-05T14:30:00.000Z" } });
    expect(await acceptRoster(held, f.roster(3), f.list.did, f.clock)).toEqual({ ok: false, reason: "roster drops a removal" });
  });

  it("refuses a roster signed by anyone but the list", async () => {
    const f = await fixture();
    const forged = signDocument({ ...f.roster(5), issuer: f.people.bob.did, proof: undefined }, f.people.bob, f.clock);
    expect(await acceptRoster(undefined, forged, f.list.did, f.clock)).toEqual({ ok: false, reason: "roster: signature does not verify" });
    const edited = { ...f.roster(5) };
    edited.members = edited.members.map((m) => (m.name === "Bob" ? { ...m, role: "admin" as const } : m));
    expect(await acceptRoster(undefined, edited, f.list.did, f.clock)).toEqual({ ok: false, reason: "roster: signature does not verify" });
  });

  it("refuses something that isn't a roster, like a membership credential the list signed", async () => {
    const f = await fixture();
    expect(await acceptRoster(undefined, f.memberships.bob, f.list.did, f.clock)).toEqual({ ok: false, reason: "not a roster" });
    expect(await acceptRoster(undefined, "nope", f.list.did, f.clock)).toEqual({ ok: false, reason: "not a roster" });
  });
});
