/**
 * KERIpy computes the same key state from our KELs.
 * Runs when KERIPY_PYTHON points at a Python with keri 1.3.x installed, for example:
 *   python3.12 -m venv ~/.cache/zk-toip-keripy/venv && ~/.cache/zk-toip-keripy/venv/bin/pip install "keri==1.3.*"
 *   KERIPY_PYTHON=~/.cache/zk-toip-keripy/venv/bin/python npm test --workspace @zk-toip/eventlog
 * Otherwise every case is skipped.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nextKeyDigest } from "../src/cesr";
import { Controller } from "../src/controller";
import { verifyKel, type KelResult } from "../src/kel";
import { coldKeysFromSeed, keyQb64 } from "../src/keys";
import { MemoryStore } from "../src/store";
import { toStream } from "../src/stream";
import { Witness, localWitnessClient } from "../src/witness";
import { seedFrom, setup, signer } from "./helpers";
import type { SignedMessage } from "../src/types";

const python = process.env.KERIPY_PYTHON;
const script = fileURLToPath(new URL("../interop/keripy_check.py", import.meta.url));
const run = python ? describe : describe.skip;
if (!python) console.log("interop: KERIPY_PYTHON is not set; skipping the KERIpy tests");

function keripy(stream: string): Record<string, { i: string; s: number; d: string; kt: string; k: string[]; nt: string; n: string[]; bt: string; b: string[] }> {
  const r = spawnSync(python!, ["-I", script], { input: stream, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`keripy_check failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

async function same(msgs: SignedMessage[], opts: { witnessed?: boolean } = {}) {
  const ours: KelResult = await verifyKel(msgs, { allowUnwitnessed: !opts.witnessed });
  expect(ours.problems).toEqual([]);
  const theirs = keripy(toStream(msgs))[ours.aid];
  expect(theirs, "KERIpy did not accept the KEL").toBeDefined();
  expect(theirs.s).toBe(ours.latest.sn);
  expect(theirs.d).toBe(ours.latest.said);
  expect(theirs.k).toEqual(ours.latest.keys);
  expect(theirs.n).toEqual(ours.latest.next);
  expect(parseInt(theirs.kt, 16)).toBe(ours.latest.kt);
  expect(parseInt(theirs.nt, 16)).toBe(ours.latest.nt);
  expect(theirs.b).toEqual(ours.latest.witnesses);
  expect(parseInt(theirs.bt, 16)).toBe(ours.latest.bt);
}

run("keripy accepts ours (KERIpy 1.3.x)", () => {
  it("icp", async () => {
    const { clock, store, cold, hot } = setup("i1");
    const c = await Controller.incept({ hot, cold, store, clock });
    await same(c.kelMessages());
  });

  it("icp + ixn, with seals and a data field", async () => {
    const { clock, store, cold, hot } = setup("i2");
    const c = await Controller.incept({ hot, cold, store, clock, data: { device: "camera", keyClass: "B" } });
    const t = await c.openTrail("agent/actions");
    await t.append({ kind: "k", body: { x: 1 } });
    await c.checkpointNow();
    await c.interact([{ d: nextKeyDigest("doc") }]);
    await same(c.kelMessages());
  });

  it("icp + rot (full), multisig 2 of 3", async () => {
    const { clock, store, cold } = setup("i3");
    const c = await Controller.incept({ hot: cold.release(0, 3), cold, kt: 2, nt: 2, nextCount: 3, store, clock });
    await c.rotate({ kt: 2, nt: 2 });
    await c.rotate();
    await same(c.kelMessages());
  });

  it("icp + rot (partial): the principal's key alone rotates", async () => {
    const { clock, store, cold, hot } = setup("i4");
    const principal = signer("principal/next");
    const c = await Controller.incept({ hot, cold, extraNext: [nextKeyDigest(keyQb64(principal))], nt: 1, store, clock });
    const p = await Controller.load(c.aid, { hot: [], store, clock });
    const rot = await p.rotate({ exposed: [principal], next: [nextKeyDigest(keyQb64(signer("principal/next2")))] });
    expect(rot.controllerSigs![0].code).toBe("2A");
    await same(p.kelMessages());
  });

  it("icp + rot (partial, extraKeys): the principal rotates alone and names the agent's new key", async () => {
    const { clock, store, cold, hot } = setup("i4b");
    const principal = signer("principal/next");
    const c = await Controller.incept({ hot, cold, extraNext: [nextKeyDigest(keyQb64(principal))], nt: 1, store, clock });
    const p = await Controller.load(c.aid, { hot: [], store, clock });
    await p.rotate({ exposed: [principal], extraKeys: [keyQb64(cold.release(1, 1)[0])], next: [...cold.commit(2, 1), nextKeyDigest(keyQb64(signer("principal/next2")))], nt: 1 });
    await same(p.kelMessages());
  });

  it("witness add and remove, with witness receipts", async () => {
    const { clock, store, cold, hot } = setup("i5");
    const ws = [0, 1, 2, 3].map((i) => new Witness({ signer: signer(`iw/${i}`), store: new MemoryStore(), clock }));
    const c = await Controller.incept({ hot, cold, witnesses: ws.slice(0, 3).map((w) => w.aid), bt: 2, store, clock });
    await c.interact([]);
    await c.publish(ws.slice(0, 3).map(localWitnessClient));
    await c.rotate({ removeWitnesses: [ws[2].aid], addWitnesses: [ws[3].aid], bt: 2 });
    await c.publish([ws[0], ws[1], ws[3]].map(localWitnessClient));
    await same(c.kelMessages(), { witnessed: true });
  });

  it("a superseding recovery (rule A0)", async () => {
    const { clock, store, cold, hot } = setup("i6");
    const c = await Controller.incept({ hot, cold, store, clock });
    const copy = new MemoryStore((store as MemoryStore).dump());
    const attacker = await Controller.load(c.aid, { hot, store: copy, clock });
    const bad = await attacker.interact([{ d: nextKeyDigest("evil") }]);
    const rot = await c.rotate();
    expect(rot.s).toBe(bad.s);
    await same([c.kelMessages()[0], bad, rot]);
  });

  it("P-256 keys", async () => {
    const { clock, store } = setup("i7");
    const cold = coldKeysFromSeed(seedFrom("i7/p256"), "dev", { curve: "p256" });
    const c = await Controller.incept({ hot: cold.release(0, 1), cold, store, clock });
    await c.interact([{ d: nextKeyDigest("root") }]);
    await c.rotate();
    await same(c.kelMessages());
  });
});
