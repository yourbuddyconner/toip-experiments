/**
 * The ten demo steps, run in order over real HTTP witnesses. Each attack must be detected, and explained.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromB64u } from "@toip-tools/trust-core";
import { decodeKeyRefSig, fromStream, verifyBundle, verifyEvidence, verifyKel, verifySignature } from "@toip-tools/eventlog";
import { runNext } from "../src/steps";
import { buildView, type IdentifierView } from "../src/view";
import { World } from "../src/world";

let w: World;
const scoutView = async (): Promise<IdentifierView> =>
  (await buildView(await w.adaBundle(w.state.scout!.aid), { names: w.names(), witnesses: w.clients([1, 2, 3, 4]), evidence: (await w.evidence()).map((x) => x.evidence) })).view;
const text = (r: { lines: { text: string }[] }) => r.lines.map((l) => l.text).join("\n");

beforeAll(async () => {
  w = await World.open();
});
afterAll(async () => {
  await w.close();
});

describe("the demo, step by step", () => {
  it("1. birth: three witnesses, two required, Ada's rotation key, a DID binding; the KEL has 3/3 receipts", async () => {
    const r = await runNext(w, 1);
    expect(r.title).toBe("Birth");
    const v = await scoutView();
    expect(v.kel.map((e) => [e.t, e.receipts.length])).toEqual([
      ["icp", 3],
      ["ixn", 3],
    ]);
    expect(v.states[0]).toMatchObject({ kt: 1, nt: 1, bt: 2 });
    expect(v.states[0].next).toHaveLength(2);
    expect(v.states[0].next[1]).toBe(w.adaCold.commit(1, 1)[0]);
    expect(v.bindings).toEqual([{ did: w.scoutId.did, ok: true, sealedAt: 1 }]);
    expect(v.kel[1].notes).toContain("seals the DID binding");
  });

  it("2. work: seven entries, all valid 3/3, a checkpoint at KEL 2, and Ada's endorsement", async () => {
    await runNext(w, 2);
    const v = await scoutView();
    const t = v.trails[0];
    expect(t.entries).toHaveLength(8);
    expect(t.entries.map((e) => e.kind)).toEqual([
      "trail opened: agent/actions",
      "agent/mandate-accepted",
      "agent/tool-call",
      "agent/tool-call",
      "agent/message-sent",
      "agent/approval-requested",
      "agent/approval-granted",
      "agent/payment-intent",
    ]);
    expect(t.entries.every((e) => e.chip === "valid 3/3")).toBe(true);
    expect(t.entries[7].anchoredBy).toBe(2);
    expect(t.entries[6].endorsements.map((e) => e.name)).toEqual(["Ada"]);
    expect(t.entries.every((e) => e.body?.ok ?? e.s === 0)).toBe(true);
    expect(t.entries.flatMap((e) => e.flags)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.witnessChecked).toBe(true);
  });

  it("3. Ada reviews: every check passes, and the bundle is witness-checked", async () => {
    const r = await runNext(w, 3);
    expect(r.lines.every((l) => l.tone !== "bad")).toBe(true);
    expect(text(r)).toMatch(/witness-checked/);
    const review = w.state.samples.find((s) => s.id === "review")!;
    const v = await verifyBundle(review.bundle, { expectDid: w.scoutId.did, witnesses: w.clients([1, 2, 3]) });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.witnessChecked).toBe(true);
  });

  it("4. tamper: bodyMismatch, then saidMismatch, then signatureInvalid, then sealMismatch, each at entry 7", async () => {
    const r = await runNext(w, 4);
    const at7 = async (id: string) => {
      const b = w.state.samples.find((s) => s.id === id)!.bundle;
      const v = await verifyBundle(b, { witnesses: w.clients([1, 2, 3]) });
      expect(v.ok).toBe(false);
      return v.problems.filter((p) => p.s === 7).map((p) => p.code);
    };
    expect(await at7("tamper-1")).toEqual(["bodyMismatch"]);
    expect(await at7("tamper-2")).toContain("saidMismatch");
    expect(await at7("tamper-3")).toContain("signatureInvalid");
    expect(await at7("tamper-4")).toContain("sealMismatch");
    expect(r.lines.filter((l) => l.tone === "bad")).toHaveLength(4);
    // the explorer explains each
    const { view } = await buildView(w.state.samples.find((s) => s.id === "tamper-3")!.bundle, { names: w.names() });
    const row = view.trails[0].entries.find((e) => e.s === 7 && e.status === "rejected")!;
    expect(row.checks.find((c) => c.label === "signatureInvalid")?.detail).toMatch(/doesn't verify/);
  });

  it("5. fork: the witnesses refuse a second entry 6; the supplier's watcher holds both and Ada verifies the evidence", async () => {
    const r = await runNext(w, 5);
    expect(r.lines.filter((l) => /refuses the second entry 6/.test(l.text))).toHaveLength(3);
    const st = w.state.scout!;
    const supplierEv = (await w.supplierWatcher.evidence(st.trailId)).filter((e) => e.kind === "controller" && e.s === 6);
    expect(supplierEv.length).toBeGreaterThanOrEqual(1);
    for (const n of [1, 2, 3]) expect((await w.witness(n).witness.evidence(st.trailId)).some((e) => e.kind === "controller" && e.s === 6)).toBe(true);
    const kel = await verifyKel(await w.client(1).query({ logId: st.aid }));
    expect(await verifyEvidence(supplierEv[0], kel)).toBe(true);
    const v = await scoutView();
    const ev = v.evidence.find((e) => e.kind === "controller" && e.s === 6)!;
    expect(ev.verified).toBe(true);
    expect(ev.diff.map((d) => d.field)).toEqual(expect.arrayContaining(["d", "k", "a"]));
    expect(v.trails[0].entries.find((e) => e.s === 6)!.duplicity).toBe(true);
    // the witnesses' trunk is still the first version
    expect((await w.witness(1).store.get(st.trailId, 6))?.d).toBe(v.trails[0].entries.find((e) => e.s === 6)!.d);
  });

  it("6. rogue witness: witness 3 is convicted, Scout too, and Ada rotates witness 3 out with her key alone", async () => {
    await runNext(w, 6);
    const v = await scoutView();
    const wit = v.evidence.find((e) => e.kind === "witness" && e.s === 8)!;
    expect(wit.witness?.name).toBe("Witness 3");
    expect(wit.verified).toBe(true);
    expect(v.evidence.find((e) => e.kind === "controller" && e.s === 8)?.verified).toBe(true);
    // the rotation: KEL 3, by Ada's key, removing witness 3, adding witness 4, sealing version A of entry 8
    const rot = v.kel.find((e) => e.s === 3)!;
    expect(rot.t).toBe("rot");
    expect(rot.notes).toEqual(expect.arrayContaining(["removes Witness 3", "adds Witness 4", `seals trail ${v.trails[0].id.slice(0, 8)}… at entry 8`]));
    expect(v.states[1].keys.map((k) => k.name)).toEqual(["Ada's rotation key 1", "Scout key 1"]);
    expect(v.states[1].witnesses.map((x) => x.name)).toEqual(["Witness 1", "Witness 2", "Witness 4"]);
    expect(v.states[0].retiredAt).toBe(3);
    const a8 = v.trails[0].entries.find((e) => e.s === 8 && e.status !== "cut")!;
    expect(JSON.parse(a8.raw).d).toBe(a8.d);
    expect(a8.body?.json.amount).toBe("340.00");
    expect(a8.anchoredBy).toBe(3);
    expect(v.trails[0].problems.filter((p) => p.code === "sealMismatch")).toEqual([]);
  });

  it("7. key theft: Ada's watcher flags the thief's tool calls; the recovery supersedes her checkpoint and cuts entries 9 and 10", async () => {
    const r = await runNext(w, 7);
    expect(text(r)).toMatch(/flags entries 9 and 10/);
    const v = await scoutView();
    const t = v.trails[0];
    const cut = t.entries.filter((e) => e.status === "cut");
    expect(cut.map((e) => [e.s, e.cutBy])).toEqual([
      [9, 4],
      [10, 4],
    ]);
    expect(cut[0].checks.find((c) => c.label === "Key epoch")?.detail).toMatch(/cut by recovery/);
    const superseded = v.kel.find((e) => e.status === "superseded")!;
    expect(superseded).toMatchObject({ s: 4, t: "ixn" });
    expect(v.kel.find((e) => e.s === 4 && e.t === "rot")?.status).toBe("valid");
    const new9 = t.entries.find((e) => e.s === 9 && e.status === "valid")!;
    expect(new9.epoch).toBe(4);
    expect(new9.receipts.map((x) => x.name).sort()).toEqual(["Witness 1", "Witness 4"]);
    expect(t.head?.d).toBe(new9.d);
    // recovery is not duplicity
    expect(v.evidence.filter((e) => e.s >= 9)).toEqual([]);
    expect(v.kel.length).toBe(6);
  });

  it("8. the old key, later: Mallory's entry 9 for Bram is cut once checked against the witnesses' KEL", async () => {
    await runNext(w, 8);
    const sample = w.state.samples.find((s) => s.id === "mallory")!;
    const offline = await verifyBundle(sample.bundle);
    const f9 = offline.trails[0].entries.find((e) => e.s === 9)!;
    expect(f9.status).toBe("pending");
    expect(offline.kel.latest.sn).toBe(3);
    const online = await verifyBundle(sample.bundle, { witnesses: w.clients([1, 2, 4]) });
    expect(online.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["truncated", "duplicity"]));
    // in Ada's view it's kept, struck through
    const v = await scoutView();
    const forged = v.trails[0].entries.find((e) => e.d === f9.d)!;
    expect(forged.status).toBe("cut");
    expect(forged.cutBy).toBe(4);
  });

  it("9. camera: photos A and B verify across the rotation; photo C, by the retired key, is not anchored before retirement", async () => {
    await runNext(w, 9);
    const r = await verifyBundle(await w.adaBundle(w.state.camera!.aid), { witnesses: w.clients([1, 2, 4]) });
    expect(r.problems).toEqual([]);
    const [a, b, c] = await Promise.all(w.state.captures.map((cap) => verifySignature({ bytes: fromB64u(cap.bytes), sig: decodeKeyRefSig(cap.sig), kel: r.kel, trails: r.trails })));
    expect(a).toMatchObject({ valid: true, current: false, retiredAt: 1, anchoredBeforeRetirement: true, disputed: false });
    expect(a.witnessedBy).toBeTruthy();
    expect(b).toMatchObject({ valid: true, current: true, anchoredBeforeRetirement: true });
    expect(c).toMatchObject({ valid: true, current: false, retiredAt: 1, anchoredBeforeRetirement: false });
    expect(r.kel.latest.keys[0].startsWith("1AAJ")).toBe(true);
  });

  it("10. KERIpy computes the same key state, or the step says clearly that it was skipped", async () => {
    const r = await runNext(w, 10);
    const k = w.state.keripy!;
    if (!k.ran) {
      expect(text(r)).toMatch(/skipped: no Python with KERIpy/);
      console.log(`KERIpy step skipped: ${k.reason}`);
      return;
    }
    expect(k.matches?.map((m) => [m.label, m.ok])).toEqual([
      ["Scout", true],
      ["Camera K-7", true],
    ]);
    expect(k.matches![0].ours.s).toBe(4);
  });

  it("the demo is finished, and no step runs twice", async () => {
    await expect(runNext(w)).rejects.toThrow(/finished/);
    expect(w.state.reports.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // every witness's stream for Scout's KEL parses cleanly
    for (const n of [1, 2, 4]) expect(fromStream(await w.client(n).query({ logId: w.state.scout!.aid })).problems).toEqual([]);
  });
});
