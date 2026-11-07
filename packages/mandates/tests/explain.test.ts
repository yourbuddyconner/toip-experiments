import { describe, expect, it } from "vitest";
import { REASON_CODES, explain, hasSentence, type Decision, type Units } from "../src/index";
import { engine, names, payAction, people, twoLinks, usdc, world, zeroSpent } from "./helpers";

const opts = {
  name: (did: string) => names[did] ?? did,
  units: (u: Units, attr: string) => (attr === "spend" || attr === "price" ? `${(Number(u) / 1e6).toFixed(2)} USDC` : String(u)),
  label: (dimension: string) => ({ spendPerTx: "per payment" })[dimension],
  noun: "this payment",
};

async function demo(attrs: Parameters<typeof payAction>[2], o: { revoke?: boolean; spent?: string } = {}) {
  const w = world();
  const chain = await twoLinks(w);
  if (o.revoke) w.connerStatus.revoke(chain[0].credentialStatus);
  return (await engine()).decide({
    chain,
    presenter: people.errands.did,
    action: payAction(w, people.errands.did, attrs),
    state: { mandate: chain[1].id, spent: { P1D: o.spent ?? "0", P7D: o.spent ?? "0", P30D: o.spent ?? "0", total: o.spent ?? "0" } },
    status: w.status(),
    clock: w.clock,
  });
}

describe("explain (§8.3)", () => {
  it("every reason code has a sentence", () => {
    expect(REASON_CODES.length).toBeGreaterThan(30);
    const base: Decision = {
      outcome: "deny",
      reasons: [],
      approver: null,
      actionHash: "sha256:00",
      chain: ["urn:uuid:a"],
      parties: [{ issuer: people.conner.did, subject: people.ops.did }],
      policy: { id: "mandates/check/1", hash: "sha256:00" },
      at: "2026-11-06T10:00:00Z",
    };
    for (const code of REASON_CODES) {
      expect(hasSentence(code), code).toBe(true);
      const ops = code === "constraint.failed" ? ["anyOf", "noneOf", "within", "is", "max", "min"] : [undefined];
      for (const op of ops) {
        const reason = { code, link: 0, dimension: "dim", op, attr: "spend", limit: "5", value: "6", spent: "1", period: "P1D" as const, requirement: "maxLinks", approvable: false };
        const lines = explain({ ...base, reasons: [reason] }, opts);
        expect(lines.length, code).toBeGreaterThan(0);
        for (const l of lines) expect(l, `${code} ${op}`).not.toMatch(/undefined|\[object|NaN/);
      }
    }
    expect(hasSentence("no.such.code")).toBe(false);
    expect(explain({ ...base, reasons: [{ code: "no.such.code", approvable: false }] }, opts)).toEqual(["Refused for a reason this version can't describe: no.such.code.", "This payment can't go ahead."]);
  });

  it("the demo's escalation, in the design's words", async () => {
    const d = await demo({ spend: usdc(45.5), price: usdc(45) });
    expect(d.outcome).toBe("escalate");
    expect(explain(d, opts)).toEqual([
      "45.50 USDC is more than the 30.00 USDC per payment that Conner Swann allowed Ops agent.",
      "45.50 USDC is more than the 30.00 USDC per payment that Ops agent allowed Errands agent.",
      "Conner Swann can approve this payment.",
    ]);
  });

  it("golden sentences for the demo's other cases", async () => {
    expect(explain(await demo({ spend: usdc(45.5), price: usdc(45) }), { ...opts, label: () => undefined }).slice(0, 1)).toEqual([
      "45.50 USDC is more than the limit of 30.00 USDC (spendPerTx) that Conner Swann allowed Ops agent.",
    ]);
    expect(explain(await demo({ spend: usdc(25), price: usdc(24.5) }), opts)).toEqual([
      "This payment is within every limit of the chain from Conner Swann to Errands agent.",
    ]);
    expect(explain(await demo({ spend: usdc(5), attester: people.mallory.did }), opts)).toEqual([
      `The attester “${people.mallory.did}” isn't one Conner Swann allowed Ops agent (attesters).`,
      `The attester “${people.mallory.did}” isn't one Ops agent allowed Errands agent (attesters).`,
      "This payment can't go ahead.",
    ]);
    expect(explain(await demo({ spend: usdc(25) }, { spent: usdc(50) }), opts)).toEqual([
      "Spending 25.00 USDC would bring the total to 75.00 USDC, over the 60.00 USDC budget that Ops agent allowed Errands agent (spendTotal).",
      "This payment can't go ahead.",
    ]);
    expect(explain(await demo({ spend: usdc(5) }, { revoke: true }), opts)).toEqual(["Conner Swann has revoked the mandate to Ops agent.", "This payment can't go ahead."]);
    expect(explain(await demo({ spend: usdc(5), category: "software" }), opts)).toEqual([
      "The category “software” is outside what Conner Swann allowed Ops agent (categories).",
      "The category “software” is outside what Ops agent allowed Errands agent (categories).",
      "Conner Swann can approve this payment.",
    ]);
  });

  it("with no options it still produces sentences, naming DIDs", async () => {
    const d = await demo({ spend: usdc(45.5) });
    const lines = explain(d);
    expect(lines[0]).toBe(`45500000 is more than the limit of 30000000 (spendPerTx) that ${people.conner.did} allowed ${people.ops.did}.`);
    expect(lines.at(-1)).toBe(`${people.conner.did} can approve this action.`);
  });

  it("zeroSpent is a helper, not a decision", () => {
    expect(zeroSpent({ id: "x" } as never).spent.total).toBe("0");
  });
});
