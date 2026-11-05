# Shared To-Do: design

A multi-user to-do list with no trusted server, built on the ToIP specs through the Apache-2.0 OpenVTC libraries. The first thing to build in this repository, before Community Rides. Date: 2026-11-05.

Facts about the stack cite `docs/sources/` (S02, S03). Choices marked **(our call)** were made by the assistant and are open to change.

## 1. Why this exists

Community Rides is a lot to build and a lot to explain. A shared to-do list is something everyone has used, so the audience can watch the trust mechanics instead of learning a new app. It shows the basic ToIP ideas, one layer at a time:

| ToIP layer | What the demo shows |
|---|---|
| 1. Identifiers | Each person, and the list itself, has a self-certifying DID made from a key pair on their device. No registry. |
| 2. Trust spanning | People connect by scanning each other's invitation (an OOBI-style QR). Every message after that is a TSP message, encrypted to the recipient and signed by the sender. |
| 3. Trust tasks and credentials | The list is a small community. Its admin issues membership credentials with a role, and members acknowledge them. Each change to the list is a signed operation. Every member's device checks each operation against the list's rules before applying it. |
| 4. Application | The to-do list. |

The idea to leave the audience with: **there is no server you have to trust. Each copy of the list decides for itself, from signatures and credentials, what to accept. A relay helps offline members catch up, but it only ever holds ciphertext, and it can't forge anything.**

It also builds the shared trust plumbing that Community Rides will reuse (section 7).

## 2. Goals, non-goals, anti-goals

**Goals**

1. A scripted demo of about five to seven minutes, with a "next step" button and a one-line caption per step. Runs on one laptop with one command.
2. Free play on the same screen.
3. Real cryptography and real wire formats, as in Community Rides: TSP through `@openvtc/vti-tsp-js` and `@openvtc/trust-tasks-tsp`, Trust Task envelopes through `@openvtc/trust-tasks`, and Data Integrity proofs through `@openvtc/trust-tasks-proof` (S02). Tampering really fails.
4. Make it visible that each device decides on its own: every copy of the list shows the operations it accepted, and the ones it rejected with the reason.

**Non-goals**

- Production use, persistence across reloads, real devices or networking. All agents run in one browser page, as in Community Rides.
- Merging edits in a real offline-first way. Ordering is simple (section 4.5).
- Several lists. One list is enough to show the ideas.

**Anti-goals**

- **A trusted server.** No component may read the list, change it, or decide who is in. Each member's device holds its own copy. The relay stores sealed messages it can't open.
- **Mocked checks.** Every tick and every rejection comes from code that computed it.
- **Copyleft code.** No GPL or other copyleft dependency, and nothing from the TrustStackers repositories (S03).
- **Overclaiming.** Section 8 lists where we guessed how the stack would do it.

## 3. The story

The list is "Maple St House", a household's shared list. All names are fictional.

| Who | Role |
|---|---|
| Alice | Creates the list, so she's its admin. Her device holds the list's keys. |
| Bob | Housemate. Role `editor`. |
| Carol | The landlord. Role `viewer`: she can see the list but not change it. |
| Mallory | Not a member. Tries to get in. |
| The relay | A mailbox "hosted by anyone". It keeps sealed messages for members who are offline. Not trusted. |

Scripted steps, one or more presses of "next" each:

1. **Everyone has an identity.** Five panes, each showing a DID made on that device: four people and the relay. The caption says nobody registered anywhere.
2. **Alice creates the list.** Her device makes a new key pair and DID for "Maple St House" and records the rules: who may add, check off, edit and delete. Alice holds an admin membership credential issued by the list.
3. **Alice invites Bob.** Alice shows an invitation QR, and Bob's device "scans" it. They connect, and the first encrypted message appears on the wire panel. The list issues Bob an `editor` membership credential, and Bob's device signs an acknowledgement back. That's the two-way relationship. Bob's device gets a copy of the list.
4. **Alice invites Carol** the same way, as `viewer`.
5. **Bob adds "Milk", and Alice adds "Fix the porch light".** Each addition is an operation the author's device signs and sends, encrypted, to each other member. The other devices each check it before showing it: the signature is the author's, the author's membership is valid and not revoked, and their role may add. The wire panel shows only ciphertext.
6. **Alice adds a private item.** "Carol's birthday present", readable only by Alice and Bob. It goes into everyone's copy of the list, but its text is encrypted so that only Alice and Bob can read it. Carol's pane shows "🔒 private item by Alice". Carol's device still checked it and accepted it: the signature is Alice's and an admin may add, so permission can be verified without reading the content. The caption says what still leaks: that a private item exists, who wrote it, when, and who can read it.
7. **Carol tries to add "Raise rent".** Her app refuses locally, because viewers can't add. In free play there is a "send anyway" switch that sends it regardless, and the scripted demo uses it. Alice's and Bob's devices reject it: "viewer may not add". The rejection shows in each pane's "rejected" list, and the item appears nowhere.
8. **Mallory tries to sneak in.** Bob once showed Mallory his membership credential, to prove he lives there. Credentials are not secrets. She sends an operation with it. Everyone rejects it: "credential is for someone else". The message is signed by Mallory's key, not Bob's.
9. **Bob goes offline.** Bob's device disconnects. Alice checks off "Milk". Her message to Bob can't be delivered, so her device leaves it, still sealed for Bob, at the relay. The relay pane shows a message it can't read.
10. **Bob catches up.** Bob reconnects, collects the message from the relay, and his device checks Alice's signature before applying it. The caption: "the relay delivered it, but Alice's signature says who wrote it".
11. **Alice removes Bob.** Alice revokes Bob's membership. The list's signed revocation list goes to every member. Bob's next edit is rejected by Alice and Carol: "membership revoked". The caption says Bob still has his old copy. Revocation stops future changes; it can't make anyone forget.
12. **Tampering.** Bob, now removed, edits a copy of Alice's "Fix the porch light" operation to say "Give Bob his deposit back" and forwards it to Carol. Carol's device rejects it: "operation: signature does not verify".

Free play allows any of these actions from any pane: invite, add (shared or private, choosing the readers), check, uncheck, edit, delete, go offline, collect from the relay, sync from a chosen member, revoke, "send anyway", and forward a tampered copy of a held operation.

## 4. How it works

### 4.1 Identities

Each person has one Ed25519 key pair and a `did:key`. The list has its own key pair and `did:key`, held on Alice's device. A community can be as small as one key that one person holds. Later, its governance could move to several keys without the list's DID changing. That part is out of scope, and the caption says so. X25519 encryption keys are derived from the Ed25519 keys (S02 glossary). The choice of `did:key` over `did:peer:4` is the same call as in Community Rides.

### 4.2 Connecting

An invitation is a small JSON object, shown as a QR code: the inviter's DID, the list's DID, a display name and a one-time code. This is OOBI-style (S02 glossary), not the stack's OOBI format. **(our call)**

Scanning it makes the invitee's device send `todo/join` to the inviter, carrying the one-time code and the invitee's display name. The admin's device checks the code, and the list's key issues the membership credential.

This is a simplification. The stack forms relationships with a TSP RFI/RFA handshake (S02), but `@openvtc/trust-tasks-tsp` carries only Direct messages, so the relationship here starts at the first Direct message. The caption and section 8 say so.

### 4.3 Credentials

All are VC-shaped JSON with one issuer and one `eddsa-jcs-2022` proof, as in Community Rides.

| Credential | Issuer | Subject | Carries |
|---|---|---|---|
| Membership | the list | member DID | list DID, role (`admin`, `editor` or `viewer`), revocation index |
| Acknowledgement | the member | the list DID | the member's acceptance |

The list's revocation list is a signed bit list, as in Community Rides. Alice's device re-signs it on each revocation and sends it to every member with `todo/status`.

### 4.4 Operations

An operation is a signed JSON record, separate from the message that carries it, so that anyone can forward it and it still proves its author **(our call)**. It has an `id`, the list DID, the author DID, a kind (`add`, `check`, `uncheck`, `edit`, `delete`), the item id, the text where relevant, a timestamp from the demo clock, and the author's membership credential id. The proof is the author's.

Operations travel in `todo/op` messages: one sealed TSP message to each member the sender knows, with the author's membership credential alongside. `todo/sync` asks a member for every operation it has accepted, and the reply carries the signed operations, which the asker checks one by one.

### 4.4a The relay

When a message can't be delivered because the recipient is offline, the sender's device wraps the already-sealed TSP message in a `todo/relay/deposit` to the relay. The relay stores it under the recipient's DID. When the recipient is back, its device sends `todo/relay/collect`. The relay checks that the TSP sender is that DID and returns the stored messages. The recipient opens each one as if it had arrived directly, and checks it the usual way.

The relay can't read the inner messages, and can't change them without breaking their seal. It does learn who messages whom, when, and how much. It could also drop messages, which the demo doesn't show.

This stands in for the stack's planned Routed Mode, in which intermediaries relay messages they can't read (S02). **(our call)**

### 4.4b Private items

A private `add` names its readers (by DID) and carries no plain text. Instead:
- The text is encrypted with a fresh random key for that item (ChaCha20-Poly1305).
- The key is sealed separately to each reader's X25519 key with HPKE base mode, the same RFC 9180 suite TSP uses (S02).
- Later `edit`s to a private item encrypt the new text under the same item key.

The author is always a reader. Readers are fixed when the item is added: adding or removing readers later is out of scope.

Everyone stores and checks a private operation. The signature covers the ciphertext, so a device can check who wrote it and whether their role allows it without being able to read it. The readers list, the author and the time are visible to every member. That's the leak, and the UI says so.

**Admins don't see private items unless they are listed as readers. (our call)** Whether an admin may always read private items is a governance rule a real list would have to state.

### 4.5 Each device decides

When an operation arrives, directly or forwarded, the device checks it in this order, and records the first failure as the reason:

1. The operation's signature verifies, and its author is its issuer.
2. When delivered directly, the TSP sender is the author. A forwarded operation skips this check and is marked "forwarded by <name>".
3. The author's membership credential (sent alongside, or already held) verifies, is issued by the list, has the author as its subject, and isn't revoked in the latest revocation list this device holds.
4. The list's policy allows this role to do this kind of operation on this item, including the private-item rule below.

Accepted operations are applied in timestamp order, with the author DID as the tie-break. An operation on an item that doesn't exist, or one that's been deleted, is rejected: "no such item".

### 4.6 The rules

Rego, as in Community Rides, compiled to WebAssembly and evaluated on each device:

| Kind | admin | editor | viewer |
|---|---|---|---|
| add | yes | yes | no |
| check, uncheck, edit | yes | yes | no |
| delete | yes | only items they added | no |
| invite, revoke | yes | no | no |

On a private item, only its readers may check, uncheck, edit or delete it, and only within their role. For example, a viewer reader still can't edit.

The fixed reason strings follow the pattern `"<role> may not <kind>"`, plus `"not a reader of this item"`, `"membership revoked"`, `"not a member"`, `"credential is for someone else"`, `"operation: signature does not verify"` and `"no such item"`.

## 5. What's on screen

One page at 1920×1080. **(our call)**

- **Four person panes**, plus a relay pane that lists the sealed messages it holds (for whom, size, first bytes) and "what I can read: nothing". Each person pane shows:
  - that person's DID
  - the credentials they hold
  - their copy of the list
  - a "rejected" list with reasons
  - their connections
  - an online/offline switch
  - free-play actions
- **A wire panel**: one row per TSP message, with sender, receiver, size and the first bytes. Clicking a row shows the decrypted content, labeled "only <name> can read this".
- **Demo controls**: next, previous, reset, the step caption, and a scripted or free-play switch.

The four lists side by side make the main point without words: after step 6, every pane is missing "Raise rent" for its own reason.

## 6. Disclosure

A test asserts this table.

| Party | Learns |
|---|---|
| A network observer | Who messages whom, when, and how much. Never item text or roles. |
| The relay | The same as an observer, for the messages it holds. Never their content. |
| A member who isn't a reader of a private item | That it exists, who wrote it, when, who can read it, and whether it's checked off. Never its text. |
| Mallory (not a member) | Nothing about the list. In step 8 she holds Bob's membership credential, because Bob showed it to her. |
| Carol (viewer) | Everything on the list, as the role allows. |

## 7. Shared plumbing with Community Rides

Both apps need the same core: identities, the demo clock, the in-memory bus, the Trust Task endpoint over TSP, credentials, the status list, and the Rego policy loader. That is Tasks 1 to 4 of `projects/community-rides/docs/plan.md`. It moves into a shared package, `packages/trust-core/`, built first and used by both apps (decision 0003). Each app's Rego policies stay in the app.

## 8. Where we guessed about the stack

- Relationship formation without the TSP RFI/RFA handshake (section 4.2).
- An invitation format that's OOBI-style, not the stack's.
- `did:key` instead of `did:peer:4`.
- A list as a community whose key one person holds. The stack's VTCs have a governance document and M-of-N signing (S02), which this demo doesn't model.
- Operation, sync, relay and private-item formats are ours: `https://zk-toip.example/spec/todo/<name>/0.1`.
- A relay through a deposit-and-collect task, not TSP Routed Mode.
- That the OpenVTC libraries behave like the P2P Trust Stack's own implementation (S03).

## 9. Testing and done

- Tests for the shared core as in Community Rides' plan, Tasks 1 to 4.
- App tests: each check in section 4.5 rejects with its reason string; the role table in 4.6, one test per cell; sync from a third party accepts forwarded operations and rejects tampered ones; revocation takes effect at every member.
- A headless scenario test that runs steps 1 to 12 and asserts each pane's list and rejected list after each step.
- A disclosure test: no wire record contains item text in plaintext; the relay's stored state contains no item text; Carol's state never contains the private item's text.
- Done: steps 1 to 12 run in the browser from a fresh install, the tests pass, and the README explains how to run it and lists section 8's guesses.

## 10. Left to the builder

Visual design; field names; the Rego text; the bus API; how the scenario drives the UI; whether invitations show a real QR image or a stand-in.
