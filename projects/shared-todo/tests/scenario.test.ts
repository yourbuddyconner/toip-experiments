import { describe, expect, it } from "vitest";
import { World } from "../src/todo/world";
import { STEPS } from "../src/todo/scenario";
import type { MemberAgent } from "../src/todo/member";
import { policyWasm } from "./helpers";

const view = (m: MemberAgent) => m.state.items().map((i) => (i.locked ? "🔒" : i.text) + (i.checked ? " ✓" : ""));
const lastReason = (m: MemberAgent) => m.rejected.at(-1)?.reason;

describe("scripted scenario (design 3)", () => {
  it("has twelve steps with titles and captions", () => {
    expect(STEPS.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const s of STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.caption.length).toBeGreaterThan(0);
    }
  });

  it("runs end to end with the outcomes the design describes", async () => {
    const w = await World.create({ policyWasm: policyWasm() });
    const { alice, bob, carol, mallory } = w.people;

    await w.runStep(1);
    expect(new Set([alice.did, bob.did, carol.did, mallory.did, w.relay.did]).size).toBe(5);

    await w.runStep(2);
    expect(alice.list?.name).toBe("Maple St House");
    expect(alice.role).toBe("admin");

    await w.runStep(3);
    expect(bob.role).toBe("editor");
    expect(alice.members.get(bob.did)?.acknowledged).toBe(true);

    await w.runStep(4);
    expect(carol.role).toBe("viewer");

    await w.runStep(5);
    for (const m of [alice, bob, carol]) expect(view(m)).toEqual(["Milk", "Fix the porch light"]);

    await w.runStep(6);
    expect(view(alice)).toEqual(["Milk", "Fix the porch light", "Carol's birthday present"]);
    expect(view(bob)).toEqual(["Milk", "Fix the porch light", "Carol's birthday present"]);
    expect(view(carol)).toEqual(["Milk", "Fix the porch light", "🔒"]);
    expect(carol.rejected).toHaveLength(0);

    await w.runStep(7);
    expect(lastReason(alice)).toBe("viewer may not add");
    expect(lastReason(bob)).toBe("viewer may not add");
    for (const m of [alice, bob, carol]) expect(view(m)).not.toContain("Raise rent");

    await w.runStep(8);
    for (const m of [alice, bob, carol]) expect(lastReason(m)).toBe("credential is for someone else");

    await w.runStep(9);
    expect(bob.online).toBe(false);
    expect(view(alice)[0]).toBe("Milk ✓");
    expect(view(bob)[0]).toBe("Milk");
    expect(w.relay.held()).toHaveLength(1);

    await w.runStep(10);
    expect(bob.online).toBe(true);
    expect(view(bob)[0]).toBe("Milk ✓");
    expect(w.relay.held()).toHaveLength(0);

    await w.runStep(11);
    expect(lastReason(alice)).toBe("membership revoked");
    expect(lastReason(carol)).toBe("membership revoked");
    expect(view(carol)).toEqual(["Milk ✓", "Fix the porch light", "🔒"]);
    expect(view(bob).length).toBeGreaterThanOrEqual(3);

    await w.runStep(12);
    expect(lastReason(carol)).toBe("operation: signature does not verify");
    expect(view(carol)).toEqual(["Milk ✓", "Fix the porch light", "🔒"]);
    expect(w.stepIndex).toBe(12);
  });

  it("refuses a second step while one runs, and steps out of order", async () => {
    const w = await World.create({ policyWasm: policyWasm() });
    await expect(w.runStep(2)).rejects.toThrow("out of order");
    const first = w.runStep(1);
    await expect(w.runStep(2)).rejects.toThrow("busy");
    await first;
    expect(w.stepIndex).toBe(1);
  });

  it("rebuilds with the same identities", async () => {
    const a = await World.create({ policyWasm: policyWasm() });
    const b = await World.create({ policyWasm: policyWasm() });
    for (const k of ["alice", "bob", "carol", "mallory"] as const) expect(a.people[k].did).toBe(b.people[k].did);
    expect(a.relay.did).toBe(b.relay.did);
  });
});
