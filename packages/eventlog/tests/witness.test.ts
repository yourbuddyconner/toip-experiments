import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, DemoClock, Endpoint, identityFromSeed, seedFrom } from "@zk-toip/trust-core";
import { Controller } from "../src/controller";
import { WitnessError, type WitnessClient } from "../src/client";
import { verifyKel } from "../src/kel";
import { MemoryStore } from "../src/store";
import { fromStream, toStream } from "../src/stream";
import { makeReceipt, endorse } from "../src/receipts";
import { verifyTrail } from "../src/trail";
import { checkTrailRef, exportBundle, verifyBundle } from "../src/verify";
import { Watcher, verifyEvidence } from "../src/watcher";
import { Witness, localWitnessClient } from "../src/witness";
import { httpWitnessClient, witnessHttpHandler } from "../src/http";
import { serveWitnessTasks, taskWitnessClient, disclose, onDisclose } from "../src/tasks";
import { signerFromIdentity } from "../src/keys";
import { JsonFileStore, serveHttp } from "../src/node";
import { setup, signer, T0 } from "./helpers";
import type { Bundle } from "../src/verify";

const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

async function world(n = 3, bt = 2) {
  const s = setup("scout");
  const ws = Array.from({ length: n }, (_, i) => new Witness({ signer: signer(`w/${i}`), store: new MemoryStore(), clock: s.clock }));
  const clients = ws.map(localWitnessClient);
  const c = await Controller.incept({ hot: s.hot, cold: s.cold, witnesses: ws.map((w) => w.aid), bt, store: s.store, clock: s.clock });
  return { ...s, ws, clients, c };
}

const dead: WitnessClient = {
  aid: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  submit: () => new Promise(() => {}),
  addReceipts: () => new Promise(() => {}),
  query: async () => "",
  head: async () => undefined,
};

describe("witnesses and receipts", () => {
  it("publish gets receipts from every witness, and round-robins them", async () => {
    const { c, clients, ws, store } = await world();
    const t = await c.openTrail("agent/actions");
    await t.append({ kind: "agent/tool-call", body: { x: 1 } });
    const report = await c.publish(clients);
    expect(report.missing).toEqual([]);
    expect(report.evidence).toEqual([]);
    const kel = await verifyKel(c.kelMessages());
    expect(kel.problems).toEqual([]);
    for (const w of ws) {
      expect((await w.store.receipts(c.aid, 0, c.aid)).map((r) => r.by).sort()).toEqual(ws.map((x) => x.aid).sort());
      expect(await w.store.receipts(t.id, 1, t.head().d)).toHaveLength(3);
    }
    const b = await exportBundle(store, c.aid);
    const v = await verifyBundle(b);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.trails[0].entries[1].status).toBe("valid");
    expect(v.trails[0].entries[1].receipts).toHaveLength(3);
    expect(v.trails[0].entries[1].earliestReceipt).toBe(T0);
    expect(v.witnessChecked).toBe(false);
    // a second publish sends nothing new
    expect((await c.publish(clients)).sent).toBe(0);
  });

  it("appendWitnessed returns with bt receipts", async () => {
    const { c, clients } = await world();
    await c.publish(clients);
    const t = await c.openTrail("agent/actions");
    const { entry, receipts } = await t.appendWitnessed({ kind: "agent/mandate-decision", body: { outcome: "allow" } }, clients);
    expect(receipts.length).toBeGreaterThanOrEqual(2);
    expect(t.ref(entry.s)).toEqual({ i: t.id, s: "1", d: entry.d });
  });

  it("appendWitnessed fails closed when no witness answers", async () => {
    const { c, ws } = await world(1, 1);
    const t = await c.openTrail("agent/actions");
    const err = await t.appendWitnessed({ kind: "agent/mandate-decision", body: {} }, [{ ...dead, aid: ws[0].aid }], { timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(WitnessError);
    expect((err as WitnessError).details.receipts).toBe(0);
    expect((err as WitnessError).details.missing[0].error).toMatch(/timed out/);
    // and with no witnesses configured at all
    const s = setup("lonely");
    const lonely = await Controller.incept({ hot: s.hot, cold: s.cold, store: s.store, clock: s.clock });
    const lt = await lonely.openTrail("agent/actions");
    await expect(lt.appendWitnessed({ kind: "x" }, [])).rejects.toBeInstanceOf(WitnessError);
  });

  it("clock skew: dt more than 5 minutes ahead is refused; a past dt is receipted with the receipt's own time", async () => {
    const { c, clients, clock, ws } = await world(1, 1);
    await c.publish(clients);
    const deviceClock = new DemoClock(T0);
    const dev = await Controller.load(c.aid, { hot: c.signers(), store: c.store, clock: deviceClock });
    const t = await dev.openTrail("device/captures");
    deviceClock.advance(10 * 60_000);
    const { entry } = await t.append({ kind: "device/capture" });
    const trailMsgs = (await dev.store.range(t.id)).map((m) => fromStream(m.raw + m.attachments).messages[0]);
    const refused = await clients[0].submit(toStream(trailMsgs));
    // the tin is fine, the entry is ahead
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal).toBe("clockSkew");
    // later the witness's clock catches up, and the clock moves past
    clock.advance(20 * 60_000);
    const ok = await clients[0].submit(toStream([entry]));
    expect(ok.ok).toBe(true);
    const r = fromStream(ok.ok ? ok.receipts : "").messages[0];
    expect(r.body.dt).toBe(clock.iso());
    expect(String(entry.body.dt) < String(r.body.dt)).toBe(true);
    void ws;
  });

  describe("first seen, always seen, across restarts", () => {
    let dir = "";
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
    it("a witness on a JsonFileStore keeps first-seen versions and refuses others", async () => {
      dir = mkdtempSync(join(tmpdir(), "eventlog-"));
      const path = join(dir, "w.json");
      const s = setup("fs");
      const wsigner = signer("w/fs");
      let w = new Witness({ signer: wsigner, store: new JsonFileStore(path, { flushMs: 5 }), clock: s.clock });
      const c = await Controller.incept({ hot: s.hot, cold: s.cold, witnesses: [w.aid], bt: 1, store: s.store, clock: s.clock });
      const t = await c.openTrail("agent/actions");
      await t.append({ kind: "a", body: { v: "A" } });
      expect((await c.publish([localWitnessClient(w)])).missing).toEqual([]);
      (w.store as JsonFileStore).close();
      // restart
      w = new Witness({ signer: wsigner, store: new JsonFileStore(path), clock: s.clock });
      expect((await w.store.range(t.id)).length).toBe(2);
      // a fork of entry 1
      const fork = await Controller.load(c.aid, { hot: c.signers(), store: new MemoryStore((s.store as MemoryStore).dump()), clock: s.clock });
      const forkStore = fork.store as MemoryStore;
      const all = await forkStore.range(t.id);
      const forked = new MemoryStore();
      for (const m of [...(await forkStore.all(c.aid)), all[0]]) await forked.put(m);
      const f2 = await Controller.load(c.aid, { hot: c.signers(), store: forked, clock: s.clock });
      const { entry: b } = await f2.trail(t.id).append({ kind: "a", body: { v: "B" } });
      const r = await w.submit(toStream([b]));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refusal).toBe("duplicity");
        expect(fromStream(r.firstSeen!).messages[0].d).toBe(t.head().d);
      }
      // the JSON-file store round-trips everything
      const again = new JsonFileStore(path);
      const dump = (again as MemoryStore).dump();
      (w.store as JsonFileStore).flushSync();
      const now = new JsonFileStore(path).dump();
      expect(now.messages.length).toBeGreaterThanOrEqual(dump.messages.length);
      expect((await new JsonFileStore(path).evidence()).length).toBe(1);
      expect(await new JsonFileStore(path).getBody("nope")).toBeUndefined();
    });
  });
});

/** Makes a second version of the next trail entry, as a forking controller would. */
async function forkNext(c: Controller, trailId: string, body: Record<string, unknown>) {
  const src = c.store as MemoryStore;
  const copy = new MemoryStore();
  for (const m of await src.all(c.aid)) await copy.put(m);
  for (const m of await src.range(trailId)) await copy.put(m);
  const f = await Controller.load(c.aid, { hot: c.signers(), store: copy, clock: c.clock });
  return (await f.trail(trailId).append({ kind: "agent/tool-call", body })).entry;
}

describe("fork and duplicity", () => {
  it("controller fork: at most one version reaches bt; the other is refused; evidence verifies standalone", async () => {
    const { c, clients, ws } = await world();
    const t = await c.openTrail("agent/actions");
    await c.publish(clients);
    const b = await forkNext(c, t.id, { v: "B" });
    const { entry: a } = await t.append({ kind: "agent/tool-call", body: { v: "A" } });
    expect(a.s).toBe(b.s);
    // A goes to witnesses 0 and 1, B to all three
    await c.publish(clients.slice(0, 2));
    const results = await Promise.all(clients.map((w) => w.submit(toStream([b]))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok)!;
    expect(!refused.ok && refused.refusal).toBe("duplicity");
    const kel = await verifyKel(c.kelMessages());
    const ev = await ws[0].evidence(t.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("controller");
    expect(await verifyEvidence(ev[0], kel)).toBe(true);
  });

  it("rogue witness: a witness that signs two versions is convicted; one that signs one is not", async () => {
    const { c, clients, ws, store } = await world();
    const t = await c.openTrail("agent/actions");
    await c.publish(clients);
    const b = await forkNext(c, t.id, { v: "B" });
    const { entry: a } = await t.append({ kind: "agent/tool-call", body: { v: "A" } });
    // witness 0 receipts A, witness 1 receipts B, rogue witness 2 receipts both
    await clients[0].submit(toStream([a]));
    await clients[1].submit(toStream([b]));
    const rogue = signer("w/2");
    const ra = await makeReceipt(a, rogue, { dt: c.clock.iso() });
    const rb = await makeReceipt(b, rogue, { dt: c.clock.iso() });
    await ws[2].store.put({ logId: a.logId, s: a.s, d: a.d, t: a.t, raw: a.raw, attachments: toStream([a]).slice(a.raw.length), fn: 0, seenAt: T0, local: false });
    await ws[2].store.addReceipt(a.logId, a.s, a.d, { by: ws[2].aid, kind: "witness", raw: ra.raw, attachments: toStream([ra]).slice(ra.raw.length), dt: T0 });
    // a watcher polling all three
    const watcher = new Watcher({ id: "ada", store: new MemoryStore(), sources: clients, clock: c.clock });
    watcher.watch(t.id, c.aid);
    await watcher.poll();
    // the rogue's second receipt arrives (e.g. gossiped by the controller)
    const got = await watcher.ingest(toStream([b, rb]), "gossip");
    const all = [...got.evidence, ...(await watcher.evidence())];
    const witnessEv = all.find((e) => e.kind === "witness" && e.witness === ws[2].aid);
    const controllerEv = all.find((e) => e.kind === "controller");
    expect(witnessEv).toBeDefined();
    expect(controllerEv).toBeDefined();
    const kel = await verifyKel(c.kelMessages(), { allowUnwitnessed: true });
    expect(await verifyEvidence(witnessEv!, kel)).toBe(true);
    expect(await verifyEvidence(controllerEv!, kel)).toBe(true);
    // witness 0 signed only A: evidence pairing its receipt with the rogue's is not a conviction of witness 0
    const r0 = fromStream(await clients[0].query({ logId: t.id, from: a.s, to: a.s })).messages.find((m) => m.t === "trc")!;
    expect(await verifyEvidence({ ...witnessEv!, witness: ws[0].aid, a: r0, b: rb }, kel)).toBe(false);
    void store;
  });

  it("watcher gossip: two watchers each seeing one version detect duplicity after exchanging heads", async () => {
    const { c, clients } = await world(2, 1);
    const t = await c.openTrail("agent/actions");
    await c.publish(clients);
    const b = await forkNext(c, t.id, { v: "B" });
    const { entry: a } = await t.append({ kind: "agent/tool-call", body: { v: "A" } });
    await clients[0].submit(toStream([a]));
    await clients[1].submit(toStream([b]));
    const w1 = new Watcher({ id: "principal", store: new MemoryStore(), sources: [clients[0]], clock: c.clock });
    const w2 = new Watcher({ id: "payee", store: new MemoryStore(), sources: [clients[1]], clock: c.clock });
    for (const w of [w1, w2]) {
      w.watch(t.id, c.aid);
      expect(await w.poll()).toEqual([]);
    }
    w2.addSource(w1.asSource());
    const ev = await w2.poll();
    expect(ev.some((e) => e.kind === "controller")).toBe(true);
  });

  it("recovery is not duplicity: a superseded ixn and a cut entry are accepted by witnesses as recovery", async () => {
    const { c, clients, ws } = await world();
    const t = await c.openTrail("agent/actions");
    for (let i = 0; i < 3; i++) await t.append({ kind: "agent/tool-call", body: { i } });
    await c.publish(clients);
    // the attacker, with the hot key, writes two entries and a checkpoint, and gets them witnessed
    const copy = new MemoryStore((c.store as MemoryStore).dump());
    const attacker = await Controller.load(c.aid, { hot: c.signers(), store: copy, clock: c.clock });
    await attacker.trail(t.id).append({ kind: "agent/tool-call", body: { evil: 1 } });
    await attacker.trail(t.id).append({ kind: "agent/tool-call", body: { evil: 2 } });
    await attacker.checkpointNow();
    expect((await attacker.publish(clients)).missing).toEqual([]);
    // recovery
    await c.rotate({ cutAfter: { [t.id]: 3 } });
    const { entry: new4 } = await t.append({ kind: "agent/tool-call", body: { good: 4 } });
    const rep = await c.publish(clients);
    expect(rep.missing).toEqual([]);
    expect(rep.evidence).toEqual([]);
    for (const w of ws) {
      expect(await w.evidence()).toEqual([]);
      expect((await w.store.get(t.id, 4))?.d).toBe(new4.d);
    }
    // a watcher sees the whole story from a witness, and calls it recovery
    const fetched = fromStream(await clients[0].query({ logId: c.aid })).messages;
    const kel = await verifyKel(fetched);
    expect(kel.ok).toBe(true);
    const bundle = await exportBundle(ws[0].store, c.aid);
    const v = await verifyBundle(bundle);
    expect(v.kel.superseded).toHaveLength(1);
    expect(v.trails[0].evidence).toEqual([]);
    expect(v.trails[0].entries.filter((e) => e.status === "cut").map((e) => e.s)).toEqual([4, 5]);
    expect(v.trails[0].head?.d).toBe(new4.d);
  });
});


describe("transports", () => {
  it("HTTP: publish, query, head, and a counterparty's trailRef check", async () => {
    const s = setup("http");
    const w = new Witness({ signer: signer("w/http"), store: new MemoryStore(), clock: s.clock });
    const server = await serveHttp(witnessHttpHandler(w));
    try {
      const client = httpWitnessClient(server.url, w.aid);
      const c = await Controller.incept({ hot: s.hot, cold: s.cold, witnesses: [w.aid], bt: 1, store: s.store, clock: s.clock });
      const t = await c.openTrail("agent/actions");
      const { entry } = await t.appendWitnessed({ kind: "agent/mandate-decision", body: { outcome: "allow" } }, [client]);
      const head = await client.head(t.id);
      expect(head?.d).toBe(entry.d);
      const check = await checkTrailRef(t.ref(entry.s), client);
      expect(check.problems).toEqual([]);
      expect(check.ok).toBe(true);
      expect(check.receipts).toHaveLength(1);
      // the counterparty endorses it
      const payee = identityFromSeed(seedFrom("payee"));
      await client.addReceipts(toStream([endorse(entry, payee, s.clock.iso())]));
      const v = await verifyTrail({ kel: check.kel!, stream: await client.query({ logId: t.id }) });
      expect(v.entries[1].endorsements).toHaveLength(1);
      // a wrong d fails
      const bad = await checkTrailRef({ ...t.ref(entry.s), d: t.ref(0).d }, client);
      expect(bad.ok).toBe(false);
      expect(await client.evidence()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("Trust Task transport: submit, receipts, query and head over TSP, plus trail/disclose", async () => {
    const clock = new DemoClock(T0);
    const bus = new Bus(clock);
    const wid = identityFromSeed(seedFrom("w/tsp"));
    const w = new Witness({ signer: signerFromIdentity(wid), store: new MemoryStore(), clock });
    const wEnd = new Endpoint({ identity: wid, transport: bus, clock });
    serveWitnessTasks(wEnd, w);
    const agentId = identityFromSeed(seedFrom("agent/tsp"));
    const agentEnd = new Endpoint({ identity: agentId, transport: bus, clock });
    const client = taskWitnessClient(agentEnd, w.did);
    expect(client.aid).toBe(w.aid);
    const s = setup("tsp");
    const c = await Controller.incept({ hot: s.hot, cold: s.cold, witnesses: [w.aid], bt: 1, store: s.store, clock, bind: agentId });
    const t = await c.openTrail("agent/actions");
    await t.append({ kind: "agent/tool-call", body: { secret: "only for the principal" } });
    const { entry } = await t.appendWitnessed({ kind: "agent/mandate-decision", body: { outcome: "allow" } }, [client]);
    expect((await client.head(t.id))?.d).toBe(entry.d);
    expect(fromStream(await client.query({ logId: t.id })).messages.length).toBeGreaterThan(2);
    // disclosure of one body to the principal
    const principalId = identityFromSeed(seedFrom("principal/tsp"));
    const principalEnd = new Endpoint({ identity: principalId, transport: bus, clock });
    let got: Bundle | undefined;
    onDisclose(principalEnd, (b) => {
      got = b;
    });
    const bundle = await exportBundle(s.store, c.aid, { entries: { [t.id]: [2] } });
    await disclose(agentEnd, principalId.did, bundle);
    expect(got).toBeDefined();
    const v = await verifyBundle(got!, { expectDid: agentId.did, clock, witnesses: [client] });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.witnessChecked).toBe(true);
    expect(v.trails[0].entries.filter((e) => e.body)).toHaveLength(1);
    expect(JSON.stringify(got)).not.toContain("only for the principal");
  });

  it("truncation is caught when a witness head is compared", async () => {
    const { c, clients, store } = await world();
    const t = await c.openTrail("agent/actions");
    for (let i = 0; i < 4; i++) await t.append({ kind: "k", body: { i } });
    await c.publish(clients);
    const b = await exportBundle(store, c.aid);
    const msgs = fromStream(b.trails[0].stream).messages.filter((m) => m.s <= 2);
    const short: Bundle = { ...b, trails: [{ id: t.id, stream: toStream(msgs) }] };
    const offline = await verifyBundle(short);
    expect(offline.ok).toBe(true);
    expect(offline.witnessChecked).toBe(false);
    const online = await verifyBundle(short, { witnesses: clients });
    expect(codes(online)).toContain("truncated");
  });
});
