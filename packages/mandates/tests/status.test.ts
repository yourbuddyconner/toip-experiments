import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { StatusRegistry, delegate, httpStatusResolver, staticStatusResolver, type Mandate, type StatusResolver } from "../src/index";
import type { StatusListDoc } from "@toip-tools/trust-core";
import { codes, engine, inDays, payAction, people, rootMandate, twoLinks, world, zeroSpent, type World } from "./helpers";

async function decide(w: World, chain: Mandate[], status: StatusResolver, maxStatusAgeSeconds?: number) {
  const leaf = chain[chain.length - 1];
  return (await engine()).decide({
    chain,
    presenter: leaf.credentialSubject.id,
    action: payAction(w, leaf.credentialSubject.id),
    state: zeroSpent(leaf),
    status,
    clock: w.clock,
    ...(maxStatusAgeSeconds ? { requirements: { maxStatusAgeSeconds } } : {}),
  });
}

async function threeLinks(w: World): Promise<Mandate[]> {
  const root = rootMandate(w, { delegation: { maxDepth: 2 } });
  const a = await delegate([root], people.ops, w.clock, { subject: people.errands.did, validUntil: inDays(w.clock, 3), status: w.opsStatus.allocate(), tighten: {}, revocation: { maxAgeSeconds: 600 } });
  if (!("mandate" in a)) throw new Error("a");
  const b = await delegate([root, a.mandate], people.errands, w.clock, { subject: people.dana.did, validUntil: inDays(w.clock, 2), status: w.errandsStatus.allocate(), tighten: {} });
  if (!("mandate" in b)) throw new Error(JSON.stringify(b.problems));
  return [root, a.mandate, b.mandate];
}

describe("revocation and status lists (§8.2 step 7)", () => {
  it("StatusRegistry allocates entries, revokes, signs, saves and restores", () => {
    const w = world();
    const reg = new StatusRegistry(people.conner, w.clock);
    const e0 = reg.allocate();
    const e1 = reg.allocate();
    expect(e0).toEqual({ type: "BitstringStatusListEntry", statusListIndex: 0, statusListCredential: `${people.conner.did}#status` });
    expect(e1.statusListIndex).toBe(1);
    reg.revoke(e1);
    expect(reg.isRevoked(e1)).toBe(true);
    expect(reg.isRevoked(e0)).toBe(false);
    const doc = reg.sign();
    expect(doc.issuer).toBe(people.conner.did);
    expect(doc.id).toBe(`${people.conner.did}#status`);
    const again = new StatusRegistry(people.conner, w.clock, JSON.parse(JSON.stringify(reg.save())));
    expect(again.allocate().statusListIndex).toBe(2);
    expect(again.isRevoked(e1)).toBe(true);
    expect(() => reg.revoke({ ...e0, statusListCredential: "did:key:other#status" })).toThrow(/list/);
  });

  it("a revoked leaf is denied: status.revoked", async () => {
    const w = world();
    const chain = await twoLinks(w);
    w.opsStatus.revoke(chain[1].credentialStatus);
    const d = await decide(w, chain, w.status());
    expect(d.outcome).toBe("deny");
    expect(d.reasons.filter((r) => r.code === "status.revoked").map((r) => r.link)).toEqual([1]);
  });

  it("a revoked root denies a three-link chain", async () => {
    const w = world();
    const chain = await threeLinks(w);
    expect((await decide(w, chain, w.status())).outcome).toBe("allow");
    w.connerStatus.revoke(chain[0].credentialStatus);
    const d = await decide(w, chain, w.status());
    expect(d.outcome).toBe("deny");
    expect(d.reasons.map((r) => [r.code, r.link])).toEqual([["status.revoked", 0]]);
  });

  it("a list older than the smallest maxAgeSeconds from that link down is stale", async () => {
    const w = world();
    const chain = await threeLinks(w);
    const lists = [w.connerStatus.sign(), w.opsStatus.sign(), w.errandsStatus.sign()];
    // The root allows 3600 seconds, but link 1 (and so link 2) says 600, which binds every list above it too.
    w.clock.advance(599_000);
    expect((await decide(w, chain, staticStatusResolver(lists))).outcome).toBe("allow");
    w.clock.advance(2_000);
    const d = await decide(w, chain, staticStatusResolver(lists));
    expect(d.outcome).toBe("deny");
    expect(d.reasons.map((r) => [r.code, r.link])).toEqual([
      ["status.stale", 0],
      ["status.stale", 1],
      ["status.stale", 2],
    ]);
  });

  it("the verifier's own limit applies too", async () => {
    const w = world();
    const chain = await twoLinks(w);
    const lists = staticStatusResolver([w.connerStatus.sign(), w.opsStatus.sign()]);
    w.clock.advance(120_000);
    expect((await decide(w, chain, lists)).outcome).toBe("allow");
    expect(codes(await decide(w, chain, lists, 60))).toEqual(["status.stale"]);
  });

  it("a list signed by someone else: status.wrongIssuer", async () => {
    const w = world();
    const chain = await twoLinks(w);
    const mallorys = new StatusRegistry(people.mallory, w.clock).sign();
    const fake: StatusListDoc = { ...mallorys, id: `${people.ops.did}#status` };
    const resolver = { get: async (id: string) => (id === fake.id ? fake : w.connerStatus.sign()) };
    expect(codes(await decide(w, chain, resolver))).toEqual(["status.wrongIssuer"]);
    // A list claiming the right issuer but with someone else's signature.
    const forged: StatusListDoc = { ...mallorys, id: `${people.ops.did}#status`, issuer: people.ops.did };
    const resolver2 = { get: async (id: string) => (id === forged.id ? forged : w.connerStatus.sign()) };
    expect(codes(await decide(w, chain, resolver2))).toEqual(["status.wrongIssuer"]);
  });

  it("no list: status.unavailable", async () => {
    const w = world();
    const chain = await twoLinks(w);
    const d = await decide(w, chain, staticStatusResolver([w.connerStatus.sign()]));
    expect(d.outcome).toBe("deny");
    expect(d.reasons.map((r) => [r.code, r.link])).toEqual([["status.unavailable", 1]]);
    const throwing = { get: async () => Promise.reject(new Error("network down")) };
    expect(codes(await decide(w, chain, throwing))).toEqual(["status.unavailable"]);
  });
});

describe("httpStatusResolver", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("fetches lists over HTTP, caches them, and returns null for anything wrong", async () => {
    const w = world();
    let hits = 0;
    let doc = w.connerStatus.sign();
    server = createServer((req, res) => {
      hits++;
      const did = decodeURIComponent(req.url!.replace("/api/status/", ""));
      if (did === people.conner.did) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(doc));
      } else if (did === people.ops.did) {
        res.end("not json");
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/status`;
    const resolver = httpStatusResolver(base, { cacheSeconds: 30 });
    expect(await resolver.get(`${people.conner.did}#status`)).toEqual(doc);
    expect(await resolver.get(`${people.ops.did}#status`)).toBeNull();
    expect(await resolver.get(`${people.dana.did}#status`)).toBeNull();
    expect(await resolver.get(`${people.conner.did}#other`)).toBeNull();
    const before = hits;
    expect(await resolver.get(`${people.conner.did}#status`)).toEqual(doc);
    expect(hits).toBe(before);

    const fresh = httpStatusResolver(base);
    w.connerStatus.revoke({ type: "BitstringStatusListEntry", statusListIndex: 5, statusListCredential: `${people.conner.did}#status` });
    doc = w.connerStatus.sign();
    expect(await fresh.get(`${people.conner.did}#status`)).toEqual(doc);

    const chain = [rootMandate(w)];
    const d = await decide(w, chain, httpStatusResolver(base));
    expect(d.outcome).toBe("allow");
    const unreachable = httpStatusResolver("http://127.0.0.1:1/api/status");
    expect(await unreachable.get(`${people.conner.did}#status`)).toBeNull();
  });
});
