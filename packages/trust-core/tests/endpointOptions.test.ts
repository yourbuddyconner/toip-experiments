import { describe, expect, it } from "vitest";
import { unpack } from "@openvtc/vti-tsp-js";
import { Bus } from "../src/bus";
import { DemoClock } from "../src/clock";
import { identityFromSeed, resolveDidKey, seedFrom, type Identity } from "../src/identity";
import { CTT1_FORMAT, ctt1 } from "../src/compact";
import { PersistentReplayGuard, memoryReplayStore } from "../src/replayGuard";
import { Endpoint, ourSpec } from "../src/tasks";

const echo = ourSpec("echo");

async function bodyOf(wire: Uint8Array, to: Identity): Promise<Uint8Array> {
  const sender = new TextDecoder().decode(wire).match(/did:key:z[1-9A-HJ-NP-Za-km-z]+/)![0];
  const keys = resolveDidKey(sender);
  const m = await unpack(wire, { receiverDecryptionKey: to.encryptionSecret, senderEncryptionKey: keys.encryptionKey, senderSigningKey: keys.signingKey });
  return m.payload;
}

function world() {
  const clock = new DemoClock("2026-11-05T14:30:00Z");
  const bus = new Bus(clock);
  const a = identityFromSeed(seedFrom("eo/alice"));
  const b = identityFromSeed(seedFrom("eo/bob"));
  return { clock, bus, a, b };
}

describe("Endpoint body codecs", () => {
  it("sends CTT1 to a peer that reads it, and a plain endpoint opens it and answers in JSON", async () => {
    const { clock, bus, a, b } = world();
    const alice = new Endpoint({ identity: a, transport: bus, clock, bodyCodecFor: () => ctt1 });
    const bob = new Endpoint({ identity: b, transport: bus, clock });
    bob.handle<{ text: string }, { echoed: string }>(echo, (doc) => ({ echoed: doc.payload.text }));
    const res = await alice.request<{ text: string }, { echoed: string }>(bob.vid, echo, { text: "hi" });
    expect(res.payload.echoed).toBe("hi");
    const [req, reply] = bus.records();
    expect((await bodyOf(req.raw, b))[0]).toBe(CTT1_FORMAT);
    expect((await bodyOf(reply.raw, a))[0]).toBe(0x7b);
  });

  it("answers in CTT1 when its own bodyCodecFor says so, and the compact wire is smaller", async () => {
    const { clock, bus, a, b } = world();
    const alice = new Endpoint({ identity: a, transport: bus, clock, bodyCodecFor: () => ctt1 });
    const bob = new Endpoint({ identity: b, transport: bus, clock, bodyCodecFor: (to) => (to === a.did ? ctt1 : undefined) });
    bob.handle<{ text: string }, { echoed: string }>(echo, (doc) => ({ echoed: doc.payload.text }));
    await alice.request(bob.vid, echo, { text: "hi" });
    const reply = bus.records()[1];
    expect((await bodyOf(reply.raw, a))[0]).toBe(CTT1_FORMAT);

    const plain = new Endpoint({ identity: identityFromSeed(seedFrom("eo/carol")), transport: bus, clock });
    await plain.request(bob.vid, echo, { text: "hi" });
    expect(bus.records()[2].bytes).toBeGreaterThan(bus.records()[0].bytes + 300);
  });

  it("refuses an unknown spec with an error sealed in the peer's codec", async () => {
    const { clock, bus, a, b } = world();
    const alice = new Endpoint({ identity: a, transport: bus, clock, bodyCodecFor: () => ctt1 });
    new Endpoint({ identity: b, transport: bus, clock, bodyCodecFor: () => ctt1 });
    await expect(alice.request(b.did, ourSpec("nobody"), {})).rejects.toMatchObject({ code: "unsupportedType" });
    expect((await bodyOf(bus.records()[1].raw, a))[0]).toBe(CTT1_FORMAT);
  });

  it("falls back to JSON for a document CTT1 can't carry exactly", async () => {
    const { clock, bus, a, b } = world();
    const alice = new Endpoint({ identity: a, transport: bus, clock, bodyCodecFor: () => ctt1 });
    const bob = new Endpoint({ identity: b, transport: bus, clock });
    bob.handle<{ text: string }, { echoed: string }>(echo, (doc) => ({ echoed: doc.payload.text }));
    const res = await alice.request<{ text: string }, { echoed: string }>(bob.vid, echo, { text: "lone \ud800" });
    expect(res.payload.echoed).toBe("lone \ud800");
    expect((await bodyOf(bus.records()[0].raw, b))[0]).toBe(0x7b);
  });
});

describe("Endpoint.request timeouts", () => {
  it("takes a per-call timeout over the endpoint's default", async () => {
    const { clock, bus, a, b } = world();
    const alice = new Endpoint({ identity: a, transport: bus, clock, timeoutMs: 60_000 });
    const bob = new Endpoint({ identity: b, transport: bus, clock });
    const slow = ourSpec("slow");
    bob.handle(slow, () => new Promise(() => {}));
    const started = Date.now();
    const err = await alice.request(bob.vid, slow, {}, { timeoutMs: 40 }).catch((e) => e);
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("a persistent replay guard", () => {
  it("still refuses to run a handler twice after the endpoint restarts", async () => {
    const { clock, bus, a, b } = world();
    const store = memoryReplayStore();
    const alice = new Endpoint({ identity: a, transport: bus, clock });
    let calls = 0;
    const start = () => {
      const bob = new Endpoint({ identity: b, transport: bus, clock, replayGuard: new PersistentReplayGuard(store) });
      bob.handle(echo, () => ({ n: ++calls }));
      return bob;
    };
    const bob1 = start();
    const res = await alice.request<unknown, { n: number }>(b.did, echo, { text: "once" });
    expect(res.payload.n).toBe(1);
    const wire = bus.records()[0].raw;
    bob1.close();

    const bob2 = start();
    await bob2.ingest(wire);
    await bus.settle();
    expect(calls).toBe(1);
    // The duplicate is answered with the response the first run produced.
    const again = bus.records().at(-1)!;
    expect(again.to).toBe(a.did);
    expect(again.opened?.document.payload).toEqual({ n: 1 });
  });

  it("forgets records whose retention has passed, and caps its size", async () => {
    const store = memoryReplayStore();
    const g = new PersistentReplayGuard(store, { capacity: 2 });
    expect((await g.claim("a", "d1", 1000, 0)).kind).toBe("fresh");
    expect((await g.claim("a", "d1", 1000, 10)).kind).toBe("duplicate");
    expect((await g.claim("a", "d2", 1000, 10)).kind).toBe("conflict");
    expect((await g.claim("a", "d2", 1000, 2000)).kind).toBe("fresh");
    await g.claim("b", "d", undefined, 0);
    await g.claim("c", "d", undefined, 0);
    expect(store.records.map((r) => r.id)).toEqual(["b", "c"]);
    const reloaded = new PersistentReplayGuard(store);
    expect((await reloaded.claim("c", "d", undefined, 0)).kind).toBe("duplicate");
    await reloaded.release("c", "d");
    expect((await reloaded.claim("c", "d", undefined, 0)).kind).toBe("fresh");
  });
});
