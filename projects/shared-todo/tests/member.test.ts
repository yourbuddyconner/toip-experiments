import { describe, expect, it } from "vitest";
import { Bus, DemoClock, Policies, identityFromSeed, seedFrom } from "@zk-toip/trust-core";
import { MemberAgent } from "../src/todo/member";
import { RelayAgent } from "../src/todo/relay";
import { policyWasm } from "./helpers";

async function house() {
  const clock = new DemoClock("2026-11-05T14:30:00Z");
  const bus = new Bus(clock);
  const policies = await Policies.load(policyWasm());
  const relay = new RelayAgent({ identity: identityFromSeed(seedFrom("shared-todo/relay")), bus, clock });
  const mk = (name: string) => new MemberAgent({ name, bus, clock, policies, relayDid: relay.did });
  const alice = mk("Alice"), bob = mk("Bob"), carol = mk("Carol"), mallory = mk("Mallory");
  alice.createList("Maple St House");
  await bob.scan(alice.invite("editor"));
  await carol.scan(alice.invite("viewer"));
  await bus.settle();
  const texts = (m: MemberAgent) => m.state.items().map((i) => (i.locked ? "🔒" : i.text));
  const lastReason = (m: MemberAgent) => m.rejected.at(-1)?.reason;
  return { clock, bus, relay, alice, bob, carol, mallory, texts, lastReason };
}

describe("MemberAgent", () => {
  it("joins by invitation and shares adds with every member", async () => {
    const h = await house();
    expect(h.bob.role).toBe("editor");
    expect(h.carol.role).toBe("viewer");
    expect(h.alice.members.get(h.bob.did)?.acknowledged).toBe(true);
    expect(h.carol.members.has(h.bob.did)).toBe(true);
    await h.bob.add("Milk");
    await h.bus.settle();
    for (const m of [h.alice, h.bob, h.carol]) expect(h.texts(m)).toEqual(["Milk"]);
  });

  it("an invitation code works once", async () => {
    const h = await house();
    const inv = h.alice.invite("editor");
    await h.mallory.scan(inv);
    const eve = new MemberAgent({ name: "Eve", bus: h.bus, clock: h.clock, policies: (h.alice as any).policies, relayDid: h.relay.did });
    await eve.scan(inv);
    expect(eve.lastError).toMatch(/invitation/);
    expect(eve.membership).toBeUndefined();
  });

  it("refuses a viewer's add locally, and peers reject it when sent anyway", async () => {
    const h = await house();
    await h.carol.add("Raise rent");
    expect(h.carol.lastError).toBe("viewer may not add");
    await h.bus.settle();
    expect(h.texts(h.alice)).toEqual([]);
    h.carol.sendAnyway = true;
    await h.carol.add("Raise rent");
    await h.bus.settle();
    for (const m of [h.alice, h.bob, h.carol]) expect(h.texts(m)).toEqual([]);
    expect(h.lastReason(h.alice)).toBe("viewer may not add");
    expect(h.lastReason(h.bob)).toBe("viewer may not add");
  });

  it("rejects Mallory using Bob's credential", async () => {
    const h = await house();
    await h.mallory.sneakIn({ list: h.alice.list!.did, targets: [h.alice.did, h.carol.did], membership: h.bob.membership!, text: "Let Mallory in" });
    await h.bus.settle();
    expect(h.lastReason(h.alice)).toBe("credential is for someone else");
    expect(h.lastReason(h.carol)).toBe("credential is for someone else");
    expect(h.texts(h.alice)).toEqual([]);
  });

  it("leaves messages for an offline member at the relay, which can't read them", async () => {
    const h = await house();
    const milk = await h.bob.add("Milk");
    await h.bus.settle();
    await h.bob.setOnline(false);
    await h.alice.check(milk);
    await h.bus.settle();
    expect(h.relay.held()).toHaveLength(1);
    expect(h.relay.held()[0].to).toBe(h.bob.did);
    expect(JSON.stringify(h.relay.state())).not.toContain("Milk");
    expect(h.bob.state.item(milk)?.checked).toBe(false);
    await h.bob.setOnline(true);
    await h.bus.settle();
    expect(h.bob.state.item(milk)?.checked).toBe(true);
    expect(h.relay.held()).toHaveLength(0);
  });

  it("catches up by syncing from another member, checking each forwarded op", async () => {
    const h = await house();
    await h.bob.setOnline(false);
    await h.alice.add("Fix the porch light");
    await h.bus.settle();
    h.relay.dropAll();
    await h.bob.setOnline(true);
    expect(h.texts(h.bob)).toEqual([]);
    await h.bob.syncFrom(h.carol.did);
    await h.bus.settle();
    expect(h.texts(h.bob)).toEqual(["Fix the porch light"]);
  });

  it("revocation stops a removed member's changes everywhere", async () => {
    const h = await house();
    await h.alice.revoke(h.bob.did);
    await h.bus.settle();
    await h.bob.add("Party at ours");
    expect(h.bob.lastError).toBe("membership revoked");
    h.bob.sendAnyway = true;
    await h.bob.add("Party at ours");
    await h.bus.settle();
    expect(h.lastReason(h.alice)).toBe("membership revoked");
    expect(h.lastReason(h.carol)).toBe("membership revoked");
    expect(h.texts(h.carol)).toEqual([]);
  });

  it("rejects a tampered forwarded op", async () => {
    const h = await house();
    const porch = await h.alice.add("Fix the porch light");
    await h.bus.settle();
    const opId = h.bob.state.allOps().find((o) => o.itemId === porch)!.id;
    await h.bob.forwardTampered(opId, "Give Bob his deposit back", h.carol.did);
    await h.bus.settle();
    expect(h.lastReason(h.carol)).toBe("operation: signature does not verify");
    expect(h.texts(h.carol)).toEqual(["Fix the porch light"]);
  });

  it("shares a private item readable only by its readers", async () => {
    const h = await house();
    const gift = await h.alice.add("Carol's birthday present", [h.bob.did]);
    await h.bus.settle();
    expect(h.texts(h.alice)).toEqual(["Carol's birthday present"]);
    expect(h.texts(h.bob)).toEqual(["Carol's birthday present"]);
    expect(h.texts(h.carol)).toEqual(["🔒"]);
    expect(JSON.stringify(h.carol.snapshot())).not.toContain("birthday");
    await h.bob.edit(gift, "Carol's birthday cake");
    await h.bus.settle();
    expect(h.texts(h.alice)).toEqual(["Carol's birthday cake"]);
    expect(h.texts(h.carol)).toEqual(["🔒"]);
  });

  it("an offline member with no relay reachable reports an error, not a hang", async () => {
    const h = await house();
    await h.bob.setOnline(false);
    h.bus.setOnline(h.relay.did, false);
    await h.alice.add("Milk");
    expect(h.alice.lastError).toMatch(/relay/);
  });
});
