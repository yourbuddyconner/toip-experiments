/** The explorer's explanations and per-entry checks. */
import { describe, expect, it } from "vitest";
import { DemoClock, seedFrom } from "@zk-toip/trust-core";
import { coldKeysFromSeed, Controller, exportBundle, MemoryStore, type ProblemCode } from "@zk-toip/eventlog";
import { PROBLEM_TEXT, STATUS_TEXT } from "../src/explain";
import { buildView, diffBodies } from "../src/view";

const ALL: ProblemCode[] = [
  "badVersion", "badFields", "unsupported", "saidMismatch", "badSequence", "badChain", "abandoned", "signatureInvalid", "thresholdNotMet", "nextKeyMismatch", "notWitnessed",
  "duplicity", "unknownKeyState", "staleKeyState", "unsealedRotation", "sealMismatch", "timeReversed", "afterClose", "bodyMismatch", "bindingInvalid", "truncated",
];

describe("explanations", () => {
  it("every problem code and status has a plain sentence", () => {
    for (const c of ALL) expect(PROBLEM_TEXT[c]).toMatch(/^[A-Z].+\.$/);
    for (const s of ["valid", "pending", "cut", "invalid", "rejected"] as const) expect(STATUS_TEXT[s]).toMatch(/\.$/);
  });

  it("diffs two versions field by field", () => {
    expect(diffBodies({ a: 1, k: "x", d: "E1" }, { a: 1, k: "y", d: "E2" })).toEqual([
      { field: "k", a: '"x"', b: '"y"' },
      { field: "d", a: '"E1"', b: '"E2"' },
    ]);
  });
});

describe("the view of a bundle", () => {
  async function scout() {
    const clock = new DemoClock("2026-11-06T18:00:00.000Z");
    const cold = coldKeysFromSeed(seedFrom("v/agent"), "agent");
    const store = new MemoryStore();
    const c = await Controller.incept({ hot: cold.release(0, 1), cold, store, clock });
    const t = await c.openTrail("agent/actions");
    const { entry: m } = await t.append({ kind: "agent/mandate-accepted", body: { id: "m" } });
    await t.append({ kind: "agent/tool-call", body: { tool: "a" }, refs: [t.ref(1)] });
    await t.append({ kind: "agent/tool-call", body: { tool: "b" } });
    await c.checkpointNow();
    return { c, t, store, m };
  }

  it("lists checks per entry, and flags a tool call that doesn't cite the mandate", async () => {
    const { c, store } = await scout();
    const { view } = await buildView(await exportBundle(store, c.aid, { bodies: "all" }), { names: { [c.aid]: "Scout" } });
    expect(view.label).toBe("Scout");
    expect(view.didKeri).toBe(`did:keri:${c.aid}`);
    const [, , cites, uncited] = view.trails[0].entries;
    expect(cites.flags).toEqual([]);
    expect(uncited.flags[0]).toMatch(/doesn't cite the mandate/);
    expect(uncited.checks.map((x) => x.label)).toEqual(["Header hash", "Signature", "Chain", "Key epoch", "Witnesses", "Time", "Anchored", "Body", "Duplicity", "Policy"]);
    expect(uncited.checks.find((x) => x.label === "Body")?.result).toBe("pass");
    expect(uncited.checks.find((x) => x.label === "Anchored")?.detail).toMatch(/KEL at event 1/);
    expect(view.kel[1].notes[0]).toMatch(/^seals trail .* at entry 3$/);
    expect(view.states[0].current).toBe(true);
  });

  it("shows a tampered body as a failed check, with the reason", async () => {
    const { c, store } = await scout();
    const b = await exportBundle(store, c.aid, { bodies: "all" });
    b.trails[0].bodies![1].tool = "rm -rf";
    const { view } = await buildView(b);
    expect(view.ok).toBe(false);
    const e = view.trails[0].entries[2];
    expect(e.body?.ok).toBe(false);
    expect(e.checks.find((x) => x.label === "Body")).toMatchObject({ result: "fail", detail: PROBLEM_TEXT.bodyMismatch });
    expect(view.problems.map((p) => p.code)).toEqual(["bodyMismatch"]);
    expect(view.problems[0].explanation).toBe(PROBLEM_TEXT.bodyMismatch);
  });
});
