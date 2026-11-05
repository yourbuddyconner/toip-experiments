import { expect, it } from "vitest";
import { World } from "../src/todo/world";
import { STEPS } from "../src/todo/scenario";
import { policyWasm } from "./helpers";

const bytes = (s: string) => new TextEncoder().encode(s);
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

it("never puts item text on the wire, at the relay, or in front of a non-reader (design 6)", async () => {
  const w = await World.create({ policyWasm: policyWasm() });
  let relaySawSomething = false;
  for (const s of STEPS) {
    await w.runStep(s.n);
    relaySawSomething ||= w.relay.held().length > 0;
    for (const t of ["Milk", "birthday present", "Raise rent", "porch light"]) {
      expect(JSON.stringify(w.relay.state())).not.toContain(t);
    }
  }
  expect(relaySawSomething).toBe(true);
  expect(w.bus.records().length).toBeGreaterThan(20);
  for (const r of w.bus.records()) {
    for (const t of ["Milk", "birthday present", "Raise rent", "porch light", "editor", "viewer"]) {
      expect(contains(r.raw, bytes(t))).toBe(false);
    }
  }
  expect(JSON.stringify(w.people.carol.snapshot())).not.toContain("birthday present");
  expect(JSON.stringify(w.people.mallory.snapshot())).not.toContain("Milk");
});
