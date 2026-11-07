import { describe, expect, it } from "vitest";
import { DemoClock, identityFromSeed, seedFrom } from "@toip-tools/trust-core";
import { accept, attest, bindPaymentKey, derivePaymentKey, termsHash, verifyAcceptance, verifyBinding, verifySigned, type Terms } from "../src/protocol/documents";

const clock = new DemoClock("2026-11-06T10:00:00Z");
const landlord = identityFromSeed(seedFrom("settle/landlord"));
const joe = identityFromSeed(seedFrom("settle/joe"));
const tenant = identityFromSeed(seedFrom("settle/tenant"));

async function terms(): Promise<Terms> {
  const pk = await derivePaymentKey(landlord, "p1");
  const jk = await derivePaymentKey(joe, "p1");
  return {
    type: "settle/terms",
    version: 1,
    payment: "p1",
    purpose: "Fix kitchen sink leak, Unit 4B",
    payer: { did: landlord.did, paymentKey: pk.address, tokenAccount: pk.address, binding: bindPaymentKey(landlord, pk, "p1", clock) },
    payee: { did: joe.did, paymentKey: jk.address, tokenAccount: jk.address, binding: bindPaymentKey(joe, jk, "p1", clock), credentials: [] },
    arbiter: { did: "did:key:arb", key: pk.address },
    amount: { mint: pk.address, units: "340000000", display: "340.00 USDC" },
    conditions: { policy: "settle/policies/attested-completion/1", attester: tenant.did, disputeWindowSeconds: 604800 },
    fee: { bps: 100, minUnits: "500000", units: "3400000", account: pk.address, to: "did:key:proc" },
    threshold: 2,
    refundAfter: 0,
  };
}

describe("Settle documents (design §4, §6)", () => {
  it("derives the same payment key for the same identity and payment, and a different one otherwise", async () => {
    expect((await derivePaymentKey(joe, "p1")).address).toBe((await derivePaymentKey(joe, "p1")).address);
    expect((await derivePaymentKey(joe, "p1")).address).not.toBe((await derivePaymentKey(joe, "p2")).address);
  });

  it("binds a payment key to a DID, signed by both, and refuses tampering", async () => {
    const k = await derivePaymentKey(joe, "p1");
    const b = bindPaymentKey(joe, k, "p1", clock);
    expect(await verifyBinding(b, { did: joe.did, payment: "p1", key: k.address }, clock)).toBe(true);
    const other = await derivePaymentKey(joe, "p2");
    expect(await verifyBinding({ ...b, key: other.address }, { did: joe.did, payment: "p1", key: other.address }, clock)).toBe(false);
    expect(await verifyBinding(b, { did: landlord.did, payment: "p1", key: k.address }, clock)).toBe(false);
  });

  it("acceptances sign the terms hash, so any change to the terms breaks them", async () => {
    const t = await terms();
    const a = accept(t, joe, clock);
    expect(await verifyAcceptance(a, t, joe.did, clock)).toBe(true);
    expect(await verifyAcceptance(a, { ...t, amount: { ...t.amount, units: "1" } }, joe.did, clock)).toBe(false);
    expect(termsHash(t)).toEqual(termsHash(JSON.parse(JSON.stringify(t))));
  });

  it("attestations are bound to the terms and their issuer", async () => {
    const t = await terms();
    const a = attest(tenant, t, "complete", clock, "Fixed, dry for a day");
    expect(await verifySigned(a, t, tenant.did, clock)).toBe(true);
    expect(await verifySigned(a, t, joe.did, clock)).toBe(false);
    expect(await verifySigned({ ...a, claim: "not-complete" as const }, t, tenant.did, clock)).toBe(false);
  });
});
