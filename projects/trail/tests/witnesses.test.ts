/** Witness and watcher behavior through the HTTP transport, and the demo surviving a restart. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoClock, seedFrom } from "@zk-toip/trust-core";
import { coldKeysFromSeed, Controller, MemoryStore, toStream, verifyEvidence, verifyKel, Watcher, httpWitnessClient } from "@zk-toip/eventlog";
import { forkAt } from "../src/attacks";
import { runNext } from "../src/steps";
import { WitnessService } from "../src/witnesses";
import { World } from "../src/world";

const T0 = "2026-11-06T18:00:00.000Z";
const started: WitnessService[] = [];
afterEach(async () => {
  for (const w of started.splice(0)) await w.close();
});

async function witnesses(clock: DemoClock) {
  const ws = [1, 2, 3].map((n) => new WitnessService(n, seedFrom(`t/w${n}`), new MemoryStore(), clock));
  for (const w of ws) await w.listen(0, "127.0.0.1");
  started.push(...ws);
  return { ws, clients: ws.map((w) => httpWitnessClient(w.url, w.aid)) };
}

async function agent(clock: DemoClock, aids: string[]) {
  const cold = coldKeysFromSeed(seedFrom("t/agent"), "agent");
  const c = await Controller.incept({ hot: cold.release(0, 1), cold, witnesses: aids, bt: 2, store: new MemoryStore(), clock });
  const t = await c.openTrail("agent/actions");
  await t.append({ kind: "agent/tool-call", body: { n: 1 } });
  return { c, t, cold };
}

describe("witness services over HTTP", () => {
  it("an honest witness receipts the first version and refuses another, returning the first", async () => {
    const clock = new DemoClock(T0);
    const { ws, clients } = await witnesses(clock);
    const { c, t, cold } = await agent(clock, ws.map((w) => w.aid));
    expect((await c.publish(clients)).missing).toEqual([]);
    const fork = await forkAt(c.store, c.aid, t.id, cold.release(0, 1), clock, { trailTo: 0 });
    const { entry: b } = await fork.trail(t.id).append({ kind: "agent/tool-call", body: { n: "other" } });
    const r = await clients[0].submit(toStream([b]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("duplicity");
      expect(r.firstSeen).toContain(t.head().d);
    }
    expect(await clients[0].head(t.id).then((h) => h?.d)).toBe(t.head().d);
  });

  it("a rogue witness receipts both versions, and a watcher polling over HTTP convicts it", async () => {
    const clock = new DemoClock(T0);
    const { ws, clients } = await witnesses(clock);
    const { c, t, cold } = await agent(clock, ws.map((w) => w.aid));
    await c.publish(clients);
    ws[2].rogue = true;
    const { entry: a } = await t.append({ kind: "agent/payment", body: { v: "A" } });
    await c.publish([clients[0], clients[2]]);
    const fork = await forkAt(c.store, c.aid, t.id, cold.release(0, 1), clock, { trailTo: 1 });
    const { entry: b } = await fork.trail(t.id).append({ kind: "agent/payment", body: { v: "B" } });
    const rep = await fork.publish([clients[1], clients[2]]);
    expect(rep.missing).toEqual([]);
    for (const [m, n] of [
      [a, [0, 2]],
      [b, [1, 2]],
    ] as const)
      for (const i of n) expect((await ws[i].store.receipts(t.id, 2, m.d)).some((r) => r.by === ws[i].aid)).toBe(true);
    const watcher = new Watcher({ id: "ada", store: new MemoryStore(), sources: clients, clock });
    watcher.watch(t.id, c.aid);
    await watcher.poll();
    const ev = await watcher.evidence(t.id);
    const wit = ev.find((e) => e.kind === "witness");
    expect(wit?.witness).toBe(ws[2].aid);
    const kel = await verifyKel(await clients[0].query({ logId: c.aid }));
    expect(await verifyEvidence(wit!, kel)).toBe(true);
    expect(await verifyEvidence({ ...wit!, witness: ws[0].aid }, kel)).toBe(false);
    expect(ev.some((e) => e.kind === "controller" && e.s === 2)).toBe(true);
  });
});

describe("the demo survives a restart", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("stops after the fork, starts again from its data folder, and finishes", async () => {
    dir = mkdtempSync(join(tmpdir(), "trail-"));
    let w = await World.open({ dataDir: dir });
    for (let n = 1; n <= 5; n++) await runNext(w, n);
    const aid = w.state.scout!.aid;
    const w1 = w.witness(1).aid;
    const first6 = (await w.witness(1).store.get(w.state.scout!.trailId, 6))!.d;
    await w.close();

    w = await World.open({ dataDir: dir });
    try {
      expect(w.state.progress).toBe(5);
      expect(w.state.scout!.aid).toBe(aid);
      expect(w.witness(1).aid).toBe(w1);
      // first seen, always seen
      expect((await w.witness(1).store.get(w.state.scout!.trailId, 6))!.d).toBe(first6);
      expect((await w.adaWatcher.evidence(w.state.scout!.trailId)).some((e) => e.s === 6)).toBe(true);
      for (let n = 6; n <= 10; n++) await runNext(w, n);
      expect(w.state.reports).toHaveLength(10);
      expect(w.state.captures).toHaveLength(3);
    } finally {
      await w.close();
    }
  });
});
