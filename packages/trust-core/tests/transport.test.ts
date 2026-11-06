import { describe, expect, it } from "vitest";
import { Bus } from "../src/bus";
import { DemoClock, SystemClock, type Clock } from "../src/clock";
import { identityFromSeed, seedFrom } from "../src/identity";
import { Endpoint, ourSpec, type Traffic } from "../src/tasks";

describe("SystemClock", () => {
  it("reads real time", () => {
    const c: Clock = new SystemClock();
    expect(Math.abs(c.now() - Date.now())).toBeLessThan(1000);
    expect(c.iso()).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(c.date()).toBeInstanceOf(Date);
  });
});

describe("Endpoint over a Transport", () => {
  it("reports traffic in both directions, and the transport's delivery result", async () => {
    const clock = new DemoClock("2026-11-05T14:30:00Z");
    const bus = new Bus(clock);
    const seen: Traffic[] = [];
    const alice = new Endpoint({ identity: identityFromSeed(seedFrom("tr/alice")), transport: bus, clock, onTraffic: (t) => seen.push(t) });
    const bob = new Endpoint({ identity: identityFromSeed(seedFrom("tr/bob")), transport: bus, clock, onTraffic: (t) => seen.push(t) });
    const note = ourSpec("note");
    bob.handle<{ text: string }, void>(note, () => undefined);
    expect(await alice.notify(bob.vid, note, { text: "hi" })).toBe("live");
    await bus.settle();
    expect(seen.map((t) => [t.direction, t.peer])).toEqual([
      ["out", bob.vid],
      ["in", alice.vid],
    ]);
    expect(seen[0].document.payload).toEqual({ text: "hi" });
    expect(seen[0].delivery).toBe("live");
    expect(seen[1].bytes).toBeGreaterThan(100);
    bus.setOnline(bob.vid, false);
    expect(await alice.notify(bob.vid, note, { text: "x" })).toBe("undelivered");
  });
});
