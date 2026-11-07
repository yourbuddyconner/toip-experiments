import { describe, expect, it } from "vitest";
import { MeshTransport } from "@toip-tools/mesh-transport";
import { issueCredential } from "@toip-tools/trust-core";
import { DEMO_START, NODE_RADIO, act0, act1, doorWorld, type DoorWorld } from "../src/acts";
import { member } from "../src/cast";
import { Guest, nextChallenge, type DoorAnswer } from "../src/door";
import type { GuestPass } from "../src/pass";

const fact = (t: { summary: { facts: { label: string; value: string }[] } }, label: string) => t.summary.facts.find((f) => f.label === label)?.value ?? "";

/** Rosa presents a pass at the door, with the current challenge unless told otherwise. */
async function present(w: DoorWorld, pass: GuestPass, opts: { nonce?: Uint8Array } = {}): Promise<DoorAnswer> {
  w.door.start();
  const beacon = await w.sched.run(nextChallenge(w.guestMesh, member("door").did, 60_000));
  return w.sched.run(w.guest.present(member("door").did, pass, opts.nonce ?? beacon.nonce!, 60_000));
}

describe("act 1 on the simulator: a door with no internet", () => {
  it("opens for a valid pass in under 2 seconds, leaks nothing on the air, and refuses a replay three ways", async () => {
    const t = await act1({ seed: 1 });
    expect(t.summary.ok).toBe(true);
    const ms = (s: string) => (s.endsWith(" ms") ? Number(s.slice(0, -3)) : Number(s.slice(0, -2)) * 1000);
    expect(ms(fact(t, "Beacon to answer"))).toBeLessThan(2000);
    // The presentation is a first contact: INTRO, 3 frames. As plain JSON TSP it would be 8 or more.
    const presentation = t.log.find((l) => l.sizes?.what === "door/open")!.sizes!;
    expect(presentation.packet).toMatchObject({ kind: "intro", frames: 3, route: "direct" });
    expect(presentation.jsonSealed).toBeGreaterThan(2.5 * presentation.compactSealed);
    expect(presentation.jsonFrames).toBeGreaterThanOrEqual(8);
    expect(t.log.find((l) => l.sizes?.what === "door/open response")!.sizes!.packet).toMatchObject({ kind: "pair", frames: 2 });
    expect(fact(t, "A listener heard")).toMatch(/no DIDs, keys or names/);
    expect(fact(t, "Replay attack")).toBe("refused three ways: seen list, replay record, stale challenge");
    expect(t.log.filter((l) => l.who === "door" && l.text.startsWith("opened"))).toHaveLength(1);
    // Frames never exceed the MTU or the 400 ms US dwell limit.
    for (const f of t.frames) {
      expect(f.bytes).toBeLessThanOrEqual(250);
      expect(f.airtimeMs).toBeLessThan(400);
    }
  });

  it("is deterministic: the same seed gives the same frames at the same times", async () => {
    const shape = (t: Awaited<ReturnType<typeof act1>>) => t.frames.map((f) => `${f.at.toFixed(3)} ${f.from} ${f.label} ${f.bytes} ${f.heard.map((h) => `${h.to}:${h.ok}`).join(",")}`);
    const [a, b] = [await act1({ seed: 4, loss: 0.2, replay: false }), await act1({ seed: 4, loss: 0.2, replay: false })];
    expect(shape(a)).toEqual(shape(b));
  });

  it("still opens at 20% frame loss, resending what was lost", async () => {
    let retries = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const t = await act1({ seed, loss: 0.2, replay: false });
      expect(t.summary.ok).toBe(true);
      retries += t.summary.retries;
    }
    expect(retries).toBeGreaterThan(0);
  });

  it("refuses offline a pass the household revoked, by the cached revocation list", async () => {
    const w = await doorWorld({ setup: act0({ atMs: DEMO_START - 3600_000, revoked: [3, 7] }) });
    try {
      expect(await present(w, w.setup.pass)).toEqual({ open: false, reason: "the household revoked this pass" });
      expect(w.door.events.map((e) => e.type === "refused" && e.code)).toEqual(["revoked"]);
    } finally {
      await w.stop();
    }
  });

  it("refuses a forged pass: altered hours, or signed by someone other than the Building", async () => {
    const w = await doorWorld();
    try {
      const altered = { ...w.setup.pass, credentialSubject: { ...w.setup.pass.credentialSubject, hours: "00:00-24:00" } };
      expect(await present(w, altered)).toEqual({ open: false, reason: "the Building's signature on the pass doesn't verify" });
      const mallory = member("mallory");
      const fake = issueCredential(mallory, w.sched, { type: ["VerifiableCredential", "GuestPass"], credentialSubject: { ...w.setup.pass.credentialSubject }, credentialStatus: w.setup.pass.credentialStatus });
      expect(await present(w, fake as GuestPass)).toEqual({ open: false, reason: "the pass isn't from this building" });
      const claimed = { ...fake, issuer: member("building").did } as GuestPass;
      expect(await present(w, claimed)).toEqual({ open: false, reason: "the Building's signature on the pass doesn't verify" });
      expect(w.door.events.filter((e) => e.type === "opened")).toHaveLength(0);
    } finally {
      await w.stop();
    }
  });

  it("refuses a copied pass presented by someone without the pass key", async () => {
    const w = await doorWorld();
    try {
      // Mallory copied Rosa's pass, and has her own radio near the door. She can only sign with her own key.
      const mallory = member("mallory");
      const link = w.medium.node("mallory", NODE_RADIO);
      w.medium.connect("mallory", "door");
      const mesh = new MeshTransport({ identities: [mallory], links: [link], scheduler: w.sched, flood: { maxTtl: 0, relayShare: 0, unknown: "direct" } });
      mesh.addContact(member("door").did);
      await mesh.start();
      const thief = new Guest({ identity: mallory, mesh, clock: w.sched });
      w.door.start();
      const beacon = await w.sched.run(nextChallenge(mesh, member("door").did, 60_000));
      expect(await w.sched.run(thief.present(member("door").did, w.setup.pass, beacon.nonce!, 60_000))).toEqual({ open: false, reason: "the request wasn't signed by the pass key" });
      expect(w.door.events.some((e) => e.type === "opened")).toBe(false);
      thief.close();
      await mesh.stop();
    } finally {
      await w.stop();
    }
  });

  it("refuses a stale challenge, a pass outside its window, and a revocation list too old to trust", async () => {
    const w = await doorWorld();
    try {
      expect(await present(w, w.setup.pass, { nonce: crypto.getRandomValues(new Uint8Array(8)) })).toEqual({ open: false, reason: "the challenge is stale: present again" });
    } finally {
      await w.stop();
    }
    // Saturday lunchtime: the pass is for Mon-Fri.
    const sat = Date.parse("2026-11-07T12:30:00Z");
    const w2 = await doorWorld({ startMs: sat, setup: act0({ atMs: sat - 3600_000 }) });
    try {
      expect(await present(w2, w2.setup.pass)).toEqual({ open: false, reason: "the pass is for Mon-Fri 12:00-14:00" });
    } finally {
      await w2.stop();
    }
    // The door last went online 25 hours ago.
    const w3 = await doorWorld({ setup: act0({ atMs: DEMO_START - 25 * 3600_000 }) });
    try {
      expect(await present(w3, w3.setup.pass)).toEqual({ open: false, reason: "the cached revocation list is 25 h old" });
    } finally {
      await w3.stop();
    }
  });

  it("opens for the pass key that signed the beacon's challenge, and says who it let in", async () => {
    const w = await doorWorld();
    try {
      w.door.start();
      const beacon = await w.sched.run(nextChallenge(w.guestMesh, member("door").did, 60_000));
      expect(w.door.beacon.isFresh(beacon.nonce!)).toBe(true);
      expect(await w.sched.run(w.guest.present(member("door").did, w.setup.pass, beacon.nonce!, 60_000))).toEqual({ open: true });
      expect(w.door.events).toMatchObject([{ type: "opened", sender: member("rosa").did, pass: "dog walker", household: "4B" }]);
    } finally {
      await w.stop();
    }
  });
});
