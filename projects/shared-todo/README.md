# Shared To-Do

A household to-do list with no server you have to trust. Four people and a relay run on one page, each holding their own copy of the list. Every change is signed, sent encrypted, and checked on each phone before it's applied.

It shows the basic ToIP ideas:

| Layer | In the demo |
|---|---|
| 1. Identifiers | Each person, and the list itself, has a `did:key` made from a key pair on their device. |
| 2. Trust spanning | Every message is a real TSP message, encrypted to the recipient and signed by the sender. |
| 3. Trust tasks and credentials | The list issues membership credentials with roles, members sign acknowledgements back, and every phone checks every change against the list's Rego rules. Revocation uses a signed revocation list. |
| 4. Application | The to-do list, private items, and a relay for offline members. |

Built on the Apache-2.0 OpenVTC libraries (`@openvtc/vti-tsp-js`, `@openvtc/trust-tasks`, `@openvtc/trust-tasks-tsp`, `@openvtc/trust-tasks-proof`) through `packages/trust-core`. It uses none of the P2P Trust Stack's own code, which is GPL (`docs/sources/S03`).

## Run it

From the repository root:

```bash
npm install
npm run dev --workspace @zk-toip/shared-todo   # http://localhost:5181
```

Press "Next step" to walk through the story. "Free play" lets you act as anyone: add shared or private items, go offline, catch up from someone, remove a member, send a change your role doesn't allow, or forward a tampered copy.

Other commands, run in this folder:

```bash
npm test             # unit, scenario, disclosure and UI smoke tests
npm run build        # typecheck and production build
npm run policies     # recompile policies/todo.rego to policy.wasm (needs the OPA CLI: brew install opa)
```

`policies/policy.wasm` is committed, so you only need OPA to change the rules.

## The story

1. Everyone has an identity.
2. Alice creates the list.
3. Alice invites Bob, as an editor.
4. Alice invites Carol, the landlord, as a viewer.
5. Bob adds "Milk", and Alice adds "Fix the porch light".
6. Alice adds a private item only she and Bob can read. Carol's phone shows it locked, but still checks and accepts it.
7. Carol tries to add "Raise rent". Her app refuses. A modified app sends it anyway, and every other phone rejects it.
8. Mallory uses Bob's membership credential. Every phone rejects her change: the credential is for someone else.
9. Bob goes offline. Alice checks off the milk, and her phone leaves the sealed message at the relay.
10. Bob comes back, collects it, and checks Alice's signature.
11. Alice removes Bob. His next change is rejected everywhere.
12. Bob forwards a tampered copy of Alice's change to Carol. The signature check fails.

`tests/scenario.test.ts` asserts every phone's list and refusals after each step. `tests/disclosure.test.ts` checks that no item text ever appears on the wire or at the relay, and that Carol's device never holds the private item's text.

## Where the code is

| Path | What |
|---|---|
| `src/todo/ops.ts` | Signed operations, which anyone can forward. |
| `src/todo/checks.ts` | The checks each phone runs, in order, and the call to the Rego policy. |
| `src/todo/list.ts` | One device's copy of the list. |
| `src/todo/member.ts` | A person's device: joining, editing, receiving, the relay fallback, sync, revocation. |
| `src/todo/relay.ts` | The mailbox for offline members. |
| `src/todo/scenario.ts`, `world.ts` | The scripted story. |
| `policies/todo.rego` | Who may do what. |
| `src/web/` | The page. |

## Where we guessed about the stack

- Relationships start with the first Direct TSP message, not the TSP RFI/RFA handshake. `@openvtc/trust-tasks-tsp` carries only Direct messages.
- Invitations are OOBI-style, not the stack's OOBI format.
- `did:key` instead of `did:peer:4`.
- The list is a community whose key one person holds. Real VTCs have a governance document and M-of-N signing.
- Operation, sync, relay, status and private-item formats are ours, under `https://zk-toip.example/spec/todo/…`.
- The relay is a deposit-and-collect task, not TSP Routed Mode.
- That the OpenVTC libraries behave like the P2P Trust Stack's own implementation. Wire compatibility wasn't checked.

Design: `docs/design.md`. Plan: `docs/plan.md`.
