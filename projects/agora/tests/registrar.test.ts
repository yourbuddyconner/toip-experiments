import { beforeAll, describe, expect, it } from "vitest";
import { checkRootLog, commitmentOf, enroll, fieldToHex, initHashing, type GroupRoot } from "@zk-toip/anon-membership";
import { Bus, DemoClock, Endpoint, identityFromSeed, issueCredential, seedFrom, signDocument } from "@zk-toip/trust-core";
import { DemoIssuer, ISSUER_KINDS } from "../src/issuers/issuers";
import { fieldOfText } from "../src/protocol/gate";
import { GROUP_RECEIPT } from "../src/protocol/specs";
import { DAY, HOUR } from "./helpers";

beforeAll(initHashing);

function setup() {
  const clock = new DemoClock("2026-11-06T09:00:00.000Z");
  const bus = new Bus(clock);
  const cascade = new DemoIssuer(ISSUER_KINDS[0], identityFromSeed(seedFrom("reg/cascade")), clock, { statusUrl: "http://x/status" });
  const pine = new DemoIssuer(ISSUER_KINDS[1], identityFromSeed(seedFrom("reg/pine")), clock, { statusUrl: "http://y/status" });
  const ep = new Endpoint({ identity: cascade.identity, transport: bus, clock });
  cascade.serve(ep);
  const ana = identityFromSeed(seedFrom("reg/ana"));
  const anaEp = new Endpoint({ identity: ana, transport: bus, clock });
  const g = cascade.registrar.groupId;
  const join = (secret: bigint, credential: unknown, extra: { replace?: boolean } = {}, who = anaEp) => enroll(who, cascade.did, g, secret, { credential, ...extra });
  const rn = () => cascade.issue(ana.did, { licenseType: "RN", state: "WA", licensedSince: "2019-05-01" });
  return { clock, bus, cascade, pine, ana, anaEp, g, join, rn };
}

describe("joining a group", () => {
  it("admits a current credential holder, with the credential's attributes in the leaf", async () => {
    const { cascade, join, rn, ana } = setup();
    const e = await join(7n, rn());
    expect(e.leaf.attrs[0]).toBe(fieldOfText("RN"));
    expect(e.leaf.attrs[1]).toBe(fieldOfText("WA"));
    expect(e.leaf.registeredDay).toBe(20763);
    expect(e.leaf.validUntilDay).toBe(20763 + 730);
    expect(cascade.registrar.isMember(ana.did)).toBe(true);
  });

  it("refuses forged, expired, revoked, wrong-issuer and wrong-type credentials", async () => {
    const { clock, cascade, pine, ana, join, rn } = setup();
    const forged = { ...rn(), credentialSubject: { id: ana.did, licenseType: "RN", state: "WA", licensedSince: "2019-05-01", extra: 1 } };
    await expect(join(1n, forged)).rejects.toMatchObject({ code: "credentialInvalid" });
    const fromPine = pine.issue(ana.did, { licenseType: "RN", state: "OR", licensedSince: "2019-05-01" });
    await expect(join(1n, fromPine)).rejects.toMatchObject({ code: "wrongIssuer" });
    const wrongType = issueCredential(cascade.identity, clock, { type: ["VerifiableCredential", "ParkingPermit"], credentialSubject: { id: ana.did } });
    await expect(join(1n, wrongType)).rejects.toMatchObject({ code: "wrongType" });
    const short = issueCredential(cascade.identity, clock, {
      type: ["VerifiableCredential", "NursingLicense"],
      credentialSubject: { id: ana.did, licenseType: "RN", state: "WA", licensedSince: "2019-05-01" },
      validUntil: new Date(clock.now() + DAY).toISOString(),
    });
    clock.advance(2 * DAY);
    await expect(join(1n, short)).rejects.toMatchObject({ code: "credentialExpired" });
    const revoked = rn();
    cascade.revokeSubject(ana.did);
    await expect(join(1n, revoked)).rejects.toMatchObject({ code: "credentialRevoked" });
    await expect(join(1n, undefined)).rejects.toMatchObject({ code: "credentialMissing" });
  });

  it("refuses a sender who isn't the credential's subject", async () => {
    const { bus, clock, cascade, join, rn } = setup();
    const mallory = identityFromSeed(seedFrom("reg/mallory"));
    const malEp = new Endpoint({ identity: mallory, transport: bus, clock });
    await expect(join(1n, rn(), {}, malEp)).rejects.toMatchObject({ code: "notSubject" });
    expect(cascade.registrar.size()).toBe(0);
  });

  it("gives one leaf per subject and per credential, and limits rotations to two a year", async () => {
    const { clock, join, rn, cascade, ana } = setup();
    const vc = rn();
    await join(1n, vc);
    await expect(join(2n, vc)).rejects.toMatchObject({ code: "alreadyMember" });
    await expect(join(2n, rn())).rejects.toMatchObject({ code: "alreadyMember" });
    const r1 = await join(2n, vc, { replace: true });
    clock.advance(10 * DAY);
    const r2 = await join(3n, vc, { replace: true });
    expect(r2.leaf.registeredDay).toBe(r1.leaf.registeredDay + 10);
    await expect(join(4n, vc, { replace: true })).rejects.toMatchObject({ code: "rotationLimit" });
    expect(cascade.registrar.size()).toBe(1);
    expect(cascade.registrar.receipt(ana.did)?.leaf.commitment).toBe(fieldToHex(commitmentOf(3n, cascade.registrar.group.groupField)));
    // A year later, rotations are allowed again.
    clock.advance(366 * DAY);
    await join(4n, vc, { replace: true });
    expect(cascade.registrar.receipt(ana.did)?.leaf.commitment).toBe(fieldToHex(commitmentOf(4n, cascade.registrar.group.groupField)));
  });

  it("sends a member their receipt over TSP, and nobody else's", async () => {
    const { anaEp, bus, clock, cascade, join, rn, g } = setup();
    await join(5n, rn());
    const r = await anaEp.request(cascade.did, GROUP_RECEIPT, { group: g });
    expect(r.payload).toMatchObject({ type: "agora/group-receipt", group: g, values: { licenseType: "RN" } });
    const eve = new Endpoint({ identity: identityFromSeed(seedFrom("reg/eve")), transport: bus, clock });
    await expect(eve.request(cascade.did, GROUP_RECEIPT, { group: g })).rejects.toMatchObject({ code: "notMember" });
  });
});

describe("roots", () => {
  it("publishes at most once per cadence, batching changes, with added, removed and counts", async () => {
    const { clock, cascade, join, rn } = setup();
    const r = cascade.registrar;
    expect(r.tick()).toBeNull(); // nothing yet
    await join(1n, rn());
    const first = r.tick()!;
    expect(first).toMatchObject({ seq: 0, size: 1, ext: { added: 1, removed: 0 } });
    expect((first.ext!.counts as Record<string, Record<string, number>>).licenseType[fieldToHex(fieldOfText("RN"))]).toBe(1);
    for (let i = 0; i < 3; i++) await r.admitDirect(`did:key:z6MkSim${i}`, cascade.issue(`did:key:z6MkSim${i}`, { licenseType: "LPN", state: "WA", licensedSince: "2020-01-01" }), BigInt(100 + i));
    expect(r.tick()).toBeNull(); // same hour
    clock.advance(HOUR);
    const second = r.tick()!;
    expect(second).toMatchObject({ seq: 1, size: 4, ext: { added: 3, removed: 0 } });
    expect(r.tick()).toBeNull(); // unchanged
  });

  it("drops a revoked member at the next root", async () => {
    const { clock, cascade, join, rn, ana } = setup();
    await join(1n, rn());
    await cascade.registrar.admitDirect("did:key:z6MkOther", cascade.issue("did:key:z6MkOther", { licenseType: "RN", state: "WA", licensedSince: "2020-01-01" }), 9n);
    cascade.registrar.tick();
    cascade.revokeSubject(ana.did);
    expect(await cascade.registrar.pollStatus()).toBe(1);
    clock.advance(HOUR);
    expect(cascade.registrar.tick()).toMatchObject({ size: 1, ext: { removed: 1 } });
    expect(cascade.registrar.isMember(ana.did)).toBe(false);
  });

  it("keeps a root chain that verifies, and a forged or reordered root is detected", async () => {
    const { clock, cascade, join, rn } = setup();
    await join(1n, rn());
    cascade.registrar.tick();
    clock.advance(HOUR);
    await cascade.registrar.admitDirect("did:key:z6MkB", cascade.issue("did:key:z6MkB", { licenseType: "RN", state: "WA", licensedSince: "2020-01-01" }), 2n);
    cascade.registrar.tick();
    const log = cascade.registrar.roots();
    expect((await checkRootLog(log, cascade.did, clock)).ok).toBe(true);
    expect((await checkRootLog([log[1], log[0]], cascade.did, clock)).ok).toBe(false);
    const mallory = identityFromSeed(seedFrom("reg/mallory"));
    const forged = signDocument<GroupRoot>({ ...log[1], issuer: mallory.did, proof: undefined } as GroupRoot, mallory, clock);
    expect(await checkRootLog([log[0], forged], cascade.did, clock)).toMatchObject({ ok: false, reason: "issuer" });
    const tampered = { ...log[1], size: 999 };
    expect(await checkRootLog([log[0], tampered], cascade.did, clock)).toMatchObject({ ok: false, reason: "signature" });
  });

  it("survives state() and back", async () => {
    const { clock, cascade, join, rn, ana } = setup();
    await join(1n, rn());
    cascade.registrar.tick();
    const again = new DemoIssuer(ISSUER_KINDS[0], cascade.identity, clock, { statusUrl: "http://x/status", state: JSON.parse(JSON.stringify(cascade.state())) });
    expect(again.registrar.roots()).toEqual(cascade.registrar.roots());
    expect(again.registrar.isMember(ana.did)).toBe(true);
    expect(again.registrar.receipt(ana.did)?.leaf).toEqual(cascade.registrar.receipt(ana.did)?.leaf);
  });
});
