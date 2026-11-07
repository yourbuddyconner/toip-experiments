import { describe, expect, it } from "vitest";
import { utf8 } from "@zk-toip/trust-core";
import { digest, nextKeyDigest } from "../src/cesr";
import { Controller } from "../src/controller";
import { buildRot, verifyKel } from "../src/kel";
import { signWith } from "../src/keys";
import { makeBody } from "../src/said";
import { MemoryStore } from "../src/store";
import { fromStream, toStream } from "../src/stream";
import { buildTen, verifyTrail } from "../src/trail";
import { exportBundle, verifyBundle, verifySignature } from "../src/verify";
import { incept, keyQb64, msgOf, sign } from "./helpers";
import type { KeyRefSig, SignedMessage } from "../src/types";

const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);
const loose = { allowUnwitnessed: true };

async function scout(entries = 7) {
  const env = await incept("scout");
  const trail = await env.c.openTrail("agent/actions");
  const bodies = [];
  for (let i = 1; i <= entries; i++) {
    env.clock.advance(1000);
    const { body } = await trail.append({ kind: i === entries ? "agent/payment-intent" : "agent/tool-call", body: { n: i, amount: i === entries ? "340.00" : undefined } });
    bodies.push(body!);
  }
  return { ...env, trail, bodies };
}

async function check(c: Controller, stream: string | SignedMessage[], bodies?: Parameters<typeof verifyTrail>[0]["bodies"]) {
  const kel = await verifyKel(c.kelMessages(), loose);
  return verifyTrail({ kel, stream, bodies }, loose);
}

/** Replaces one message's raw text in a stream and re-signs nothing. */
function streamOf(msgs: SignedMessage[]) {
  return toStream(msgs);
}

async function trailMsgs(env: Awaited<ReturnType<typeof scout>>) {
  return fromStream((await exportBundle(env.store, env.c.aid)).trails[0].stream).messages;
}

describe("trails", () => {
  it("a clean trail verifies, with bodies", async () => {
    const env = await scout();
    const msgs = await trailMsgs(env);
    const r = await check(env.c, msgs, env.bodies);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.entries).toHaveLength(8);
    expect(r.purpose).toBe("agent/actions");
    expect(r.entries[7].body).toEqual({ said: env.bodies[6].d, ok: true });
    expect(r.entries.every((e) => e.status === "valid")).toBe(true); // no witnesses configured: bt is 0
  });

  it("body tamper: bodyMismatch", async () => {
    const env = await scout();
    const bodies = env.bodies.map((b) => ({ ...b }));
    bodies[6].amount = "3400.00";
    const r = await check(env.c, await trailMsgs(env), bodies);
    expect(codes(r)).toContain("bodyMismatch");
    expect(r.ok).toBe(false);
  });

  it("header tamper: saidMismatch, then signatureInvalid when the SAID is recomputed, then sealMismatch against a checkpoint", async () => {
    const env = await scout();
    await env.c.checkpointNow();
    const msgs = await trailMsgs(env);
    const tampered = makeBody({ amount: "3400.00" });
    // 1. change a, keep d
    const m = msgs[7];
    const raw1 = m.raw.replace(String(m.body.a), tampered.said);
    const r1 = await check(env.c, streamOf(msgs).replace(m.raw, raw1));
    expect(codes(r1)).toContain("saidMismatch");
    // 2. recompute the SAID: the signature no longer verifies
    const { raw: raw2, body } = buildTen({ trailId: m.logId, s: m.s, prior: String(m.body.p), dt: String(m.body.dt), kind: String(m.body.k), bodySaid: tampered.said, refs: [] });
    const forged = { ...msgOf("ten", raw2, body), keyRefSig: m.keyRefSig };
    const r2 = await check(env.c, [...msgs.slice(0, 7), forged]);
    expect(codes(r2)).toContain("signatureInvalid");
    expect(codes(r2)).toContain("truncated"); // the checkpoint seals entry 7, which is no longer shown validly
    // 3. even re-signed with the real key, the checkpoint seal doesn't match
    forged.keyRefSig = { ...m.keyRefSig!, sigs: await sign(raw2, [{ s: env.c.signers()[0], index: 0 }]) };
    const r3 = await check(env.c, [...msgs.slice(0, 7), forged]);
    expect(codes(r3)).toContain("sealMismatch");
  });

  it("reorder, delete middle, duplicate entry", async () => {
    const env = await scout();
    const msgs = await trailMsgs(env);
    const swapped = [...msgs];
    [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    expect(codes(await check(env.c, swapped))).toContain("badSequence");
    const deleted = msgs.filter((_, i) => i !== 4);
    expect(codes(await check(env.c, deleted))).toContain("badSequence");
    // a copy of entry 3 placed as entry 4: its s is wrong for the place, and re-labelling breaks the SAID
    const dupRaw = msgs[3].raw.replace(/"s":"3"/, '"s":"4"');
    const dup = streamOf([...msgs.slice(0, 4), msgs[3]]) + "";
    expect((await check(env.c, dup)).ok).toBe(true); // an identical copy is merged, not counted twice
    const r = await check(env.c, streamOf([...msgs.slice(0, 4)]) + dupRaw + "-FAB");
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("saidMismatch");
  });

  it("truncation: offline it verifies as complete up to its head", async () => {
    const env = await scout();
    const msgs = await trailMsgs(env);
    const r = await check(env.c, msgs.slice(0, 5));
    expect(r.ok).toBe(true);
    expect(r.head?.s).toBe(4);
    // a checkpoint beyond the shown head reveals the truncation
    await env.c.checkpointNow();
    const r2 = await check(env.c, msgs.slice(0, 5));
    expect(codes(r2)).toContain("truncated");
  });

  it("dt can't go backwards", async () => {
    const env = await scout(2);
    const msgs = await trailMsgs(env);
    const last = msgs[2];
    const { raw, body } = buildTen({ trailId: last.logId, s: 3, prior: last.d, dt: "2026-01-01T00:00:00.000Z", kind: "x", bodySaid: "", refs: [] });
    const m = msgOf("ten", raw, body);
    m.keyRefSig = { ...last.keyRefSig!, sigs: await sign(raw, [{ s: env.c.signers()[0], index: 0 }]) };
    expect(codes(await check(env.c, [...msgs, m]))).toContain("timeReversed");
  });

  it("close: nothing may follow", async () => {
    const env = await scout(1);
    const tcl = await env.trail.close();
    await expect(env.trail.append({ kind: "x" })).rejects.toThrow(/closed/);
    const msgs = await trailMsgs(env);
    const { raw, body } = buildTen({ trailId: tcl.logId, s: tcl.s + 1, prior: tcl.d, dt: String(tcl.body.dt), kind: "x", bodySaid: "", refs: [] });
    const m = msgOf("ten", raw, body);
    m.keyRefSig = { ...tcl.keyRefSig!, sigs: await sign(raw, [{ s: env.c.signers()[0], index: 0 }]) };
    const r = await check(env.c, [...msgs, m]);
    expect(r.closed).toBe(true);
    expect(codes(r)).toContain("afterClose");
  });
});

describe("epochs and rotation", () => {
  it("rotation seals trails; entries continue under the new key", async () => {
    const env = await scout(3);
    const rot = await env.c.rotate();
    expect(rot.body.a).toEqual([env.trail.ref()]);
    await env.trail.append({ kind: "after" });
    const r = await check(env.c, await trailMsgs(env));
    expect(r.problems).toEqual([]);
    expect(r.entries[3].anchoredBy).toBe(1);
    expect(r.entries[4].keyState.estSn).toBe(1);
  });

  it("epoch monotonic: an entry under key state 0 after one under key state 1 fails staleKeyState", async () => {
    const env = await scout(2);
    const old = env.c.signers()[0];
    const st0 = env.c.state();
    await env.c.rotate();
    const e3 = await env.trail.append({ kind: "new" });
    const { raw, body } = buildTen({ trailId: env.trail.id, s: 4, prior: e3.entry.d, dt: String(e3.entry.body.dt), kind: "old", bodySaid: "", refs: [] });
    const m = msgOf("ten", raw, body);
    m.keyRefSig = { aid: env.c.aid, estSn: st0.estSn, estSaid: st0.estSaid, sigs: await sign(raw, [{ s: old, index: 0 }]) };
    const r = await check(env.c, [...(await trailMsgs(env)), m]);
    expect(codes(r)).toContain("staleKeyState");
  });

  it("rotation seals trails: a hand-built rotation without seals flags unsealedRotation", async () => {
    const env = await scout(2);
    const st = env.c.state();
    const n = env.cold.release(1, 1);
    const { raw, body } = buildRot({ aid: env.c.aid, s: st.sn + 1, prior: st.said, keys: [keyQb64(n[0])], kt: 1, next: [nextKeyDigest("z")], nt: 1, bt: 0, cuts: [], adds: [] });
    const rot = msgOf("rot", raw, body);
    rot.controllerSigs = await sign(raw, [{ s: n[0], index: 0 }]);
    const kel = await verifyKel([...env.c.kelMessages(), rot], loose);
    expect(kel.ok).toBe(true);
    const r = await verifyTrail({ kel, stream: await trailMsgs(env) }, loose);
    expect(codes(r)).toContain("unsealedRotation");
  });

  it("recovery after key theft: entries by the stolen key after the seal are cut", async () => {
    const env = await scout(8);
    // the attacker copies the hot key and the logs
    const stolen = new MemoryStore((env.store as MemoryStore).dump());
    const attacker = await Controller.load(env.c.aid, { hot: env.c.signers(), store: stolen, clock: env.clock });
    await attacker.trail(env.trail.id).append({ kind: "agent/tool-call", body: { evil: 1 } });
    await attacker.trail(env.trail.id).append({ kind: "agent/tool-call", body: { evil: 2 } });
    const badIxn = await attacker.checkpointNow();
    // the principal (here, the controller with its cold keys) rotates, superseding the attacker's ixn and sealing entry 8
    const before = env.c.kelMessages();
    const rot = await env.c.rotate({ cutAfter: { [env.trail.id]: 8 } });
    expect(rot.s).toBe(badIxn.s);
    const kel = await verifyKel([...before, badIxn, rot], loose);
    expect(kel.problems).toEqual([]);
    expect(kel.superseded).toEqual([{ s: badIxn.s, d: badIxn.d, by: rot.d }]);
    expect(kel.evidence).toEqual([]);
    // Scout continues with a new entry 9
    const { entry: new9 } = await env.trail.append({ kind: "agent/tool-call", body: { good: 9 } });
    expect(new9.s).toBe(9);
    const attackerMsgs = (await stolen.range(env.trail.id, 9)).map((m) => fromStream(m.raw + m.attachments).messages[0]);
    const honest = await trailMsgs(env);
    const stream = [...honest.slice(0, 9), ...attackerMsgs, new9];
    const r = await verifyTrail({ kel, stream }, loose);
    expect(r.problems).toEqual([]);
    expect(r.evidence).toEqual([]); // recovery is not duplicity
    const cut = r.entries.filter((e) => e.status === "cut");
    expect(cut.map((e) => e.s)).toEqual([9, 10]);
    expect(cut.every((e) => e.cutBy === rot.s)).toBe(true);
    expect(r.head).toEqual({ s: 9, d: new9.d });

    // the old key, later: another entry 9 under the retired key is cut too
    const st0 = kel.states[0];
    const { raw, body } = buildTen({ trailId: env.trail.id, s: 9, prior: honest[8].d, dt: env.clock.iso(), kind: "forged", bodySaid: "", refs: [] });
    const forged = msgOf("ten", raw, body);
    forged.keyRefSig = { aid: env.c.aid, estSn: st0.estSn, estSaid: st0.estSaid, sigs: await sign(raw, [{ s: attacker.signers()[0], index: 0 }]) };
    const r2 = await verifyTrail({ kel, stream: [...honest.slice(0, 9), forged] }, loose);
    expect(r2.entries.find((e) => e.d === forged.d)?.status).toBe("cut");
  });
});

describe("historical signatures", () => {
  async function signBytes(c: Controller, bytes: Uint8Array): Promise<KeyRefSig> {
    const st = c.state();
    const { sig } = await signWith(c.signers()[0], bytes);
    return { aid: c.aid, estSn: st.estSn, estSaid: st.estSaid, sigs: [{ code: "A", index: 0, ondex: 0, sig }] };
  }

  it("capture after rotation: valid, not current, retired at 1, anchored before retirement", async () => {
    const env = await incept("camera");
    const captures = await env.c.openTrail("device/captures");
    const photoA = utf8("photo A manifest");
    const sigA = await signBytes(env.c, photoA);
    await captures.append({ kind: "device/capture", refs: [{ d: digest(photoA) }] });
    await env.c.rotate();
    const photoB = utf8("photo B manifest");
    const sigB = await signBytes(env.c, photoB);
    await captures.append({ kind: "device/capture", refs: [{ d: digest(photoB) }] });
    await env.c.rotate();
    const b = await exportBundle(env.store, env.c.aid);
    const v = await verifyBundle(b, loose);
    expect(v.problems).toEqual([]);
    const a = await verifySignature({ bytes: photoA, sig: sigA, kel: v.kel, trails: v.trails }, loose);
    expect(a).toMatchObject({ valid: true, current: false, retiredAt: 1, anchoredBeforeRetirement: true, disputed: false });
    expect(a.anchored).toEqual({ trailId: captures.id, s: 1 });
    const bb = await verifySignature({ bytes: photoB, sig: sigB, kel: v.kel, trails: v.trails }, loose);
    expect(bb).toMatchObject({ valid: true, current: false, retiredAt: 2, anchoredBeforeRetirement: true });
  });

  it("retired key forgery: valid signature, not anchored before retirement", async () => {
    const env = await incept("camera2");
    await env.c.openTrail("device/captures");
    const oldSigner = env.c.signers()[0];
    const st0 = env.c.state();
    await env.c.rotate();
    const bytes = utf8("photo C, made later with the old key");
    const { sig } = await signWith(oldSigner, bytes);
    const v = await verifyBundle(await exportBundle(env.store, env.c.aid), loose);
    const r = await verifySignature({ bytes, sig: { aid: env.c.aid, estSn: st0.estSn, estSaid: st0.estSaid, sigs: [{ code: "A", index: 0, ondex: 0, sig }] }, kel: v.kel, trails: v.trails }, loose);
    expect(r).toMatchObject({ valid: true, current: false, retiredAt: 1, anchoredBeforeRetirement: false });
  });

  it("anchoring in a KEL interaction event counts too (capture batch roots)", async () => {
    const env = await incept("camera3");
    const bytes = utf8("manifest");
    const sig = await signBytes(env.c, bytes);
    const root = new Uint8Array(32).fill(9);
    await env.c.interact([{ d: digest(bytes) }, { d: nextKeyDigest("x") }]);
    await env.c.rotate();
    const kel = await verifyKel(env.c.kelMessages(), loose);
    const r = await verifySignature({ bytes, sig, kel }, loose);
    expect(r.anchoredBeforeRetirement).toBe(true);
    expect(r.anchored).toEqual({ kelSn: 1 });
    void root;
  });

  it("a wrong signature is invalid", async () => {
    const env = await incept("camera4");
    const sig = await signBytes(env.c, utf8("a"));
    const kel = await verifyKel(env.c.kelMessages(), loose);
    const r = await verifySignature({ bytes: utf8("b"), sig, kel });
    expect(r.valid).toBe(false);
    expect(codes(r)).toContain("signatureInvalid");
  });
});
