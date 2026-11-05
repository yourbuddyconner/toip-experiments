import { describe, expect, it } from "vitest";
import { DemoClock } from "../src/clock";
import { identityFromSeed, seedFrom } from "../src/identity";
import { issueCredential, verifyCredential, type Credential } from "../src/credentials";
import { StatusList, checkStatus } from "../src/statusList";

const issuer = identityFromSeed(seedFrom("c/issuer"));
const other = identityFromSeed(seedFrom("c/other"));
const subject = identityFromSeed(seedFrom("c/subject"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function vc(clock: DemoClock, validUntil?: string): Credential {
  return issueCredential(issuer, clock, {
    type: ["VerifiableCredential", "TestCredential"],
    credentialSubject: { id: subject.did, vehicle: "Blue 2014 Honda Fit" },
    credentialStatus: { type: "BitstringStatusListEntry", statusListIndex: 3, statusListCredential: `${issuer.did}#status` },
    ...(validUntil ? { validUntil } : {}),
  });
}

describe("credentials", () => {
  it("verifies when untouched", async () => {
    const clock = new DemoClock("2026-11-05T14:30:00Z");
    const c = vc(clock);
    expect(c.issuer).toBe(issuer.did);
    expect(await verifyCredential(c, clock)).toEqual({ ok: true });
  });

  it("fails on an edited claim", async () => {
    const clock = new DemoClock("2026-11-05T14:30:00Z");
    const c = clone(vc(clock));
    c.credentialSubject.vehicle = "Red Ferrari";
    expect(await verifyCredential(c, clock)).toEqual({ ok: false, failure: "signatureInvalid" });
  });

  it("fails on an edited status index", async () => {
    const clock = new DemoClock("2026-11-05T14:30:00Z");
    const c = clone(vc(clock));
    c.credentialStatus!.statusListIndex = 9;
    expect(await verifyCredential(c, clock)).toEqual({ ok: false, failure: "signatureInvalid" });
  });

  it("fails when the issuer is swapped", async () => {
    const clock = new DemoClock("2026-11-05T14:30:00Z");
    const c = clone(vc(clock));
    c.issuer = other.did;
    expect(await verifyCredential(c, clock)).toEqual({ ok: false, failure: "issuerMismatch" });
  });

  it("expires", async () => {
    const clock = new DemoClock("2026-11-05T14:30:00Z");
    const c = vc(clock, "2026-11-05T15:30:00.000Z");
    clock.advance(2 * 3600_000);
    expect(await verifyCredential(c, clock)).toEqual({ ok: false, failure: "expired" });
  });
});

describe("status list", () => {
  it("allocates, revokes, signs and checks freshness", async () => {
    const clock = new DemoClock("2026-11-05T14:30:00Z");
    const list = new StatusList();
    expect(list.allocate()).toBe(0);
    expect(list.allocate()).toBe(1);
    list.revoke(1);
    expect(list.isRevoked(1)).toBe(true);
    const doc = list.sign(issuer, clock);
    expect(await checkStatus(doc, 1, issuer.did, clock)).toEqual({ signatureValid: true, revoked: true, ageSeconds: 0 });
    expect((await checkStatus(doc, 0, issuer.did, clock)).revoked).toBe(false);
    clock.advance(601_000);
    expect((await checkStatus(doc, 0, issuer.did, clock)).ageSeconds).toBeGreaterThan(600);
    const forged = list.sign(other, clock);
    expect((await checkStatus(forged, 0, issuer.did, clock)).signatureValid).toBe(false);
  });

  it("detects a flipped bit", async () => {
    const clock = new DemoClock("2026-11-05T14:30:00Z");
    const list = new StatusList();
    list.allocate();
    list.revoke(0);
    const doc = clone(list.sign(issuer, clock));
    doc.bits = new StatusList().sign(issuer, clock).bits;
    expect((await checkStatus(doc, 0, issuer.did, clock)).signatureValid).toBe(false);
  });
});
