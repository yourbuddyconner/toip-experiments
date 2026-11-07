/**
 * Restarts (design §15): an agent stopped mid-escalation restarts from its snapshot and carries out the
 * approval once, not twice. Its budgets and used approvals survive.
 */
import { describe, expect, it } from "vitest";
import { APPROVAL_GRANT, approve } from "@zk-toip/mandates";
import { Guard } from "../src/guard/guard";
import { USDC } from "../src/config";
import { fixture, people, until, verified } from "./helpers";

describe("restarting from a snapshot", () => {
  it("an agent stopped mid-escalation carries out the approval once after a restart", async () => {
    const f = await fixture();
    const paid = await f.quote({ worker: people.coder, units: 20 });
    expect((await f.guard.hire({ quote: paid, justification: "" })).status).toBe("hired");
    const q = await f.quote({ worker: people.dana, units: 45, release: "principal", category: "physical.errand", credentials: [verified(people.dana, "Dana Ruiz Courier", "physical.errand", f.clock)] });
    expect((await f.guard.hire({ quote: q, justification: "verified courier" })).status).toBe("pending_approval");
    const req = f.settle.endpoint.of("approval/request")[0].payload;

    // The process stops; a new one starts from the snapshot (JSON round trip, as on disk).
    const saved = JSON.parse(JSON.stringify(f.guard.snapshot()));
    f.guard.stopped = true;
    const again = new Guard({ ...f.options, snapshot: saved });
    expect(again.ledger.spent(f.mandate.id, f.clock.now()).total).toBe(USDC(20.5).toString());
    expect(again.pending.get(req.request)?.state).toBe("waiting");

    const approval = approve(people.conner, f.clock, { chain: req.chain, action: req.action, ttlSeconds: 600 });
    await f.settle.endpoint.deliver(APPROVAL_GRANT, { request: req.request, approval }, people.conner.did);
    await until("the checkout", () => f.settle.checkoutCalls.length === 2);
    await f.settle.endpoint.deliver(APPROVAL_GRANT, { request: req.request, approval }, people.conner.did);
    await new Promise((r) => setTimeout(r, 100));
    expect(f.settle.checkoutCalls).toHaveLength(2);

    // And a second restart keeps the approval used.
    const third = new Guard({ ...f.options, snapshot: JSON.parse(JSON.stringify(again.snapshot())) });
    expect(third.ledger.approvalUsed(approval.id)).toBe(true);
    expect(third.ledger.spent(f.mandate.id, f.clock.now()).total).toBe(USDC(66).toString());
    expect(() => new Guard({ ...f.options, identity: people.dana, snapshot: saved })).toThrow(/not this guard's snapshot/);
  });
});
