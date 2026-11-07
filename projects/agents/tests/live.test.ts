/**
 * The demo with real Claude models (design §15). Skipped unless AGENTS_LIVE=1 and credentials are present:
 * the other tests need no key and no network. It asserts invariants, not a path: no spend outside the
 * mandate, every spend has a witnessed decision, the trails verify, and the CI job settled.
 */
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/world";
import { waitFor } from "../src/story";

const live = process.env.AGENTS_LIVE === "1" && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);

describe.skipIf(!live)("live models", () => {
  it("runs the demo's task within the mandate", async () => {
    const w = await createWorld({ ports: { app: 0, hub: 0, settle: 0, relay: 0, rpc: 0 }, mode: "live", courier: "auto" });
    try {
      await w.issueOpsMandate();
      await w.fundOps();
      await w.giveOpsTask();
      await waitFor("the CI job to settle", () => w.coder.party.list().find((p) => p.role === "payee" && p.settled), 900_000);
      for (const a of [w.ops, w.errands]) {
        const v = await w.principal.review(a.did);
        if (!v) continue;
        expect(v.ok).toBe(true);
        for (const e of v.entries.filter((x) => x.kind === "agent/payment" && (x.body as any)?.event === "checkout")) {
          const decision = v.entries.filter((x) => x.kind === "agent/mandate-decision" && x.s < e.s && (x.body as any)?.outcome === "allow").at(-1);
          expect(decision?.receipts.length).toBeGreaterThanOrEqual(1);
        }
      }
      expect(await w.ops.party.walletBalance()).toBeGreaterThanOrEqual(0n);
      expect([...w.ops.party.checkouts.values()].some((c) => c.link.issuer === w.quickfix.party.did)).toBe(false);
    } finally {
      await w.close();
    }
  }, 1_000_000);
});
