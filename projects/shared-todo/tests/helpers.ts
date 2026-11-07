import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DemoClock, Policies, identityFromSeed, issueCredential, seedFrom, type Credential, type Identity } from "@toip-tools/trust-core";
import type { Role } from "../src/todo/checks";
import { signRoster, type RosterMember } from "../src/todo/roster";

export const policyWasm = () => readFileSync(resolve(__dirname, "../policies/policy.wasm"));

export async function fixture() {
  const clock = new DemoClock("2026-11-05T14:30:00Z");
  const policies = await Policies.load(policyWasm());
  const list = identityFromSeed(seedFrom("shared-todo/list"));
  const people = {
    alice: identityFromSeed(seedFrom("shared-todo/alice")),
    bob: identityFromSeed(seedFrom("shared-todo/bob")),
    carol: identityFromSeed(seedFrom("shared-todo/carol")),
    mallory: identityFromSeed(seedFrom("shared-todo/mallory")),
  };
  const member = (who: Identity, role: Role): Credential =>
    issueCredential(list, clock, {
      type: ["VerifiableCredential", "TodoListMembership"],
      credentialSubject: { id: who.did, list: list.did, role },
    });
  const memberships = { alice: member(people.alice, "admin"), bob: member(people.bob, "editor"), carol: member(people.carol, "viewer") };
  const entry = (who: "alice" | "bob" | "carol", role: Role, extra: Partial<RosterMember> = {}): RosterMember => ({
    did: people[who].did,
    name: who[0].toUpperCase() + who.slice(1),
    role,
    membershipId: memberships[who].id,
    joinedAt: clock.iso(),
    ...extra,
  });
  const roster = (version: number, extra: Partial<Record<"alice" | "bob" | "carol", Partial<RosterMember>>> = {}) =>
    signRoster(list, clock, {
      name: "Maple St House",
      version,
      members: [entry("alice", "admin", extra.alice), entry("bob", "editor", extra.bob), entry("carol", "viewer", extra.carol)],
    });
  return { clock, policies, list, people, memberships, roster };
}
