import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/keripy-kels.json";
import { nextKeyDigest } from "../src/cesr";
import { Controller } from "../src/controller";
import { buildIxn, buildRot, keyAt, isCurrentAt, retiredAt, verifyKel } from "../src/kel";
import { coldKeysFromSeed } from "../src/keys";
import { toStream } from "../src/stream";
import { incept, keyQb64, msgOf, seedFrom, sign, signer, setup } from "./helpers";

const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

describe("KEL basics", () => {
  it("incepts, interacts and rotates; the KEL verifies", async () => {
    const { c } = await incept();
    await c.interact([{ d: nextKeyDigest("x") }]);
    await c.rotate();
    await c.interact([]);
    const r = await verifyKel(toStream(c.kelMessages()), { allowUnwitnessed: true });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.aid).toBe(c.aid);
    expect(r.states).toHaveLength(2);
    expect(r.latest.sn).toBe(3);
    expect(r.latest.estSn).toBe(2);
    expect(r.latest.keys).toEqual(c.state().keys);
  });

  it("without allowUnwitnessed, unreceipted events are pending", async () => {
    const { c } = await incept("a", { witnesses: [nextKeyDigest("w").replace(/^E/, "B")], bt: 1 });
    const r = await verifyKel(c.kelMessages());
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("notWitnessed");
    expect(r.events[0].status).toBe("pending");
  });

  it("we accept KERIpy's KELs, with the same key state", async () => {
    for (const k of fixtures.kels) {
      const r = await verifyKel(k.stream);
      expect(r.problems, k.name).toEqual([]);
      const st = k.state;
      expect(r.aid).toBe(st.i);
      expect(r.latest.sn).toBe(st.s);
      expect(r.latest.said).toBe(st.d);
      expect(r.latest.keys).toEqual(st.k);
      expect(r.latest.next).toEqual(st.n);
      expect(r.latest.kt).toBe(parseInt(st.kt, 16));
      expect(r.latest.nt).toBe(parseInt(st.nt, 16));
      expect(r.latest.bt).toBe(parseInt(st.bt, 16));
      expect(r.latest.witnesses).toEqual(st.b);
    }
  });

  it("key state queries", async () => {
    const { c } = await incept();
    await c.interact([]);
    await c.rotate();
    await c.rotate();
    const kel = await verifyKel(c.kelMessages(), { allowUnwitnessed: true });
    expect(keyAt(kel, 0)[0].curve).toBe("ed25519");
    expect(keyAt(kel, 0)[0].bytes).toHaveLength(32);
    expect(retiredAt(kel, 0)).toBe(2);
    expect(retiredAt(kel, 2)).toBe(3);
    expect(retiredAt(kel, 3)).toBeNull();
    expect(isCurrentAt(kel, 0, 1)).toBe(true);
    expect(isCurrentAt(kel, 0, 2)).toBe(false);
    expect(isCurrentAt(kel, 3, 3)).toBe(true);
  });
});

describe("rotation correctness", () => {
  async function handRot(c: Controller, keys: string[], signSpecs: Parameters<typeof sign>[1], extra: Partial<Parameters<typeof buildRot>[0]> = {}) {
    const st = c.state();
    const { raw, body } = buildRot({ aid: c.aid, s: st.sn + 1, prior: st.said, keys, kt: 1, next: [nextKeyDigest("z")], nt: 1, bt: 0, cuts: [], adds: [], ...extra });
    const m = msgOf("rot", raw, body);
    m.controllerSigs = await sign(raw, signSpecs);
    return verifyKel([...c.kelMessages(), m], { allowUnwitnessed: true });
  }

  it("rotation needs prior next keys", async () => {
    const { c, hot } = await incept();
    // signed only by the current key
    const r1 = await handRot(c, [keyQb64(hot[0])], [{ s: hot[0], index: 0 }]);
    expect(codes(r1)).toContain("nextKeyMismatch");
    // signed by a key whose digest isn't committed
    const stranger = signer("stranger");
    const r2 = await handRot(c, [keyQb64(stranger)], [{ s: stranger, index: 0 }]);
    expect(codes(r2)).toContain("nextKeyMismatch");
  });

  it("dual threshold: prior nt 2 of 3, and new kt, enforced independently", async () => {
    const s = setup("dual");
    const c = await Controller.incept({ hot: s.hot, cold: s.cold, nextCount: 3, nt: 2, store: s.store, clock: s.clock });
    const n = s.cold.release(1, 3);
    const nk = n.map(keyQb64);
    const ok = await handRot(c, nk, [{ s: n[0], index: 0 }, { s: n[1], index: 1 }], { kt: 2 });
    expect(ok.problems).toEqual([]);
    const one = await handRot(c, nk, [{ s: n[0], index: 0 }], { kt: 1 });
    expect(codes(one)).toContain("nextKeyMismatch");
    // prior nt met, new kt 3 not
    const x = signer("x");
    const ktFail = await handRot(c, [nk[0], nk[1], keyQb64(x)], [{ s: n[0], index: 0 }, { s: n[1], index: 1 }], { kt: 3 });
    expect(codes(ktFail)).toContain("thresholdNotMet");
    // new kt 2 met (one prior-next key plus a new one), prior nt 2 not
    const ntFail = await handRot(c, [nk[0], keyQb64(x)], [{ s: n[0], index: 0 }, { s: x, index: 1, code: "B" }], { kt: 2 });
    expect(codes(ntFail)).toContain("nextKeyMismatch");
  });

  it("partial rotation: the principal's key alone rotates with a 2A signature", async () => {
    const principalNext = signer("principal/next");
    const s = setup("agent");
    const c = await Controller.incept({ hot: s.hot, cold: s.cold, extraNext: [nextKeyDigest(keyQb64(principalNext))], nt: 1, store: s.store, clock: s.clock });
    expect(c.state().next).toHaveLength(2);
    expect(c.state().nt).toBe(1);
    // the principal holds the KEL (here, the same store) but no agent keys
    const p = await Controller.load(c.aid, { hot: [], store: s.store, clock: s.clock });
    const rot = await p.rotate({ exposed: [principalNext], next: [nextKeyDigest(keyQb64(signer("principal/next2")))] });
    const sig = rot.controllerSigs![0];
    expect(sig.code).toBe("2A");
    expect(sig.index).toBe(0);
    expect(sig.ondex).toBe(1);
    const r = await verifyKel(p.kelMessages(), { allowUnwitnessed: true });
    expect(r.problems).toEqual([]);
    expect(r.latest.keys).toEqual([keyQb64(principalNext)]);
  });

  it("the agent can also rotate under the shared pattern", async () => {
    const principalNext = signer("principal/next");
    const s = setup("agent2");
    const c = await Controller.incept({ hot: s.hot, cold: s.cold, extraNext: [nextKeyDigest(keyQb64(principalNext))], nt: 1, store: s.store, clock: s.clock });
    const rot = await c.rotate({ extraNext: [nextKeyDigest(keyQb64(signer("principal/next2")))] });
    expect(rot.controllerSigs![0].code).toBe("A");
    expect((await verifyKel(c.kelMessages(), { allowUnwitnessed: true })).problems).toEqual([]);
  });

  it("witness changes: br then ba; removing a non-member or adding a member fails", async () => {
    const w = [0, 1, 2, 3].map((i) => "B" + nextKeyDigest(`w${i}`).slice(1));
    const s = setup("wc");
    const c = await Controller.incept({ hot: s.hot, cold: s.cold, witnesses: w.slice(0, 3), bt: 2, store: s.store, clock: s.clock });
    const n = s.cold.release(1, 1);
    const good = await handRot(c, [keyQb64(n[0])], [{ s: n[0], index: 0 }], { cuts: [w[2]], adds: [w[3]], bt: 2 });
    expect(good.latest.witnesses).toEqual([w[0], w[1], w[3]]);
    expect(codes(good).filter((x) => x !== "notWitnessed")).toEqual([]);
    const bad1 = await handRot(c, [keyQb64(n[0])], [{ s: n[0], index: 0 }], { cuts: [w[3]], bt: 1 });
    expect(codes(bad1)).toContain("badFields");
    const bad2 = await handRot(c, [keyQb64(n[0])], [{ s: n[0], index: 0 }], { adds: [w[0]], bt: 1 });
    expect(codes(bad2)).toContain("badFields");
    // the controller does it in one rotate call
    const rot = await c.rotate({ removeWitnesses: [w[2]], addWitnesses: [w[3]] });
    expect(rot.body.br).toEqual([w[2]]);
    expect(c.state().witnesses).toEqual([w[0], w[1], w[3]]);
  });

  it("abandonment: an empty n ends the KEL", async () => {
    const { c, hot } = await incept();
    await c.rotate({ next: [] });
    expect(c.state().abandoned).toBe(true);
    await expect(c.interact([])).rejects.toThrow(/abandoned/);
    const st = c.state();
    const { raw, body } = buildIxn({ aid: c.aid, s: st.sn + 1, prior: st.said, anchors: [] });
    const m = msgOf("ixn", raw, body);
    m.controllerSigs = await sign(raw, [{ s: c.signers()[0], index: 0 }]);
    const r = await verifyKel([...c.kelMessages(), m], { allowUnwitnessed: true });
    expect(codes(r)).toContain("abandoned");
    void hot;
  });

  it("A0 only: a rot supersedes ixns; a rot can't supersede a rot; an ixn supersedes nothing", async () => {
    const { c, cold } = await incept();
    await c.interact([]);
    await c.interact([]);
    const before = c.kelMessages();
    const rot = await c.rotate({ supersede: 1 });
    expect(rot.s).toBe(1);
    const r = await verifyKel([...before, rot], { allowUnwitnessed: true });
    expect(r.problems).toEqual([]);
    expect(r.evidence).toEqual([]);
    expect(r.superseded.map((x) => x.s)).toEqual([1, 2]);
    expect(r.events.filter((e) => e.status === "superseded")).toHaveLength(2);

    // a second rot at s 1 is duplicity
    const st0 = before[0];
    const n2 = cold.release(1, 1);
    const { raw, body } = buildRot({ aid: c.aid, s: 1, prior: st0.d, keys: [keyQb64(n2[0])], kt: 1, next: [nextKeyDigest("q")], nt: 1, bt: 0, cuts: [], adds: [] });
    const rot2 = msgOf("rot", raw, body);
    rot2.controllerSigs = await sign(raw, [{ s: n2[0], index: 0 }]);
    const r2 = await verifyKel([before[0], rot, rot2], { allowUnwitnessed: true });
    expect(codes(r2)).toContain("duplicity");
    expect(r2.evidence).toHaveLength(1);

    // a second ixn at s 1 is duplicity
    const { c: c2 } = await incept("other");
    const i1 = await c2.interact([]);
    const { raw: raw3, body: body3 } = buildIxn({ aid: c2.aid, s: 1, prior: c2.aid, anchors: [{ d: nextKeyDigest("other") }] });
    const ixn2 = msgOf("ixn", raw3, body3);
    ixn2.controllerSigs = await sign(raw3, [{ s: c2.signers()[0], index: 0 }]);
    const r3 = await verifyKel([c2.kelMessages()[0], i1, ixn2], { allowUnwitnessed: true });
    expect(codes(r3)).toContain("duplicity");
    expect(r3.superseded).toEqual([]);
  });

  it("hot store can't rotate", async () => {
    const { c, store, clock, hot } = await incept();
    const t = await c.openTrail("agent/actions");
    const hotOnly = await Controller.load(c.aid, { hot, store, clock });
    await hotOnly.interact([]);
    await hotOnly.trail(t.id).append({ kind: "agent/tool-call", body: { tool: "x" } });
    await expect(hotOnly.rotate()).rejects.toThrow(/cold/);
  });

  it("load re-derives hot keys from cold after rotations", async () => {
    const { c, store, clock, cold } = await incept();
    await c.rotate();
    const again = await Controller.load(c.aid, { cold, store, clock });
    expect(again.state().keys).toEqual(c.state().keys);
    await again.interact([]);
    expect((await verifyKel(again.kelMessages(), { allowUnwitnessed: true })).ok).toBe(true);
  });

  it("P-256 controller keys", async () => {
    const clock = setup().clock;
    const store = setup().store;
    const cold = coldKeysFromSeed(seedFrom("p256/cold"), "dev", { curve: "p256" });
    const hot = cold.release(0, 1);
    const c = await Controller.incept({ hot, cold, store, clock, data: { messagingDid: "did:key:z6Mkexample", keyClass: "B", device: "camera" } });
    expect(c.state().keys[0].startsWith("1AAJ")).toBe(true);
    await c.interact([{ d: nextKeyDigest("batch") }]);
    const rot = await c.rotate();
    expect(rot.controllerSigs![0].code).toBe("E");
    const r = await verifyKel(c.kelMessages(), { allowUnwitnessed: true });
    expect(r.problems).toEqual([]);
    expect(keyAt(r, 0)[0].curve).toBe("p256");
    expect(c.kelMessages()[0].body.a).toEqual([{ messagingDid: "did:key:z6Mkexample", keyClass: "B", device: "camera" }]);
  });
});
