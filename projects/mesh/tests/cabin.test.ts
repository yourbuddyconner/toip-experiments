import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openBundle } from "@toip-tools/mesh-transport";
import { startRelay, type Relay } from "@toip-tools/relay";
import { Bus, DemoClock, Endpoint } from "@toip-tools/trust-core";
import { act2, act3 } from "../src/acts";
import { member } from "../src/cast";
import { ESCROW_ATTEST, SettleParty, attest, demoTerms } from "../src/settle";

const fact = (t: { summary: { facts: { label: string; value: string }[] } }, label: string) => t.summary.facts.find((f) => f.label === label)?.value ?? "";

let relay: Relay;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mesh-test-relay-"));
  relay = await startRelay({ port: 0, dbPath: join(dir, "relay.db") });
});
afterAll(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("act 2 on the simulator: an attestation from the cabin", () => {
  it("goes over the Ridge to the Lodge, which posts the exact TSP bytes to a real relay; the landlord's agent accepts it", async () => {
    const t = await act2({ seed: 1, relayUrl: relay.url });
    expect(t.summary.ok).toBe(true);
    expect(fact(t, "Byte-exact at the relay")).toBe("yes");
    expect(fact(t, "Accepted by the landlord's agent")).toBe("yes");
    const sizes = t.log.find((l) => l.sizes?.what === "settle/escrow/attest")!.sizes!;
    expect(sizes.packet).toMatchObject({ kind: "via", frames: 3, route: "gateway" });
    expect(sizes.jsonFrames).toBeGreaterThanOrEqual(7);
    // Alice → Ridge → Lodge, and the custody receipt back the same way.
    expect(t.frames.filter((f) => f.packet === "via").map((f) => f.from)).toEqual(["alice", "ridge"]);
    expect(t.frames.filter((f) => f.packet === "receipt").map((f) => f.from)).toEqual(["lodge", "ridge"]);
    expect(t.hops.map((h) => `${h.from}>${h.to}`)).toEqual(["lodge>relay", "relay>landlord"]);
    expect(t.log.some((l) => l.who === "alice" && /custody receipt/.test(l.text))).toBe(true);
  });

  it("gets through at 20% frame loss, by resends and the outbox", async () => {
    for (const seed of [1, 2, 3, 4]) {
      const t = await act2({ seed, loss: 0.2, relayUrl: relay.url });
      expect(t.summary.ok, `seed ${seed}`).toBe(true);
    }
  });
});

describe("act 3 on the simulator: by hand", () => {
  it("keeps the attestation in the outbox with the gateway down, carries it as a sealed bundle file, and the landlord's agent accepts it", async () => {
    const usb = mkdtempSync(join(tmpdir(), "mesh-usb-"));
    try {
      const t = await act3({ seed: 1, relayUrl: relay.url, usbDir: usb });
      expect(t.summary.ok).toBe(true);
      expect(t.frames).toHaveLength(0);
      expect(fact(t, "Byte-exact at the relay")).toBe("yes");
      expect(t.hops.map((h) => `${h.from}>${h.to}:${h.via}`)).toEqual(["alice>neighbor:usb", "neighbor>relay:internet", "relay>landlord:internet"]);
      const files = readdirSync(usb).filter((f) => f.endsWith(".toipbundle"));
      expect(files).toHaveLength(1);
      const bytes = readFileSync(join(usb, files[0]));
      await expect(openBundle(bytes)).rejects.toThrow(/sealed/);
      await expect(openBundle(bytes, member("eve"))).rejects.toThrow(/someone else/);
      const items = await openBundle(bytes, member("neighbor"));
      expect(items.map((i) => i.to)).toEqual([member("landlord").did]);
    } finally {
      rmSync(usb, { recursive: true, force: true });
    }
  });

  it("works the same at 20% frame loss: nothing goes on the air", async () => {
    const t = await act3({ seed: 2, loss: 0.2, relayUrl: relay.url });
    expect(t.summary.ok).toBe(true);
  });
});

describe("the Settle party", () => {
  it("accepts only its terms' attester, with a valid signature, as Settle's Party does", async () => {
    const clock = new DemoClock("2026-11-06T12:00:00.000Z");
    const bus = new Bus(clock);
    const got: string[] = [];
    const party = new SettleParty({ identity: member("landlord"), transport: bus, clock, onIgnored: (w) => got.push(w), onAccepted: (a) => got.push(`accepted ${a.claim}`) });
    const terms = await demoTerms({ payment: "p1", purpose: "Fix sink", units: 1_000_000n, payer: member("landlord"), payee: member("joe"), attester: member("alice"), arbiter: member("arbiter"), clock });
    party.know(terms);
    const send = async (from: "alice" | "joe", payload: unknown) => {
      const ep = new Endpoint({ identity: member(from), transport: bus, clock });
      await ep.notify(member("landlord").did, ESCROW_ATTEST, payload);
      await new Promise((r) => setTimeout(r, 20));
      ep.close();
    };
    // Joe is the payee, not the attester.
    await send("joe", attest(member("joe"), terms, "complete", clock));
    // Alice's attestation with its claim changed after signing.
    await send("alice", { ...attest(member("alice"), terms, "not-complete", clock), claim: "complete" });
    // Signed, but for terms the landlord never agreed.
    const other = await demoTerms({ payment: "p2", purpose: "Something else", units: 5n, payer: member("landlord"), payee: member("joe"), attester: member("alice"), arbiter: member("arbiter"), clock });
    await send("alice", attest(member("alice"), other, "complete", clock));
    await send("alice", attest(member("alice"), terms, "complete", clock, "done"));
    expect(got).toEqual([
      "an attestation from someone who isn't the attester",
      "an attestation whose signature doesn't verify",
      "an attestation for terms this party never agreed",
      "accepted complete",
    ]);
    expect(party.accepted[0]).toMatchObject({ payment: "p1", sender: member("alice").did, claim: "complete", note: "done" });
    party.close();
  });
});
