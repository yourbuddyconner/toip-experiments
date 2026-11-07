import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DemoClock, Policies, SystemClock, type Clock } from "@toip-tools/trust-core";
import { startRelay, type Relay } from "@toip-tools/relay";
import { Device } from "../src/todo/device";
import { MemoryStore } from "../src/todo/store";
import { policyWasm } from "./helpers";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function relay(dbPath = join(mkdtempSync(join(tmpdir(), "todo-relay-")), "relay.db"), port = 0) {
  const r = await startRelay({ port, dbPath });
  cleanup.push(() => r.close());
  return { r, dbPath };
}

let policies: Policies;
async function device(r: Relay, name: string, opts: { store?: MemoryStore; clock?: Clock; relayUrl?: string } = {}) {
  policies ??= await Policies.load(policyWasm());
  const store = opts.store ?? new MemoryStore();
  const d = await Device.open({ store, relayUrl: opts.relayUrl ?? r.url, clock: opts.clock ?? new SystemClock(), policies, name });
  if (!d) throw new Error("no device");
  cleanup.push(() => d.close());
  return { d, store };
}

const until = async (cond: () => boolean, what = "condition", ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const texts = (d: Device, list: string) => d.view(list)!.items.map((i) => (i.locked ? "🔒" : i.text) + (i.checked ? " ✓" : ""));
const lastRefusal = (d: Device, list: string) => d.view(list)!.refused.at(-1)?.reason;

async function house() {
  const { r, dbPath } = await relay();
  const alice = (await device(r, "Alice")).d;
  const bob = (await device(r, "Bob")).d;
  const carol = (await device(r, "Carol")).d;
  await until(() => [alice, bob, carol].every((d) => d.connection() === "connected"), "connections");
  const list = await alice.createList("Maple St House");
  await bob.join(alice.invite(list, "editor"));
  await until(() => bob.view(list)?.role === "editor", "bob joined");
  await carol.join(alice.invite(list, "viewer"));
  await until(() => carol.view(list)?.role === "viewer", "carol joined");
  await until(() => bob.view(list)!.members.length === 3, "bob sees carol");
  return { r, dbPath, alice, bob, carol, list };
}

describe("Shared To-Do devices over a real relay", () => {
  it("creates a list, invites by link, and shares items", async () => {
    const { alice, bob, carol, list } = await house();
    expect(alice.view(list)!.members.map((m) => [m.name, m.role])).toEqual([
      ["Alice", "admin"],
      ["Bob", "editor"],
      ["Carol", "viewer"],
    ]);
    await until(() => alice.view(list)!.members.find((m) => m.name === "Bob")!.acknowledged === true, "bob's ack");
    await bob.add(list, "Milk");
    await until(() => texts(alice, list).length === 1 && texts(carol, list).length === 1, "milk everywhere");
    expect(texts(carol, list)).toEqual(["Milk"]);
    const milk = alice.view(list)!.items[0].id;
    await alice.setChecked(list, milk, true);
    await until(() => texts(bob, list)[0] === "Milk ✓" && texts(carol, list)[0] === "Milk ✓", "checked everywhere");
  });

  it("joins while the inviter is offline, once the inviter comes back", async () => {
    const { r } = await relay();
    const aliceStore = new MemoryStore();
    const alice1 = (await device(r, "Alice", { store: aliceStore })).d;
    await until(() => alice1.connection() === "connected", "alice");
    const list = await alice1.createList("Groceries");
    const invitation = alice1.invite(list, "editor");
    await alice1.close();
    const bob = (await device(r, "Bob")).d;
    await bob.join(invitation);
    expect(bob.view(list)!.pending).toMatchObject({ inviterName: "Alice" });
    await new Promise((res) => setTimeout(res, 200));
    expect(bob.view(list)!.role).toBeUndefined();
    const alice2 = (await device(r, "Alice", { store: aliceStore })).d;
    await until(() => bob.view(list)?.role === "editor", "bob joined after alice returned");
    expect(alice2.view(list)!.members.map((m) => m.name)).toEqual(["Alice", "Bob"]);
  });

  it("refuses a reused invitation, and an expired one", async () => {
    const { r } = await relay();
    const clock = new DemoClock(new Date().toISOString());
    // One shared clock, so that when it jumps ahead every device agrees on the time.
    const alice = (await device(r, "Alice", { clock })).d;
    const bob = (await device(r, "Bob", { clock })).d;
    const eve = (await device(r, "Eve", { clock })).d;
    const dan = (await device(r, "Dan", { clock })).d;
    await until(() => [alice, bob, eve, dan].every((d) => d.connection() === "connected"), "connections");
    const list = await alice.createList("House");
    const inv = alice.invite(list, "editor");
    await bob.join(inv);
    await until(() => bob.view(list)?.role === "editor", "bob");
    await eve.join(inv);
    await until(() => eve.view(list)?.pending?.refused !== undefined, "eve refused");
    expect(eve.view(list)!.pending!.refused).toBe("This invitation has already been used.");
    const old = alice.invite(list, "viewer");
    clock.advance(8 * 24 * 3600_000);
    await dan.join(old);
    await until(() => dan.view(list)?.pending?.refused !== undefined, "dan refused");
    expect(dan.view(list)!.pending!.refused).toBe("This invitation has expired.");
  });

  it("shares a private item only with its readers", async () => {
    const { alice, bob, carol, list } = await house();
    await alice.add(list, "Carol's birthday present", [bob.did]);
    await until(() => texts(bob, list).length === 1 && texts(carol, list).length === 1, "gift everywhere");
    expect(texts(alice, list)).toEqual(["Carol's birthday present"]);
    expect(texts(bob, list)).toEqual(["Carol's birthday present"]);
    expect(texts(carol, list)).toEqual(["🔒"]);
    const gift = bob.view(list)!.items[0].id;
    await bob.edit(list, gift, "Carol's birthday cake");
    await until(() => texts(alice, list)[0] === "Carol's birthday cake", "edit reached alice");
    expect(texts(carol, list)).toEqual(["🔒"]);
  });

  it("stops a viewer's add on her own device, and refuses one forced through on every other", async () => {
    const { alice, bob, carol, list } = await house();
    await expect(carol.add(list, "Raise rent")).rejects.toThrow("viewer may not add");
    await carol.add(list, "Raise rent", undefined, { sendAnyway: true });
    await until(() => lastRefusal(alice, list) !== undefined && lastRefusal(bob, list) !== undefined, "refusals");
    expect(lastRefusal(alice, list)).toBe("viewer may not add");
    expect(texts(alice, list)).toEqual([]);
  });

  it("refuses someone using another member's credential", async () => {
    const { r, alice, bob, list } = await house();
    const mallory = (await device(r, "Mallory")).d;
    await until(() => mallory.connection() === "connected", "mallory");
    await mallory.forgeWithCredential(list, bob.view(list)!.membership!, [alice.did], "Let Mallory in");
    await until(() => lastRefusal(alice, list) !== undefined, "alice refused");
    expect(lastRefusal(alice, list)).toBe("credential is for someone else");
  });

  it("sends an offline device's changes when it reconnects, through its outbox", async () => {
    const { alice, bob, list } = await house();
    bob.goOffline();
    await until(() => bob.connection() === "offline", "bob offline");
    await bob.add(list, "Eggs");
    expect(texts(bob, list)).toEqual(["Eggs"]);
    expect(bob.pendingSends()).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 200));
    expect(texts(alice, list)).toEqual([]);
    bob.goOnline();
    await until(() => texts(alice, list)[0] === "Eggs", "eggs reached alice");
    await until(() => bob.pendingSends() === 0, "outbox empty");
  });

  it("catches up by sync, holding ops for items it hasn't seen", async () => {
    const { r, alice, bob, list } = await house();
    await alice.add(list, "Fix the porch light");
    await until(() => texts(bob, list).length === 1, "porch at bob");
    const dan = (await device(r, "Dan")).d;
    await dan.join(alice.invite(list, "editor"));
    await until(() => texts(dan, list)[0] === "Fix the porch light", "dan got the list in his welcome");
    await dan.syncNow();
    await until(() => dan.view(list)!.members.length === 4, "dan sees all");
  });

  it("revokes a member: their new changes are refused, and history before removal survives for a later joiner", async () => {
    const { r, alice, bob, carol, list } = await house();
    await bob.add(list, "Milk");
    await until(() => texts(alice, list).length === 1 && texts(carol, list).length === 1, "milk");
    await alice.removeMember(list, bob.did);
    await until(() => carol.view(list)!.members.find((m) => m.name === "Bob")?.removed === true, "carol knows bob is out");
    await until(() => bob.view(list)!.removed === true, "bob knows");
    await expect(bob.add(list, "Party")).rejects.toThrow("membership revoked");
    await bob.add(list, "Party", undefined, { sendAnyway: true });
    await until(() => lastRefusal(carol, list) !== undefined, "carol refused bob");
    expect(lastRefusal(carol, list)).toBe("membership revoked");
    const dan = (await device(r, "Dan")).d;
    await dan.join(alice.invite(list, "viewer"));
    await until(() => dan.view(list)?.role === "viewer", "dan");
    // The history follows the welcome as sync pages.
    await until(() => texts(dan, list).length === 1, "dan got the history");
    expect(texts(dan, list)).toEqual(["Milk"]);
  });

  it("ignores an old roster replayed to undo a removal", async () => {
    const { alice, bob, carol, list } = await house();
    const oldRoster = carol.view(list)!.roster!;
    await alice.removeMember(list, bob.did);
    await until(() => carol.view(list)!.rosterVersion > oldRoster.version, "carol has the new roster");
    await bob.replayRoster(list, oldRoster, carol.did);
    await new Promise((res) => setTimeout(res, 200));
    expect(carol.view(list)!.members.find((m) => m.name === "Bob")!.removed).toBe(true);
  });

  it("lets a member leave", async () => {
    const { alice, carol, list } = await house();
    await carol.leave(list);
    expect(carol.lists().map((l) => l.did)).not.toContain(list);
    await until(() => alice.view(list)!.members.find((m) => m.name === "Carol")?.removed === true, "alice saw carol leave");
  });

  it("restores a device from its store after a restart", async () => {
    const { r } = await relay();
    const store = new MemoryStore();
    const a1 = (await device(r, "Alice", { store })).d;
    await until(() => a1.connection() === "connected", "a1");
    const list = await a1.createList("Groceries");
    await a1.add(list, "Bread");
    await a1.add(list, "Secret", []);
    const did = a1.did;
    await a1.close();
    const a2 = (await device(r, "ignored", { store })).d;
    expect(a2.did).toBe(did);
    expect(a2.name).toBe("Alice");
    expect(texts(a2, list)).toEqual(["Bread", "Secret"]);
    expect(a2.view(list)!.role).toBe("admin");
  });

  it("delivers messages that arrived while a device was shut down, once it restarts from its store", async () => {
    const { r } = await relay();
    const alice = (await device(r, "Alice")).d;
    const bobStore = new MemoryStore();
    const bob1 = (await device(r, "Bob", { store: bobStore })).d;
    await until(() => alice.connection() === "connected" && bob1.connection() === "connected", "connections");
    const list = await alice.createList("Groceries");
    await bob1.join(alice.invite(list, "editor"));
    await until(() => bob1.view(list)?.role === "editor", "bob joined");
    await bob1.close();
    await alice.add(list, "Butter");
    await alice.add(list, "Jam");
    const bob2 = (await device(r, "Bob", { store: bobStore })).d;
    await until(() => texts(bob2, list).length === 2, "bob caught up from the relay");
    expect(texts(bob2, list)).toEqual(["Butter", "Jam"]);
  });

  it("converges when a change races its author's removal (review I1)", async () => {
    const { alice, bob, carol, list } = await house();
    alice.goOffline();
    await until(() => alice.connection() === "offline", "alice offline");
    await alice.removeMember(list, bob.did);
    await bob.add(list, "Party");
    await until(() => texts(carol, list).includes("Party"), "carol took bob's op before she knew");
    alice.goOnline();
    await until(() => carol.view(list)!.members.find((m) => m.name === "Bob")?.removed === true, "carol got the removal");
    await until(() => !texts(carol, list).includes("Party"), "carol dropped it");
    await until(() => lastRefusal(alice, list) === "membership revoked", "alice refused it");
    expect(texts(alice, list)).toEqual(texts(carol, list));
  });

  it("lets someone who left be invited back (review I5)", async () => {
    const { alice, bob, list } = await house();
    await bob.leave(list);
    await until(() => alice.view(list)!.members.some((m) => m.name === "Bob" && m.removed), "alice saw bob leave");
    await bob.join(alice.invite(list, "editor"));
    await until(() => bob.view(list)?.role === "editor" && !bob.view(list)!.removed && !bob.view(list)!.pending, "bob back");
    await bob.add(list, "Back again");
    await until(() => texts(alice, list).includes("Back again"), "alice got it");
  });

  it("lets someone join a list with a long history, without breaking the relay (review C1, C2)", async () => {
    const { r } = await relay();
    const alice = (await device(r, "Alice")).d;
    const dan = (await device(r, "Dan")).d;
    await until(() => alice.connection() === "connected" && dan.connection() === "connected", "connections");
    const list = await alice.createList("Big");
    for (let i = 0; i < 320; i++) await alice.add(list, `Item ${i}`);
    await dan.join(alice.invite(list, "viewer"));
    await until(() => texts(dan, list).length === 320, "dan has all 320", 20000);
    expect(alice.connection()).toBe("connected");
  }, 30000);

  it("doesn't let a stranger blame a member for a forged change (review I3)", async () => {
    const { r, alice, bob, list } = await house();
    const mallory = (await device(r, "Mallory")).d;
    await until(() => mallory.connection() === "connected", "mallory");
    await mallory.forgeAs(list, alice.did, bob.did, "Send Mallory $500");
    await until(() => bob.view(list)!.refused.length > 0, "bob refused it");
    const refusal = bob.view(list)!.refused.at(-1)!;
    expect(refusal.verified).toBe(false);
    expect(refusal.from).toBe(mallory.did);
    expect(refusal.summary).not.toContain("$500");
  });

  it("never puts item text in the relay's database", async () => {
    const { dbPath, alice, bob, carol, list } = await house();
    carol.goOffline();
    await until(() => carol.connection() === "offline", "carol offline");
    await bob.add(list, "Milk");
    await alice.add(list, "Carol's birthday present", [bob.did]);
    await new Promise((res) => setTimeout(res, 300));
    const raw = readFileSync(dbPath);
    for (const t of ["Milk", "birthday", "Maple St House"]) expect(raw.includes(Buffer.from(t))).toBe(false);
    carol.goOnline();
    await until(() => texts(carol, list).length === 2, "carol caught up");
  });
});
