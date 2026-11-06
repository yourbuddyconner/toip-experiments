import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { RelayTransport, fromB64u, identityFromSeed, seedFrom, toB64u, utf8, type Identity } from "@zk-toip/trust-core";
import { startRelay, type Relay } from "../src/server";

const relays: Relay[] = [];
const transports: RelayTransport[] = [];
afterEach(async () => {
  for (const t of transports.splice(0)) t.stop();
  for (const r of relays.splice(0)) await r.close();
});

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "relay-")), "relay.db");
async function relay(dbPath = tmpDb(), port = 0) {
  const r = await startRelay({ port, dbPath });
  relays.push(r);
  return r;
}
const id = (n: string) => identityFromSeed(seedFrom(`relay-test/${n}`));

/** A raw protocol client, for testing the server without RelayTransport. */
function raw(url: string) {
  const ws = new WebSocket(url);
  const inbox: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  };
  const next = () => new Promise<any>((res) => (inbox.length ? res(inbox.shift()) : waiters.push(res)));
  const opened = new Promise<void>((res) => (ws.onopen = () => res()));
  const closed = new Promise<void>((res) => (ws.onclose = () => res()));
  return { ws, next, opened, closed, send: (m: object) => ws.send(JSON.stringify(m)) };
}
const sign = (who: Identity, nonce: string, url: string) => toB64u(ed25519.sign(utf8(`toip-relay-auth/v1|${nonce}|${url}`), who.signingSecret));

function client(url: string, who: Identity, got: Uint8Array[] = []) {
  const t = new RelayTransport({ url, identity: who });
  t.attach(who.did, async (w) => {
    got.push(w);
  });
  t.start();
  transports.push(t);
  return { t, got };
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("relay authentication", () => {
  it("accepts a correct DID signature over its challenge and URL", async () => {
    const r = await relay();
    const c = raw(r.url);
    await c.opened;
    const ch = await c.next();
    expect(ch.t).toBe("challenge");
    const alice = id("alice");
    c.send({ t: "auth", did: alice.did, sig: sign(alice, ch.nonce, r.url) });
    expect((await c.next()).t).toBe("ready");
    c.ws.close();
  });

  it("refuses a signature by a different key", async () => {
    const r = await relay();
    const c = raw(r.url);
    await c.opened;
    const ch = await c.next();
    c.send({ t: "auth", did: id("alice").did, sig: sign(id("mallory"), ch.nonce, r.url) });
    expect(await c.next()).toMatchObject({ t: "error", code: "auth" });
    await c.closed;
  });

  it("refuses a signature made for another relay's URL", async () => {
    const r = await relay();
    const c = raw(r.url);
    await c.opened;
    const ch = await c.next();
    const alice = id("alice");
    c.send({ t: "auth", did: alice.did, sig: sign(alice, ch.nonce, "wss://other.example/v1") });
    expect(await c.next()).toMatchObject({ t: "error", code: "auth" });
  });

  it("refuses sends before authentication", async () => {
    const r = await relay();
    const c = raw(r.url);
    await c.opened;
    await c.next();
    c.send({ t: "send", cid: "1", to: id("bob").did, wire: toB64u(new Uint8Array([1, 2, 3])) });
    expect(await c.next()).toMatchObject({ t: "error", code: "auth" });
  });
});

describe("relay delivery", () => {
  it("delivers live between connected devices", async () => {
    const r = await relay();
    const alice = client(r.url, id("alice"));
    const bob = client(r.url, id("bob"));
    await until(() => alice.t.status === "connected" && bob.t.status === "connected");
    expect(await alice.t.post(id("alice").did, id("bob").did, new Uint8Array([9, 9, 9]))).toBe("live");
    await until(() => bob.got.length === 1);
    expect([...bob.got[0]]).toEqual([9, 9, 9]);
    await until(() => r.queued(id("bob").did) === 0);
  });

  it("queues for an offline device and delivers when it connects", async () => {
    const r = await relay();
    const alice = client(r.url, id("alice"));
    await until(() => alice.t.status === "connected");
    expect(await alice.t.post(id("alice").did, id("bob").did, new Uint8Array([1]))).toBe("queued");
    expect(await alice.t.post(id("alice").did, id("bob").did, new Uint8Array([2]))).toBe("queued");
    expect(r.queued(id("bob").did)).toBe(2);
    const bob = client(r.url, id("bob"));
    await until(() => bob.got.length === 2);
    expect(bob.got.map((w) => w[0])).toEqual([1, 2]);
    await until(() => r.queued(id("bob").did) === 0);
  });

  it("redelivers a message that was never acknowledged", async () => {
    const r = await relay();
    const alice = client(r.url, id("alice"));
    await until(() => alice.t.status === "connected");
    await alice.t.post(id("alice").did, id("bob").did, new Uint8Array([7]));
    const c = raw(r.url);
    await c.opened;
    const ch = await c.next();
    c.send({ t: "auth", did: id("bob").did, sig: sign(id("bob"), ch.nonce, r.url) });
    await c.next(); // ready
    const m = await c.next();
    expect(m.t).toBe("msg");
    c.ws.close(); // no ack
    await c.closed;
    expect(r.queued(id("bob").did)).toBe(1);
    const bob = client(r.url, id("bob"));
    await until(() => bob.got.length === 1);
    await until(() => r.queued(id("bob").did) === 0);
  });

  it("keeps queued messages across a relay restart", async () => {
    const dbPath = tmpDb();
    const r1 = await relay(dbPath);
    const alice = client(r1.url, id("alice"));
    await until(() => alice.t.status === "connected");
    await alice.t.post(id("alice").did, id("bob").did, new Uint8Array([5]));
    alice.t.stop();
    await r1.close();
    relays.splice(relays.indexOf(r1), 1);
    const r2 = await relay(dbPath);
    const bob = client(r2.url, id("bob"));
    await until(() => bob.got.length === 1);
    expect(bob.got[0][0]).toBe(5);
  });

  it("refuses a message over the size limit", async () => {
    const r = await relay();
    const c = raw(r.url);
    await c.opened;
    const ch = await c.next();
    const alice = id("alice");
    c.send({ t: "auth", did: alice.did, sig: sign(alice, ch.nonce, r.url) });
    await c.next();
    c.send({ t: "send", cid: "big", to: id("bob").did, wire: toB64u(new Uint8Array(256 * 1024 + 1)) });
    expect(await c.next()).toMatchObject({ t: "error", cid: "big", code: "tooLarge" });
    void fromB64u;
  });
});

describe("RelayTransport", () => {
  it("queues sends while offline and flushes them once the relay is back", async () => {
    const dbPath = tmpDb();
    const port = 39000 + Math.floor(Math.random() * 1000);
    const r1 = await relay(dbPath, port);
    const alice = client(r1.url, id("alice"));
    const statuses: string[] = [];
    alice.t.onStatus((s) => statuses.push(s));
    await until(() => alice.t.status === "connected");
    await r1.close();
    relays.splice(relays.indexOf(r1), 1);
    await until(() => alice.t.status === "offline");
    expect(await alice.t.post(id("alice").did, id("bob").did, new Uint8Array([3]))).toBe("queued");
    expect(alice.t.pending()).toBe(1);
    const r2 = await relay(dbPath, port);
    await until(() => alice.t.status === "connected", 20000);
    await until(() => alice.t.pending() === 0);
    expect(r2.queued(id("bob").did)).toBe(1);
    expect(statuses).toContain("offline");
    expect(statuses.at(-1)).toBe("connected");
  }, 30000);
});
