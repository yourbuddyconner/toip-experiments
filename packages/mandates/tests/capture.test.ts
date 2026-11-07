import { describe, expect, it } from "vitest";
import {
  CAPTURE_1,
  SETTLE_1,
  StatusRegistry,
  actionHash,
  approve,
  delegate,
  explain,
  getProfile,
  issueMandate,
  present,
  registerProfile,
  staticStatusResolver,
  type Action,
  type Mandate,
} from "../src/index";
import { codes, engine, id, inDays, people, world } from "./helpers";

const desk = id("daily-planet-desk");
const dana = id("dana-photographer");
const camera = id("danas-camera");
const publisher = id("publisher");

function photo(w: ReturnType<typeof world>, actor: string, attrs: Partial<Action["attrs"]> = {}): Action {
  return {
    type: "capture/sign-media",
    profile: "capture/1",
    id: `cap-${Math.random()}`,
    actor,
    at: w.clock.iso(),
    attrs: { spend: "0", device: actor, media: "sha256:abc", mediaType: "image/jpeg", location: "geo:us/ca/sf", assignment: "1123", ...attrs } as Action["attrs"],
  };
}

describe("owner-to-device delegation: the capture/1 profile (§16.3)", () => {
  it("is built in, alongside settle/1", () => {
    expect(getProfile("capture/1")).toBe(CAPTURE_1);
    expect(getProfile("settle/1")).toBe(SETTLE_1);
    expect(Object.keys(CAPTURE_1.actions)).toContain("capture/sign-media");
  });

  it("a device signs photos inside its owner's mandate, and is refused or escalated outside it", async () => {
    const w = world();
    const deskStatus = new StatusRegistry(desk, w.clock);
    const m = issueMandate(desk, w.clock, {
      subject: camera.did,
      validUntil: inDays(w.clock, 4),
      status: deskStatus.allocate(),
      profile: "capture/1",
      purpose: "Photos for the Daily Planet, on assignment 1123, until Friday.",
      constraints: {
        actions: { attr: "type", anyOf: ["capture/sign-media"] },
        where: { attr: "location", within: ["geo:us/ca/*"], when: ["capture/sign-media"] },
        media: { attr: "mediaType", anyOf: ["image/jpeg", "image/heic"], when: ["capture/sign-media"] },
        assignment: { attr: "assignment", is: "1123", when: ["capture/sign-media"] },
      },
      delegation: { maxDepth: 0 },
      escalation: { approvable: ["where"], approvalTtlSeconds: 600 },
      revocation: { maxAgeSeconds: 86_400 },
    });
    const e = await engine();
    const status = () => staticStatusResolver([deskStatus.sign()]);
    const decide = (a: Action, approvals = [] as ReturnType<typeof approve>[]) => e.decide({ chain: [m], presenter: camera.did, action: a, approvals, status: status(), clock: w.clock });

    expect((await decide(photo(w, camera.did))).outcome).toBe("allow");
    expect(codes(await decide(photo(w, camera.did, { mediaType: "video/mp4" })))).toEqual(["constraint.failed"]);
    expect((await decide(photo(w, camera.did, { assignment: "999" }))).outcome).toBe("deny");

    const nyc = photo(w, camera.did, { location: "geo:us/ny/nyc" });
    const d = await decide(nyc);
    expect(d.outcome).toBe("escalate");
    expect(d.approver).toBe(desk.did);
    expect(explain(d, { name: (x) => (x === desk.did ? "Daily Planet photo desk" : x === camera.did ? "Dana's camera" : x), noun: "this photo" })).toEqual([
      "The location “geo:us/ny/nyc” is outside what Daily Planet photo desk allowed Dana's camera (where).",
      "Daily Planet photo desk can approve this photo.",
    ]);
    const ok = approve(desk, w.clock, { chain: [m], action: nyc, ttlSeconds: 600 });
    expect((await decide(nyc, [ok])).outcome).toBe("allow");

    // A published photo carries the device's presentation; the publisher checks it on its own.
    const p = present(camera, w.clock, { audience: publisher.did, action: photo(w, camera.did), actionHash: "", chain: [m], approvals: [] });
    const p2 = present(camera, w.clock, { ...p, actionHash: actionHash(p.action) });
    expect((await e.verifyPresentation(p2, { sender: camera.did, me: publisher.did, status: status(), clock: w.clock })).outcome).toBe("allow");

    w.clock.advance(4 * 86_400_000);
    expect(codes(await decide(photo(w, camera.did)))).toContain("chain.expired");
  });

  it("an agency delegates to a freelancer, who delegates to her camera; each link only narrows", async () => {
    const w = world();
    const deskStatus = new StatusRegistry(desk, w.clock);
    const danaStatus = new StatusRegistry(dana, w.clock);
    const root: Mandate = issueMandate(desk, w.clock, {
      subject: dana.did,
      validUntil: inDays(w.clock, 30),
      status: deskStatus.allocate(),
      profile: "capture/1",
      constraints: {
        actions: { attr: "type", anyOf: ["capture/sign-media"] },
        where: { attr: "location", within: ["geo:us/*"], when: ["capture/sign-media"] },
      },
      delegation: { maxDepth: 1 },
      revocation: { maxAgeSeconds: 86_400 },
    });
    const r = await delegate([root], dana, w.clock, {
      subject: camera.did,
      validUntil: inDays(w.clock, 4),
      status: danaStatus.allocate(),
      tighten: { where: { attr: "location", within: ["geo:us/ca/*"], when: ["capture/sign-media"] } },
      add: { assignment: { attr: "assignment", is: "1123", when: ["capture/sign-media"] } },
    });
    if (!("mandate" in r)) throw new Error(JSON.stringify(r.problems));
    const chain = [root, r.mandate];
    const status = staticStatusResolver([deskStatus.sign(), danaStatus.sign()]);
    const e = await engine();
    expect((await e.decide({ chain, presenter: camera.did, action: photo(w, camera.did), status, clock: w.clock })).outcome).toBe("allow");
    const tx = await e.decide({ chain, presenter: camera.did, action: photo(w, camera.did, { location: "geo:us/tx/austin" }), status, clock: w.clock });
    expect(tx.reasons.map((x) => [x.link, x.dimension])).toEqual([[1, "where"]]);
    const wider = await delegate([root], dana, w.clock, { subject: camera.did, validUntil: inDays(w.clock, 4), status: danaStatus.allocate(), tighten: { where: { attr: "location", within: ["geo:us/*", "geo:ca/*"] } } });
    expect("problems" in wider && codes({ reasons: wider.problems })).toEqual(["narrowing.widened"]);
  });

  it("registerProfile adds a vocabulary; a conflicting redefinition is refused", async () => {
    const w = world();
    registerProfile({ id: "doors/1", actions: { "doors/open": { required: ["door"] } }, rootRequires: ["type", "door"] });
    expect(getProfile("doors/1")?.actions["doors/open"].required).toEqual(["door"]);
    registerProfile({ id: "doors/1", actions: { "doors/open": { required: ["door"] } }, rootRequires: ["type", "door"] });
    expect(() => registerProfile({ id: "doors/1", actions: {}, rootRequires: [] })).toThrow(/already/);
    expect(() => registerProfile({ id: "settle/1", actions: {}, rootRequires: [] })).toThrow(/already/);

    const reg = new StatusRegistry(people.conner, w.clock);
    const base = { subject: people.dana.did, validUntil: inDays(w.clock, 1), profile: "doors/1", delegation: { maxDepth: 0 }, revocation: { maxAgeSeconds: 600 } };
    expect(() => issueMandate(people.conner, w.clock, { ...base, status: reg.allocate(), constraints: { actions: { attr: "type", anyOf: ["doors/open"] } } })).toThrow(/door/);
    const m = issueMandate(people.conner, w.clock, {
      ...base,
      status: reg.allocate(),
      constraints: { actions: { attr: "type", anyOf: ["doors/open"] }, which: { attr: "door", anyOf: ["front"] } },
    });
    const open = (door: string): Action => ({ type: "doors/open", profile: "doors/1", id: door, actor: people.dana.did, at: w.clock.iso(), attrs: { spend: "0", door } });
    const e = await engine();
    const status = staticStatusResolver([reg.sign()]);
    expect((await e.decide({ chain: [m], presenter: people.dana.did, action: open("front"), status, clock: w.clock })).outcome).toBe("allow");
    expect((await e.decide({ chain: [m], presenter: people.dana.did, action: open("garage"), status, clock: w.clock })).outcome).toBe("deny");
  });
});
