/**
 * The audit trail (design §13, §15): an entry for every tool call and decision; the spend's decision is
 * receipted before the checkout; the trail verifies for the principal; tampering, dropping and second versions
 * are detected; a presentation's trailRef resolves; the export bundle verifies offline.
 */
import { describe, expect, it } from "vitest";
import { checkTrailRef, Controller, fromStream, MemoryStore, signerFromIdentity, toStream, verifyBundle, type Bundle } from "@toip-tools/eventlog";
import { jcsHash } from "@toip-tools/mandates";
import { runSession } from "../src/loop/loop";
import { ScriptedModel } from "../src/loop/scripted";
import { fixture, people, trailBodies } from "./helpers";

async function hiredFixture() {
  const f = await fixture();
  const q = await f.quote({ worker: people.coder, units: 20 });
  const steps = [
    { call: () => [{ name: "whoami", input: {} }] },
    { call: () => [{ name: "check_mandate", input: { quote: q } }] },
    { call: () => [{ name: "hire", input: { quote: q, justification: "fits" } }] },
    { call: () => [{ name: "finish", input: { summary: "hired" } }] },
  ];
  const r = await runSession({ model: new ScriptedModel({ name: "audit", steps }), guard: f.guard, role: "hirer", system: "s", task: "t" });
  await f.sink.flush();
  return { f, r, q };
}

describe("the audit trail", () => {
  it("has an entry for every model turn, tool call, result and decision", async () => {
    const { f, r } = await hiredFixture();
    const bodies = await trailBodies(f.sink);
    const count = (k: string) => bodies.filter((b) => b.kind === k).length;
    expect(count("agent/session-start")).toBe(1);
    expect(count("agent/session-end")).toBe(1);
    expect(count("agent/model-turn")).toBe(r.turns);
    expect(count("agent/tool-call")).toBe(4);
    expect(count("agent/tool-result")).toBe(4);
    // offer (allow), check_mandate (dry run), hire (allow, witnessed)
    const decisions = bodies.filter((b) => b.kind === "agent/mandate-decision");
    expect(decisions.map((d) => [d.body.action.type, d.body.outcome, !!d.body.dryRun])).toEqual([
      ["agents/job/offer", "allow", false],
      ["settle/pay", "allow", true],
      ["settle/pay", "allow", false],
    ]);
    expect(count("agent/budget")).toBe(1);
    expect(bodies.some((b) => b.kind === "agent/payment" && b.body.event === "checkout")).toBe(true);
    // The tool result for hire names its decision entry.
    const hireResult = bodies.find((b) => b.kind === "agent/tool-result" && b.body.tool === "hire")!;
    expect(hireResult.body.decision.s).toBe(decisions[2].s);
  });

  it("verifies for the principal, and the export bundle verifies offline", async () => {
    const { f } = await hiredFixture();
    const bundle = await f.sink.bundle();
    const online = await verifyBundle(bundle, { expectDid: people.ops.did, witnesses: [f.witnessClient] });
    expect(online.ok).toBe(true);
    expect(online.witnessChecked).toBe(true);
    const offline = await verifyBundle(JSON.parse(JSON.stringify(bundle)), { expectDid: people.ops.did });
    expect(offline.ok).toBe(true);
    expect(offline.trails[0].entries.every((e) => e.receipts.length >= 1)).toBe(true);
  });

  it("detects a changed body, a changed header, and a dropped entry", async () => {
    const { f } = await hiredFixture();
    const bundle = await f.sink.bundle();
    const changedBody = structuredClone(bundle) as Bundle;
    const b = changedBody.trails[0].bodies!.find((x) => (x as any).action?.type === "settle/pay")! as any;
    b.action.attrs.price = "1";
    expect((await verifyBundle(changedBody, { expectDid: people.ops.did })).ok).toBe(false);

    const changedHeader = structuredClone(bundle) as Bundle;
    changedHeader.trails[0].stream = changedHeader.trails[0].stream.replace('"k":"agent/budget"', '"k":"agent/budgex"');
    expect((await verifyBundle(changedHeader, { expectDid: people.ops.did })).ok).toBe(false);

    const dropped = structuredClone(bundle) as Bundle;
    const msgs = fromStream(dropped.trails[0].stream).messages;
    const victim = msgs.find((m) => m.t === "ten" && m.s === 5)!;
    dropped.trails[0].stream = toStream(msgs.filter((m) => !(m.t === "ten" && m.s === victim.s) && !(m.t === "trc" && m.s === victim.s)));
    const r = await verifyBundle(dropped, { expectDid: people.ops.did, witnesses: [f.witnessClient] });
    expect(r.ok).toBe(false);
  });

  it("a second version of an entry is reported as duplicity by the principal's witness", async () => {
    const { f } = await hiredFixture();
    // Someone with the agent's key starts a second history from a copy of its store.
    const copy = new MemoryStore((f.sink.store as MemoryStore).dump());
    const twin = await Controller.load(f.sink.aid, { hot: [signerFromIdentity(people.ops)], store: copy, clock: f.clock });
    const head = f.sink.trail.head();
    await f.sink.append("agent/report", { text: "the real next entry" });
    await f.sink.flush();
    await twin.trail(f.sink.trailId).append({ kind: "agent/report", body: { text: "a different next entry" } });
    const report = await twin.publish([f.witnessClient]);
    expect(report.evidence.length + (await f.witness.evidence()).length).toBeGreaterThan(0);
    expect(head.s).toBeGreaterThan(0);
  });

  it("a presentation's trailRef resolves at the witness to the decision for its action", async () => {
    const { f } = await hiredFixture();
    const p = f.settle.checkoutCalls[0].attachments.presentation;
    const r = await checkTrailRef(p.trailRef, f.witnessClient);
    expect(r.ok).toBe(true);
    expect(r.entry!.body.k).toBe("agent/mandate-decision");
    const bodies = await trailBodies(f.sink);
    const entry = bodies.find((b) => b.s === p.trailRef.s)!;
    expect(entry.body.actionHash).toBe(jcsHash(p.action));
    expect(entry.body.actionHash).toBe(p.actionHash);
  });
});
