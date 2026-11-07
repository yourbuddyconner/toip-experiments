// The one-process platform over HTTP, on free ports: Acme's log and snapshots, publication and the
// dev clock, the outlet's descriptors and mirror, the relay panel, Acme's search, and the headers
// that keep each app isolated.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CIRCUIT_ID, checkRootLog, epochOf, snapshotMatches, type GroupRoot } from "@zk-toip/anon-membership";
import { Endpoint, RelayTransport, SystemClock, identityFromSeed, seedFrom } from "@zk-toip/trust-core";
import { startPlatform, WEB_DIR, type Platform } from "../src/platform/platform";
import { signDescriptor, DEFAULT_LIMITS } from "../src/protocol/descriptor";
import { enrollWallet } from "../src/agents/wallet";
import { FRESHNESS } from "../src/protocol/messages";

const built = existsSync(join(WEB_DIR, "dist", "source.html"));
let p: Platform;
const transports: RelayTransport[] = [];

beforeAll(async () => {
  p = await startPlatform({ ports: { outlet: 0, inbox: 0, acme: 0, wallet: 0, relay: 0 }, web: built ? "static" : "none", seed: 10, mirrorRefreshMs: 200 });
}, 30_000);
afterAll(async () => {
  for (const t of transports) t.stop();
  await p?.close();
});

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the platform", () => {
  it("listens on localhost, one origin per app", () => {
    const hosts = [p.urls.outlet, p.urls.inbox, p.urls.acme, p.urls.wallet].map((u) => new URL(u));
    expect(new Set(hosts.map((h) => h.port)).size).toBe(4);
    for (const h of hosts) expect(h.hostname).toBe("localhost");
  });

  it("serves Acme's log publicly, publishes on request, and refuses a second root the same day", async () => {
    const r0 = await get(`${p.urls.acme}/groups/employees/log.json`);
    expect(r0.headers.get("access-control-allow-origin")).toBe("*");
    expect(await r0.json()).toEqual([]);
    expect((await post(`${p.urls.acme}/api/acme/publish`, {})).status).toBe(200);
    expect((await post(`${p.urls.acme}/api/acme/publish`, {})).status).toBe(409);
    const log = (await (await get(`${p.urls.acme}/groups/employees/log.json`)).json()) as GroupRoot[];
    expect(log).toHaveLength(1);
    expect(await checkRootLog(log, p.acme.identity.did, new SystemClock())).toMatchObject({ ok: true });
    const snap = new Uint8Array(await (await get(`${p.urls.acme}/groups/employees/snapshot/${log[0].epoch}.bin`)).arrayBuffer());
    expect(snapshotMatches(log[0], snap)).toBe(true);
  });

  it("refuses cross-site POSTs to Acme's console", async () => {
    const r = await post(`${p.urls.acme}/api/acme/publish`, {}, { origin: "http://evil.example" });
    expect(r.status).toBe(403);
  });

  it("enrolls a roster member over the relay, and the relay panel shows what the relay saw", async () => {
    const seed = seedFrom("platform-test/wallet");
    const identity = identityFromSeed(seedFrom("platform-test/employee"));
    expect((await post(`${p.urls.acme}/api/acme/employees`, { name: "Dana Lee", did: identity.did })).status).toBe(200);
    const t = new RelayTransport({ url: p.urls.relay, identity });
    transports.push(t);
    t.start();
    const ep = new Endpoint({ identity, transport: t, clock: p.clock, timeoutMs: 10_000, freshness: FRESHNESS });
    const e = await enrollWallet(ep, p.acme.identity.did, p.acme.groupId, seed);
    expect(e.index).toBe(10);
    const relay = (await (await get(`${p.urls.acme}/api/relay`)).json()) as { messages: { from: string; fromName: string; toName: string }[] };
    expect(relay.messages.some((m) => m.from === identity.did && m.fromName === "Dana Lee" && m.toName === "Acme Chemicals")).toBe(true);
    const found = (await (await post(`${p.urls.acme}/api/acme/search`, { q: identity.did })).json()) as { places: { where: string; found: boolean }[] };
    expect(found.places.find((x) => x.where.startsWith("HR roster"))!.found).toBe(true);
  });

  it("moves the dev clock a day and publishes that day's root", async () => {
    const before = p.clock.now();
    const r = await post(`${p.urls.acme}/api/clock/advance`, { days: 1 });
    expect(r.status).toBe(200);
    expect(p.clock.now() - before).toBeGreaterThanOrEqual(86_400_000);
    expect(p.acme.log().at(-1)!.epoch).toBe(epochOf(p.clock.now()));
    const { now } = (await (await get(`${p.urls.outlet}/api/clock`)).json()) as { now: number };
    expect(Math.abs(now - p.clock.now())).toBeLessThan(5000);
  });

  it("mirrors Acme's log at the outlet", async () => {
    await p.mirror.refresh();
    const mirrored = (await (await get(`${p.urls.outlet}/dropbox/any/mirror/acme-employees/log.json`)).json()) as GroupRoot[];
    expect(mirrored).toEqual(p.acme.log());
    const head = mirrored.at(-1)!;
    const snap = new Uint8Array(await (await get(`${p.urls.outlet}/dropbox/any/mirror/acme-employees/snapshot/${head.epoch}.bin`)).arrayBuffer());
    expect(snapshotMatches(head, snap)).toBe(true);
  });

  it("takes a signed descriptor from another origin, and refuses forgeries and a slug taken by another drop box", async () => {
    const sam = identityFromSeed(seedFrom("platform-test/sam"));
    const d = signDescriptor(
      { slug: "ledger-sam", outlet: "The Ledger", journalist: { name: "Sam Ortiz" }, relay: p.urls.relay, circuits: [{ id: CIRCUIT_ID, vkHash: "00" }], stories: [], limits: DEFAULT_LIMITS },
      sam,
      p.clock,
    );
    const pre = await fetch(`${p.urls.outlet}/dropbox/ledger-sam/descriptor`, { method: "OPTIONS", headers: { origin: p.urls.inbox, "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("content-type");
    const ok = await post(`${p.urls.outlet}/dropbox/ledger-sam/descriptor`, { descriptor: d }, { origin: p.urls.inbox });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(await (await get(`${p.urls.outlet}/dropbox/ledger-sam/descriptor.json`)).json()).toEqual(d);
    expect((await post(`${p.urls.outlet}/dropbox/ledger-sam/descriptor`, { descriptor: { ...d, outlet: "Forged" } })).status).toBe(400);
    const other = signDescriptor({ ...d, journalist: { name: "Someone else" } }, identityFromSeed(seedFrom("platform-test/other")), p.clock);
    expect((await post(`${p.urls.outlet}/dropbox/ledger-sam/descriptor`, { descriptor: other })).status).toBe(409);
    const list = (await (await get(`${p.urls.outlet}/api/dropboxes`)).json()) as { slug: string }[];
    expect(list.map((x) => x.slug)).toEqual(["ledger-sam"]);
  });

  it.runIf(built)("serves each page cross-origin isolated, and the source app under a strict Content-Security-Policy", async () => {
    for (const u of [p.urls.outlet + "/tip/ledger-sam", p.urls.inbox, p.urls.acme, p.urls.wallet]) {
      const r = await get(u);
      expect(r.status).toBe(200);
      expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(r.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    }
    const csp = (await get(p.urls.outlet + "/tip/ledger-sam")).headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(new RegExp(`connect-src 'self' data: ${p.urls.relay.replace(/[/.]/g, "\\$&")} ${p.urls.acme.replace(/[/.]/g, "\\$&")}`));
    expect(csp).not.toMatch(/aztec/);
    expect((await get(p.urls.inbox)).headers.get("content-security-policy")).toBeNull();
  });
});
