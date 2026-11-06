import { describe, expect, it } from "vitest";
import { DemoClock } from "../src/clock";
import { identityFromSeed, seedFrom } from "../src/identity";
import { Bus } from "../src/bus";
import { Endpoint, Refusal, TaskError, ourSpec } from "../src/tasks";

const utf8 = (s: string) => new TextEncoder().encode(s);
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function setup(timeoutMs = 3000) {
  const clock = new DemoClock("2026-11-05T14:30:00Z");
  const bus = new Bus(clock);
  const alice = new Endpoint({ identity: identityFromSeed(seedFrom("t/alice")), transport: bus, clock, timeoutMs });
  const bob = new Endpoint({ identity: identityFromSeed(seedFrom("t/bob")), transport: bus, clock, timeoutMs });
  return { clock, bus, alice, bob };
}

const echo = ourSpec("echo");

describe("Endpoint over TSP", () => {
  it("round-trips a signed request and response", async () => {
    const { bus, alice, bob } = setup();
    bob.handle<{ text: string }, { echoed: string }>(echo, (doc) => ({ echoed: doc.payload.text }));
    const res = await alice.request<{ text: string }, { echoed: string }>(bob.vid, echo, { text: "hi" });
    expect(res.payload.echoed).toBe("hi");
    expect(res.issuer).toBe(bob.vid);
    expect(res.type.endsWith("#response")).toBe(true);
    const recs = bus.records();
    expect(recs).toHaveLength(2);
    for (const r of recs) expect(contains(r.raw, utf8("hi"))).toBe(false);
    expect(recs[0].opened?.by).toBe(bob.vid);
    expect(recs[1].opened?.by).toBe(alice.vid);
  });

  it("turns a Refusal into a TaskError", async () => {
    const { alice, bob } = setup();
    bob.handle(echo, () => new Refusal("permissionDenied", "nope"));
    await expect(alice.request(bob.vid, echo, { text: "x" })).rejects.toThrow(/nope/);
  });

  it("rejects a request to an unknown VID as undelivered", async () => {
    const { alice } = setup();
    const err = await alice.request("did:key:z6MkUnknown", echo, {}).catch((e) => e);
    expect(err).toBeInstanceOf(TaskError);
    expect(err.code).toBe("undelivered");
  });

  it("times out when no reply ever comes", async () => {
    const { alice, bob } = setup(50);
    const slow = ourSpec("slow");
    bob.handle(slow, () => new Promise(() => {}));
    const err = await alice.request(bob.vid, slow, {}).catch((e) => e);
    expect(err.code).toBe("timeout");
  });

  it("does not run a handler twice for replayed bytes", async () => {
    const { bus, alice, bob } = setup();
    let calls = 0;
    bob.handle(echo, () => ({ n: ++calls }));
    await alice.request(bob.vid, echo, { text: "once" });
    await bob.ingest(bus.records()[0].raw);
    expect(calls).toBe(1);
  });

  it("sends one-way notifications and reports offline recipients", async () => {
    const { bus, alice, bob } = setup();
    const note = ourSpec("note");
    const got: string[] = [];
    bob.handle<{ text: string }, void>(note, (doc, ctx) => {
      got.push(`${ctx.sender}:${doc.payload.text}`);
    });
    expect(await alice.notify(bob.vid, note, { text: "a" })).toBe("live");
    await bus.settle();
    expect(got).toEqual([`${alice.vid}:a`]);
    expect(bus.records()).toHaveLength(1);
    bus.setOnline(bob.vid, false);
    expect(bus.isOnline(bob.vid)).toBe(false);
    expect(await alice.notify(bob.vid, note, { text: "b" })).toBe("undelivered");
  });

  it("ingests a sealed message delivered some other way", async () => {
    const { bus, alice, bob } = setup();
    const note = ourSpec("note");
    const got: string[] = [];
    bob.handle<{ text: string }, void>(note, (doc) => {
      got.push(doc.payload.text);
    });
    const wire = await alice.seal(bob.vid, note, { text: "later" });
    await bob.ingest(wire);
    expect(got).toEqual(["later"]);
    expect(bus.records()).toHaveLength(0);
  });
});
