# Shared To-Do: design (v2, a working app)

A shared to-do list app that people use on their own devices, with no server they have to trust. Built on the ToIP specs through the OpenVTC TypeScript libraries and this repository's `packages/trust-core`. Date: 2026-11-05.

v1 was a scripted, single-page demo. The convener asked for "a practical application that would be as close to reality as possible", not "a demo on rails". v2 replaces it (decision 0004). v1 is in git history at `54c7386`.

The convener chose: an installable web app, a relay server we write, and an optional inspector for the trust mechanics. Choices marked **(our call)** were made by the assistant. Section 4.8 lists what v1's code review taught.

## 1. What it is

A to-do app for households and small groups. Each person opens it in a browser on a laptop or phone, can install it, gives a display name, and then can:

- create lists and invite people with a link or QR code, as editor or viewer
- add, check off, edit and delete items, including private items that only chosen members can read
- keep working offline; changes send when the device reconnects
- remove members, or leave a list

Underneath, every person and every list has its own key and DID, made on the device. Membership is a credential the list's key signs. Every change is a signed operation sent to each member as a sealed TSP message, and every device checks every change before applying it. A relay passes sealed messages along and holds them for devices that are offline. It never sees list contents and can't forge changes.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Real use by real people on separate devices. Keys and data persist across restarts, and devices connect through a relay that can be deployed.
2. The trust model from v1: self-certifying identifiers, membership credentials with roles, signed operations checked on every device, private items and revocation, without v1's flaws (section 4.8).
3. It works offline. Changes made offline are sent on reconnect, and messages to an offline device wait at the relay.
4. Every device ends up with the same list once it has the same operations, whatever order they arrived in.
5. An optional inspector shows, for this device only, what it sent and received, each message as decrypted, the checks each change went through, and what the relay can see.
6. Runs locally with one command, and deploys as one static web app plus one small Node relay.

**Non-goals (for now)**

- Several devices per person. Each device is its own identity.
- Recovering a lost device's keys.
- Federation between relays. A list uses one relay.
- Hiding from the relay who talks to whom.
- Native mobile apps.

**Anti-goals**

- **A trusted server.** The relay must not be able to read lists, change them, or decide who is in.
- **Rails.** No scripted steps, and no global view of other people's devices. Each running app is one person's device and knows only what it was told.
- **Mocked checks.** Everything the inspector shows was computed.

## 3. Using it

**First run.** The app asks for a display name, then makes this device's key pair and DID and stores them.

**Lists.** A sidebar shows your lists, plus "New list" and "Join with a link". Creating a list makes a new key and DID for it on this device, and you are its admin.

**Inviting.** In a list's members sheet, an admin picks a role and gets an invitation as a link, a QR code and a copy button. An invitation can be used once and expires after 7 days.

**Joining.** Opening an invitation link, or pasting it, sends a join request to the inviter's device through the relay. If the inviter is offline, the request waits at the relay, and the joiner sees "Waiting for Alice's device to let you in". When the inviter's device next runs, it checks the code, issues a membership credential, and sends a welcome with the list so far. The joiner's device then signs an acknowledgement back.

**Items.** Add, check off, edit and delete. "Private" picks which members can read the item. Others see a locked row, "Private item from Alice".

**When a change is refused.** The device records why and shows a quiet notice, for example "A change from Carol was refused: viewers can't add items". The inspector shows the full check.

**Members.** Admins can remove a member. Anyone can leave a list.

**Offline.** The header shows "Connected" or "Offline: changes will send when you reconnect". A change applies locally right away and goes into an outbox, which is sent on reconnect.

## 4. Architecture

```
 browser device (one person)                       relay (Node)
 ┌──────────────────────────────────┐              ┌────────────────────────┐
 │ UI (React)                       │              │ WebSocket /v1          │
 │ Device: identity, lists, checks  │   sealed     │ DID challenge auth     │
 │ trust-core Endpoint (TSP)        │◀──TSP──────▶ │ live delivery          │
 │ RelayTransport (WebSocket)       │   bytes      │ queue for offline DIDs │
 │ IndexedDB store, outbox          │              │ (node:sqlite)          │
 └──────────────────────────────────┘              └────────────────────────┘
```

### 4.1 Identity and storage

- Each device has one Ed25519 key pair, made from 32 random bytes, which gives its `did:key`. Its X25519 key is derived from the Ed25519 key (S02). Each list's key pair is made the same way, on its admin's device.
- Everything is stored in IndexedDB: the seed, the display name, each list's operations, roster and credentials, the outbox, and the inspector log.
- **Keys are stored in plain IndexedDB (our call).** The TSP and signing libraries need raw key bytes, so WebCrypto non-extractable keys can't be used. Script running in the app's origin can read them. The README says so.
- **Profiles (our call).** A `?profile=<name>` URL parameter gives storage a separate namespace, so one browser can hold several people for local testing. Each profile is its own device with its own keys. Only one tab per profile is active at a time (Web Locks). Other tabs say "This profile is open in another tab".

### 4.2 The relay

A small Node service, `packages/relay`, with one WebSocket endpoint, `/v1`.

1. On connect, the relay sends a random challenge.
2. The client replies with its DID and an Ed25519 signature over `toip-relay-auth/v1|<challenge>|<relay URL>`. The relay verifies it from the `did:key`. Including the relay URL stops a signature being replayed at another relay.
3. The relay then delivers that DID's queued messages, each with a relay id. The client acknowledges each one once it has processed it, and the relay deletes it.
4. The client sends `{ to, wire }`. The relay delivers it live if `to` is connected, and otherwise queues it. Either way it confirms which.

Queues persist in SQLite (`node:sqlite`, built into Node 22.5+), so a relay restart loses nothing. Delivery is at least once, and devices drop duplicates.

Limits **(our call)**: 256 KiB per message, 5,000 queued messages per recipient, and queued messages expire after 30 days.

**What the relay learns:** each connected DID, who sends to whom, when, and how big. It can't read contents, because the messages are sealed TSP for the recipient. It could drop or delay messages. It can't forge or alter them, because the recipient checks the seal and the signatures. This stands in for the stack's planned Routed Mode (S02).

### 4.3 Messages

Every message is a Trust Task document (`trust-task/0.6.0` envelope), signed with a Data Integrity proof, sealed as a Direct TSP message, and sent through the relay. All messages are one-way, because either side may be offline. Types are under `https://zk-toip.example/spec/todo/<name>/0.1`.

| Message | From → to | Carries |
|---|---|---|
| `join` | joiner → inviter | invitation code, list DID, display name |
| `welcome` | admin → joiner | membership credential and the current signed roster; the history follows as `sync` pages |
| `join-refused` | admin → joiner | reason |
| `ack` | member → admin | the member's signed acknowledgement credential |
| `op` | author → each member | the signed op, and the author's membership |
| `roster` | admin → each current member | the current signed roster |
| `sync-request` | member → member | list DID |
| `sync` | member → member | the current signed roster, and one page of up to 100 ops with the membership credentials they need |
| `leave` | member → admin | list DID |

Operations are signed separately from the message that carries them, as in v1, so a forwarded op still proves who wrote it.

### 4.4 The roster: the list's signed state of membership

The list's key signs a **roster** document **(our call, prompted by v1's review)**. It replaces v1's separate status list and unsigned member lists. It has:

- the list DID and name
- a `version` that increases by one with each change
- an `issuedAt` time
- one entry per membership: the DID, display name, role, membership credential id, the date they joined, and, once removed, `removedAt` plus `keptOps`, the ids of that membership's ops the admin's device had accepted
- someone who left or was removed can be invited back; they get a new entry and a new credential

The roster is what a device trusts about membership:

- A device replaces its roster only with one that is signed by the list's key, is for the same list, has a **higher version**, and keeps every earlier removal. This stops an old roster from undoing a revocation, which was v1's critical bug.
- Display names come only from the signed roster. A name for a known DID never changes because a message said so.
- A roster can come from anyone, inside `welcome`, `roster` or `sync`. Because it is signed and versioned, the sender doesn't matter.
- Membership credentials still matter: an op must name its author's credential, and that credential must verify and match the roster entry.

### 4.5 What each device checks for an op

The checks from v1, in `src/todo/checks.ts`, with the Rego rules in `policies/todo.rego`, with fixes from v1's review:

1. The op is well formed: its fields have the right types, and a private op's sealed part has the right shape. Otherwise it is refused with `"malformed operation"`.
2. It is for this list. Otherwise `"for a different list"`.
3. Its signature verifies.
4. A direct op came from its author. A forwarded op is labeled with who forwarded it.
5. Its `at` time is no more than 5 minutes in the future by this device's clock.
6. Its author is a member in the roster, and the op names that member's membership credential, which verifies, was issued by the list, and is for the author.
7. The author's membership hadn't been removed, or the op is one its removal kept:
   - An op under a removed membership is accepted only if its id is in that entry's `keptOps`.
   - The rule depends only on the op and the newest roster, so every device reaches the same answer whatever order things arrive in (fix for v2 review I1). Adopting a roster with a new removal drops that membership's ops that weren't kept.
   - It keeps history from before a removal (v1's I5), stops a removed member from sending anything new, and rules out backdating.
8. The role rules, including private-item readers.

**Duplicates.** Ops are identified by `(author, id)`. A copy of a known op is ignored if it is identical in JCS canonical form. A different op under the same `(author, id)` is refused.

**Missing items.** An op on an item this device hasn't seen yet is held, not refused, and retried as other ops arrive. It is refused only if the item is still unknown after a sync.

### 4.6 Every device ends up with the same list

v1 applied ops in arrival order, so copies could disagree for good. That was v1's I4. v2 builds each item from its ops in a fixed order **(our call)**:

- Ops are sorted by `(at, author DID, op id)`.
- The add creates the item.
- For "checked" and for "text", the last op in that order wins.
- A delete wins over everything, permanently. A deleted item stays deleted.

Each device's clock sets `at`, so a device with a wrong clock can make its changes win or lose. Step 5's 5-minute limit bounds how far ahead it can be.

### 4.7 Private items

As in v1: the text is encrypted under a fresh item key, and that key is sealed to each reader with HPKE base mode. The author is always a reader. Readers are fixed when the item is created. Admins can't read private items unless they're listed as readers.

A locked row shows readers from the op's sealed key list, which is what was actually sealed, not from what the author claims (v1's M4).

### 4.8 What v1's review taught, and where v2 deals with it

| v1 finding | v2 |
|---|---|
| C1: an old status list could undo a revocation | A signed, versioned roster that must keep earlier removals (4.4) |
| I1: anyone could rename members | Names only from the signed roster (4.4) |
| I2, I3: "offline" still sent, and senders hung | Real offline: a local outbox, and the relay queues (3, 4.2) |
| I4: copies drifted | A fixed order, last write wins, delete wins (4.6) |
| I5: revocation erased history for newcomers | Ops before `removedAt`, when forwarded, are kept (4.5) |
| I5: removed members got roster updates | Roster messages go to current members only |
| I6: scripted captions out of step with what happened | No script |
| M1: duplicate detection by JSON text, and by global id | JCS canonical form, keyed by `(author, id)` (4.5) |
| M2: wrong reason for another list's op | `"for a different list"` (4.5) |
| M4: claimed readers | Readers from the sealed key list (4.7) |
| M5: any list-signed document taken as a status list | The roster has a type and is checked (4.4) |
| M8: a malformed sealed part threw | Shape checked first (4.5) |

### 4.9 Catching up

- On start and on reconnect, a device sends `sync-request` for each list to one other current member, a different one each time.
- A `sync` reply is processed like any forwarded op, one op at a time, and its roster like any roster.
- Ops held for missing items are retried after each sync.

### 4.10 The inspector

A side panel, closed by default, that shows only this device's view:

- **Activity:** each message sent or received, with time, the other party's name, type, size, the decrypted document, and the check results for received ops.
- **Identity:** this device's DID, and for each list its DID, your role, your membership credential and acknowledgement, and the roster version.
- **What the relay sees:** the same messages reduced to sender, recipient, time and size.
- **Refused:** every refused change, with its reason.

It keeps the last 500 entries.

## 5. Look and feel

A calm, practical list app that works well on a phone. It must not look like a debugger. Trust mechanics show only as a connection indicator, the lock on private rows, refusal notices, and the inspector. The visual design is left to the builder, for a real app used every day, not a projector.

## 6. Running and deploying

- `npm run dev` at the repository root starts the relay on `ws://localhost:8787` and the web app on `http://localhost:5181`.
- The web app's relay URL comes from `VITE_RELAY_URL`, defaulting to `ws://localhost:8787/v1`. An invitation carries its list's relay URL, so the joiner connects to the same relay.
- To deploy, build the web app to static files, and run `packages/relay` anywhere Node 22.5+ runs, behind TLS (`wss://`). The README explains how.

## 7. Where we guess about the stack

- Relationships start with the first Direct TSP message, not the RFI/RFA handshake.
- `did:key` instead of `did:peer:4`.
- Invitations are links carrying an OOBI-style object, not the stack's OOBI format.
- A list is a community whose key its creator holds. Real VTCs have a governance document and M-of-N signing.
- The relay is our own WebSocket mailbox, not TSP Routed Mode or the stack's libp2p relays.
- Our message types and formats are under `https://zk-toip.example/spec/todo/…`.
- That the OpenVTC libraries interoperate with the P2P Trust Stack's own implementation. This wasn't checked.

## 8. Testing and done

- **Unit tests** for trust-core, the op checks (including each section 4.5 rule), the roster rules (4.4) and the ordering (4.6). Ordering is tested by applying the same ops in many orders and asserting the same result.
- **Relay tests:**
  - authentication: a good signature, a wrong DID, and a replayed signature
  - live delivery
  - queueing, and delivery on connect
  - acknowledgement and deletion
  - persistence across a relay restart
  - the limits
- **Integration tests in Node:** a real relay on a random port, and several devices using the real WebSocket transport and an in-memory store. They cover:
  - create, invite and join, including while the inviter is offline
  - shared and private items
  - a viewer's refused change
  - someone else's credential refused
  - an offline device's outbox sent on reconnect
  - catching up by sync
  - revocation, and the history before a removal kept for a later joiner
  - an old roster refused
  - leaving a list
  - a device restored from its store after a restart
  - the relay's database never containing item text
- **A UI smoke test**, and a **manual check in Chrome** with two or three profiles.
- **Done** when two people on two browser profiles can do everything in section 3 through a relay running locally, the tests pass, and the README covers running, deploying and the security notes.

## 9. Later

Several devices per person, by delegating from a person's DID to device keys. Key recovery. Lists governed by more than one admin key. Federation across relays. Community Rides on the same core.
