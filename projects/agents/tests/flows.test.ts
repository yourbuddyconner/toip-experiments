/**
 * The hiring flows end to end (design §10, §15), over a real relay and the Settle platform on its local cluster,
 * with scripted models: agent → agent with CI as attester; agent → human with escalation and approval; review;
 * revocation; CI failing first; a rogue hirer refused by an honest worker.
 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyBundle } from "@zk-toip/eventlog";
import { identityFromSeed } from "@zk-toip/trust-core";
import { createWorld, type World } from "../src/world";
import { runStory, waitFor } from "../src/story";
import { coderScript } from "../src/roles/scripts";
import { ERRANDS_TASK_2 } from "../src/roles/prompts";
import { USDC } from "../src/config";

const ports = { app: 0, hub: 0, settle: 0, relay: 0, rpc: 0 };
const quiet = { step: () => {}, line: () => {}, say: () => {}, errandsTask: ERRANDS_TASK_2 };
let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

describe("the demo's flows on a local Settle network", () => {
  it("hires an agent (CI attests), refuses an injection, hires a human (escalation, approval), reviews and revokes", async () => {
    world = await createWorld({ ports, courier: "auto" });
    const w = world;
    await runStory(w, quiet);

    // Coder agent was paid 20 USDC once CI passed; the release needed both parties' signatures.
    const coderPay = w.coder.party.list().find((p) => p.role === "payee" && p.settled);
    expect(coderPay?.settled?.payeeUnits).toBe(USDC(20).toString());
    expect(w.ci.runs.map((r) => r.passed)).toEqual([true]);
    expect(coderPay!.attestations.some((a) => a.issuer === w.ci.party.did && a.claim === "complete")).toBe(true);

    // QuickFix got nothing; no checkout ever went to it.
    expect([...w.ops.party.checkouts.values()].some((c) => c.link.issuer === w.quickfix.party.did)).toBe(false);
    expect(w.quickfix.party.payments.size).toBe(0);

    // Dana was paid 45 USDC, after Conner's approval and his "package received".
    const danaPay = w.dana.party.list().find((p) => p.role === "payee" && p.settled);
    expect(danaPay?.settled?.payeeUnits).toBe(USDC(45).toString());
    expect([...w.principal.approvals.values()].map((a) => a.state)).toEqual(["approved"]);
    const rec = w.dana.gates.byTerms(require_terms(danaPay));
    expect(rec?.presentation.chain).toHaveLength(2);
    expect(rec?.presentation.approvals).toHaveLength(1);
    expect(rec?.trailChecked).toBe(true);
    expect(w.dana.behind(danaPay!.id)).toMatch(/Chain of 2 verified, approval by Conner Swann, root verified/);

    // Money: Ops paid 20.50 and funded 60; Errands paid 45.50 of its 60. Its wallet was the ceiling.
    expect(await w.ops.party.walletBalance()).toBe(USDC(150 - 20.5 - 60));
    expect(await w.errands.party.walletBalance()).toBe(USDC(60 - 45.5));
    expect(w.ops.guard.ledger.spent(w.ops.guard.chain[0].id, Date.now()).P1D).toBe(USDC(80.5).toString());

    // The principal's review verified both trails, receipted by its own witness and the hub.
    for (const a of [w.ops, w.errands]) {
      const v = w.principal.audits.get(a.did)!;
      expect(v.ok).toBe(true);
      expect(v.banner).toMatch(/chain intact, receipted by you \(\d+\) and the hub \(\d+\), no duplicity/);
      // Every settle/pay that went ahead had an allow decision with a receipt.
      const pays = v.entries.filter((e) => e.kind === "agent/mandate-decision" && (e.body as any)?.action?.type === "settle/pay" && (e.body as any)?.outcome === "allow" && !(e.body as any)?.dryRun);
      expect(pays.length).toBeGreaterThanOrEqual(1);
      for (const e of pays) expect(e.receipts.length).toBeGreaterThanOrEqual(1);
      const checkout = v.entries.find((e) => e.kind === "agent/payment" && (e.body as any)?.event === "checkout")!;
      expect(checkout.s).toBeGreaterThan(pays[0].s);
      const offline = await verifyBundle(JSON.parse(JSON.stringify(v.bundle)), { expectDid: a.did });
      expect(offline.ok).toBe(true);
    }

    // Revocation propagated: Errands' guard knows, and its next errand was refused for it.
    expect(w.errands.guard.revoked).toBe(true);
    expect(w.errands.sessions[1].reason).toBe("finished");
    expect(w.principal.reports.at(-1)!.text).toMatch(/revoked/);
    const status = await w.status.get(`${w.ops.did}#status`);
    expect(status).toBeTruthy();
  });

  it("CI fails first, then passes on a second delivery, and only then pays", async () => {
    world = await createWorld({ ports, courier: "auto", scripts: { coder: [coderScript({ brokenFirst: true })] } });
    const w = world;
    await w.issueOpsMandate();
    await w.fundOps();
    await w.giveOpsTask();
    const paid = await waitFor("Coder agent to be paid", () => w.coder.party.list().find((p) => p.role === "payee" && p.settled), 120_000);
    expect(w.ci.runs.map((r) => r.passed)).toEqual([false, true]);
    expect(paid.attestations.map((a) => a.claim)).toEqual(["not-complete", "complete"]);
    expect(paid.settled!.payeeUnits).toBe(USDC(20).toString());
  });

  it("a rogue hirer that skips its guard is refused by Dana's device: no invoice, and it's told why", async () => {
    world = await createWorld({ ports, courier: "manual" });
    const w = world;
    const rogue = await w.api.party({ identity: identityFromSeed(crypto.getRandomValues(new Uint8Array(32))), name: "Rogue", policy: (w.ops.party as any).policy });
    await rogue.start();
    try {
      await w.api.addFunds(rogue, USDC(100));
      const link = await w.dana.party.createLink({ title: "A parcel", units: USDC(45), release: "payer-confirms" });
      const c = await rogue.checkout(link);
      await waitFor("Dana's refusal", () => w.dana.refusals.length > 0, 20_000);
      expect(w.dana.refusals[0].reasons[0]).toMatch(/No mandate presentation/);
      await new Promise((r) => setTimeout(r, 500));
      expect(rogue.checkouts.get(c.id)!.status).toBe("contacting");
      expect(rogue.requests.size).toBe(0);
      expect(await rogue.walletBalance()).toBe(USDC(100));
    } finally {
      rogue.stop();
    }
  });
});

import { hex } from "@zk-toip/settle/src/agents/base";
import { termsHash } from "@zk-toip/settle/src/protocol/documents";
function require_terms(p: { terms?: Parameters<typeof termsHash>[0] } | undefined): string {
  if (!p?.terms) throw new Error("no terms");
  return hex(termsHash(p.terms));
}
