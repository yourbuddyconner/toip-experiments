import { beforeAll, describe, expect, it } from "vitest";
import { SettlePolicy, type PolicyInput } from "../src/protocol/policy";

let policy: SettlePolicy;
beforeAll(async () => {
  policy = await SettlePolicy.load();
});

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  role: "payer",
  now: 1_000_000 + 8 * 86400,
  proposal: { payeeUnits: "340000000" },
  terms: { amountUnits: "340000000", attester: "did:key:tenant", disputeWindowSeconds: 7 * 86400 },
  attestations: [{ issuer: "did:key:tenant", claim: "complete", atSeconds: 1_000_000, verified: true }],
  disputes: [],
  ruling: null,
  ...over,
});

describe("settle/policies/attested-completion/1 (design §8)", () => {
  it("payer signs a full release after attested completion and a quiet window", () => {
    expect(policy.decide(base())).toEqual({ sign: true, reasons: [] });
  });
  it("payer waits for the window", () => {
    expect(policy.decide(base({ now: 1_000_000 + 86400 }))).toEqual({ sign: false, reasons: ["the dispute window hasn't passed"] });
  });
  it("payer needs the attester's own, verified attestation", () => {
    expect(policy.decide(base({ attestations: [] })).reasons).toEqual(["the work hasn't been attested complete"]);
    expect(policy.decide(base({ attestations: [{ issuer: "did:key:mallory", claim: "complete", atSeconds: 1, verified: true }] })).sign).toBe(false);
    expect(policy.decide(base({ attestations: [{ issuer: "did:key:tenant", claim: "complete", atSeconds: 1, verified: false }] })).sign).toBe(false);
  });
  it("payer won't release over an open dispute", () => {
    expect(policy.decide(base({ disputes: [{ issuer: "did:key:landlord" }] }))).toEqual({ sign: false, reasons: ["there is an open dispute"] });
  });
  it("anyone signs exactly the arbiter's ruling, and a partial payout needs one", () => {
    const ruled = { ruling: { payeeUnits: "200000000" }, proposal: { payeeUnits: "200000000" }, disputes: [{ issuer: "x" }] };
    for (const role of ["payer", "payee", "arbiter"] as const) expect(policy.decide(base({ role, ...ruled })).sign).toBe(true);
    expect(policy.decide(base({ proposal: { payeeUnits: "200000000" } }))).toEqual({ sign: false, reasons: ["a partial payout needs an arbiter's ruling"] });
    expect(policy.decide(base({ role: "arbiter", ruling: { payeeUnits: "200000000" } })).reasons).toContain("the arbiter only signs its own ruling");
  });
  it("payee signs a full release, or a full refund only when it chose to cancel", () => {
    expect(policy.decide(base({ role: "payee", attestations: [] })).sign).toBe(true);
    expect(policy.decide(base({ role: "payee", proposal: { payeeUnits: "0" } })).sign).toBe(false);
    expect(policy.decide(base({ role: "payee", proposal: { payeeUnits: "0" }, payeeCancels: true })).sign).toBe(true);
  });
});
