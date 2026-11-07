import { describe, expect, it } from "vitest";
import { CoarseClock, DemoClock } from "../src/clock";
import { Bus } from "../src/bus";
import { Endpoint, ourSpec } from "../src/tasks";
import { identityFromSeed, seedFrom } from "../src/identity";

describe("CoarseClock", () => {
  it("rounds every reading down to the hour by default", () => {
    const inner = new DemoClock("2026-11-06T14:37:21.456Z");
    const c = new CoarseClock(inner);
    expect(c.iso()).toBe("2026-11-06T14:00:00.000Z");
    expect(c.now()).toBe(Date.parse("2026-11-06T14:00:00.000Z"));
    expect(c.date().toISOString()).toBe("2026-11-06T14:00:00.000Z");
    inner.advance(23 * 60_000);
    expect(c.iso()).toBe("2026-11-06T15:00:00.000Z");
  });

  it("takes another granularity and refuses a bad one", () => {
    const c = new CoarseClock(new DemoClock("2026-11-06T14:37:21.456Z"), 60_000);
    expect(c.iso()).toBe("2026-11-06T14:37:00.000Z");
    expect(() => new CoarseClock(new DemoClock("2026-11-06T00:00:00Z"), 0)).toThrow();
  });

  it("makes an Endpoint write coarse issuedAt and proof times that still verify, for a receiver whose window allows the hour", async () => {
    const inner = new DemoClock("2026-11-06T14:37:21.456Z");
    const bus = new Bus(inner);
    const a = new Endpoint({ identity: identityFromSeed(seedFrom("coarse/a")), transport: bus, clock: new CoarseClock(inner) });
    const b = new Endpoint({ identity: identityFromSeed(seedFrom("coarse/b")), transport: bus, clock: inner, freshness: { skewMs: 60_000, maxAgeMs: 2 * 3_600_000, requireIssuedAt: true } });
    const SPEC = ourSpec("test/coarse");
    const got: { issuedAt: string; created: unknown }[] = [];
    b.handle(SPEC, (doc) => {
      got.push({ issuedAt: doc.issuedAt!, created: (doc.proof as { created?: unknown }).created });
    });
    await a.notify(b.vid, SPEC, { hello: 1 });
    await bus.settle();
    expect(got).toEqual([{ issuedAt: "2026-11-06T14:00:00.000Z", created: "2026-11-06T14:00:00Z" }]);
  });
});
