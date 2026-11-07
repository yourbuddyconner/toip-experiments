/** Passports (design §6.2), the guard's own reason sentences, and mandates in plain words. */
import { describe, expect, it } from "vitest";
import { DemoClock } from "@zk-toip/trust-core";
import { decisionView, GUARD_SENTENCES } from "../src/guard/explain";
import { issuePassport, verifyPassport } from "../src/passport";
import { mandateLines } from "../src/mandate-text";
import { toolsFor, toolsHash } from "../src/loop/tools";
import { fixture, NAMES, people } from "./helpers";

describe("passports", () => {
  it("are the operator's signed claim; a tampered or misdirected one fails", async () => {
    const clock = new DemoClock(new Date().toISOString());
    const p = issuePassport(people.conner, clock, {
      agent: people.ops.did,
      name: "Ops agent",
      description: "",
      operator: { id: people.conner.did, name: "Conner Swann" },
      accountable: { id: people.conner.did, name: "Conner Swann" },
      runtime: { kind: "llm-agent", provider: "anthropic", model: "claude-opus-5-5", toolsHash: toolsHash(toolsFor("hirer")) },
      endpoints: [{ type: "tsp-relay", url: "ws://localhost:4333" }],
      audit: { aid: "E", trail: "E", witnesses: [] },
    });
    const ok = await verifyPassport(p, people.ops.did, clock);
    expect(ok).toMatchObject({ ok: true, model: "claude-opus-5-5", operator: "Conner Swann", provider: "anthropic" });
    expect((await verifyPassport(p, people.errands.did, clock)).ok).toBe(false);
    const t = structuredClone(p);
    (t.credentialSubject as any).runtime.model = "something-else";
    expect((await verifyPassport(t, people.ops.did, clock)).problem).toMatch(/doesn't verify/);
    clock.advance(31 * 86_400_000);
    expect((await verifyPassport(p, people.ops.did, clock)).problem).toMatch(/expired/);
    // Changing a tool changes the hash, so the operator reissues the passport.
    expect(toolsHash(toolsFor("hirer"))).not.toBe(toolsHash(toolsFor("worker")));
  });
});

describe("plain words", () => {
  it("every guard reason has a sentence, and decisions read as sentences", async () => {
    for (const code of Object.keys(GUARD_SENTENCES)) expect(GUARD_SENTENCES[code]({ code, approvable: false, detail: "x" })).toMatch(/\.$/);
    const f = await fixture();
    const lines = mandateLines(f.mandate, (d) => NAMES[d] ?? d).map((l) => l.text);
    expect(lines[0]).toBe("Up to 30.00 USDC per payment; 100.00 USDC per day; 200.00 USDC in total.");
    expect(lines).toContain("Work must be confirmed by Demo CI or Conner Swann.");
    expect(lines.join(" ")).toMatch(/Over a limit \(per payment, per day, categories of work\), Conner Swann can approve one exact action/);
    const v = decisionView(
      { outcome: "escalate", reasons: [{ code: "constraint.failed", link: 0, dimension: "spendPerTx", op: "max", attr: "spend", limit: "30000000", value: "45500000", approvable: true }], approver: people.conner.did, actionHash: "sha256:x", chain: [], parties: [{ issuer: people.conner.did, subject: people.ops.did }], policy: { id: "", hash: "" }, at: "" },
      { name: (d) => NAMES[d] ?? d },
    );
    expect(v.sentences).toEqual(["45.50 USDC is more than the 30.00 USDC per payment that Conner Swann allowed Ops agent.", "Conner Swann can approve this payment."]);
  });
});
