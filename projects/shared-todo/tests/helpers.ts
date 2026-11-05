import { readFileSync } from "node:fs";
import { DemoClock, Policies, StatusList, identityFromSeed, issueCredential, seedFrom, type Credential, type Identity } from "@zk-toip/trust-core";
import type { Role } from "../src/todo/checks";

export const policyWasm = () => readFileSync(new URL("../policies/policy.wasm", import.meta.url));

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
  const status = new StatusList();
  const member = (who: Identity, role: Role): Credential =>
    issueCredential(list, clock, {
      type: ["VerifiableCredential", "TodoListMembership"],
      credentialSubject: { id: who.did, list: list.did, role },
      credentialStatus: { type: "BitstringStatusListEntry", statusListIndex: status.allocate(), statusListCredential: `${list.did}#status` },
    });
  const memberships = { alice: member(people.alice, "admin"), bob: member(people.bob, "editor"), carol: member(people.carol, "viewer") };
  return { clock, policies, list, people, status, memberships, statusDoc: () => status.sign(list, clock) };
}
