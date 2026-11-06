# Shared To-Do v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Shared To-Do into a working web app: one device per browser profile, persisted keys and data, a DID-authenticated WebSocket relay, convergent lists, and an optional inspector.

**Architecture:**
- `packages/trust-core` gains a `Transport` interface, a real clock, and a WebSocket `RelayTransport` client.
- `packages/relay` is the Node relay (`ws` server, `node:sqlite` queue).
- `projects/shared-todo/src/todo` holds the domain: roster, ops, convergent list model, checks, and `Device`, the per-person app core over a `Store`.
- `projects/shared-todo/src/web` is the React app over IndexedDB.

**Tech Stack:** As in v1, plus `ws` (MIT) for the relay server and `qrcode` (MIT) for invitation QR codes. Browsers and Node 22 both have a global `WebSocket` client.

**Spec:** `projects/shared-todo/docs/design.md` (v2). § numbers refer to it.

## Global Constraints

- **Inherited from v1's plan:** the Global Constraints there still apply. That covers pinned `@openvtc/*` versions, `did:key`, every document signed, no copyleft dependencies, and running `npm run licenses` whenever dependencies change.
- **Time:** app code takes a `Clock` (`now()`, `iso()`, `date()`). Production code uses `SystemClock`, and tests may use `DemoClock`.
- **Message types:** `https://zk-toip.example/spec/todo/<name>/0.1`, with names `join`, `welcome`, `join-refused`, `ack`, `op`, `roster`, `sync-request`, `sync` and `leave`.
- **Relay auth string:** `toip-relay-auth/v1|<challenge>|<relay URL>`.
- **Relay limits:** 256 KiB per message, 5,000 queued per recipient, 30-day expiry.
- **Default ports:** relay 8787, web 5181. `VITE_RELAY_URL` defaults to `ws://localhost:8787/v1`.
- **Reason strings:** `"malformed operation"`, `"for a different list"`, `"operation: signature does not verify"`, `"not from its author"`, `"from the future"`, `"not a member"`, `"credential is for someone else"`, `"membership: signature does not verify"`, `"membership revoked"`, `"<role> may not <kind>"`, `"not a reader of this item"`, `"no such item"`, `"duplicate operation id"`.

## Review Focus

1. **Two devices receive the same ops in different orders.** Both end up with the same list. Pinned in Task 3 by a permutation test.
2. **A device restarts mid-conversation.** Unacknowledged relay messages are redelivered and applied once. Its outbox survives the restart and is sent. Pinned in Task 4.
3. **An old or forged roster arrives.** It is ignored, and revocations stand. Pinned in Task 3.
4. **The relay drops its WebSocket connection.** The client reconnects with backoff, re-authenticates, and sends its outbox. Pinned in Task 2.
5. **An invitation is used twice, or after it expires.** The second use gets `join-refused` with a reason, and the joiner's UI shows it. Pinned in Task 4.

---

### Task 1: trust-core, Transport and clock

- `Clock` interface. Add `class SystemClock implements Clock` (and `DemoClock` implements it too).
- `interface Transport { attach(vid, deliver: (wire: Uint8Array) => Promise<void>): void; detach(vid): void; send(from: string, to: string, wire: Uint8Array): Promise<"live" | "queued" | "undelivered"> }`.
  - `Bus` implements it. It keeps `records()`, `setOnline` and `settle()` for tests.
- `Endpoint` takes `transport: Transport` and `clock: Clock`.
  - Add `onTraffic?: (e: { direction: "in" | "out"; peer: string; document: TrustTaskDocument<unknown>; bytes: number; at: string; delivery?: string }) => void`.
  - `notify` returns the transport's result.
  - Requests and responses stay, for tests.
- Export `canonicalJson` (JCS) from `@openvtc/trust-tasks-proof`'s `canonicalize`.
- Tests: the existing suite passes, plus a traffic-hook test.

### Task 2: Relay server and RelayTransport

`packages/relay` (`@zk-toip/relay`):
- `startRelay({ port, dbPath, publicUrl }): Promise<{ url: string; close(): Promise<void> }>`, using a `ws` `WebSocketServer` on the `/v1` path.
- The protocol (JSON text frames):
  - server sends `{t:"challenge", nonce}`
  - client sends `{t:"auth", did, sig}`
  - server sends `{t:"ready"}`, then `{t:"msg", id, from, wire, at}` for each queued message
  - client sends `{t:"ack", id}`
  - client sends `{t:"send", cid, to, wire}`, and the server replies `{t:"sent", cid, delivery:"live"|"queued"}`
  - server sends `{t:"error", cid?, code, message}`
- A `messages` table in SQLite, with expiry and the per-recipient limit.
- A `bin` script, `npm start --workspace @zk-toip/relay`, configured by `PORT`, `RELAY_DB`, `RELAY_PUBLIC_URL`.

`RelayTransport` in trust-core implements `Transport` over the global `WebSocket`:
- Its constructor takes `{ url, identity, clock?, outbox?: OutboxStore }`.
- It authenticates, reconnects with backoff (0.5 s doubling up to 15 s), and exposes `status: "connecting" | "connected" | "offline"` with `onStatus`.
- `send` while disconnected goes to the outbox (a memory default, or persisted through `OutboxStore`) and returns `"queued"`. The outbox is flushed in order once the server sends `ready`.
- Delivered messages are acknowledged only after `deliver` resolves.

Tests:
- authentication: good, wrong DID, bad signature, replayed signature from another URL
- live delivery
- queued delivery on connect
- ack then delete, and no ack means redelivery
- persistence across `close()` and restart with the same `dbPath`
- message too large
- the client: reconnects after the server restarts and flushes its outbox; status changes are emitted

### Task 3: Domain (roster, ops, list model, checks)

- **`roster.ts`.**
  - `RosterDoc { type: "todo/roster"; issuer: listDid; list; name; version; issuedAt; members: { did, name, role, membershipId, joinedAt, removedAt? }[]; proof }`.
  - `signRoster(listIdentity, clock, body)`.
  - `acceptRoster(held: RosterDoc | undefined, incoming: unknown, listDid, clock): Promise<{ ok: true; roster } | { ok: false; reason }>`. It accepts only when the type is right, the signature is the list's, the version is greater than the held one, and every held removal is kept.
- **`ops.ts`.** As in v1, plus `validateOpShape(x): x is Op`. Keys are `opKey(op) = issuer + "|" + id`.
- **`model.ts`.** `ListModel`, the convergent state.
  - `insert(op, readable?)` returns `"new" | "duplicate" | "conflict"`.
  - `items()` rebuilds per §4.6: sort by `(at, issuer, id)`, last-writer-wins for checked and text, and delete wins.
  - Also `has(itemId)`, `item(itemId)`, `ops()` and `get(key)`.
  - The text of a private item a device can read comes from its own decryption, cached by op key.
- **`checks.ts`.** `checkOp({ op, membership, roster, directSender, forwarded, listDid, model, policies, clock })` applies §4.5 in order and returns `{ ok, reason, duplicate? }`, with `"no such item"` marked `holdable: true`.

Tests:
- each §4.5 rule's reason
- removed-member ops: before `removedAt` and forwarded are accepted; direct, or at/after `removedAt`, are refused
- the roster rules: a lower or equal version, a dropped removal, the wrong signer and the wrong type are all refused
- **Review Focus 1:** a permutation test, where 6 ops (add, check, uncheck, edit, edit, delete of another item) are inserted in every order (720 orders) and give identical `items()`
- `(author, id)` duplicates: identical with keys reordered counts as a duplicate; different content under the same key is refused
- a malformed sealed part gives `"malformed operation"`

### Task 4: Device (the app core)

- **`store.ts`.** `interface Store { get<T>(key): Promise<T | undefined>; put(key, value): Promise<void>; delete(key): Promise<void>; keys(prefix): Promise<string[]> }`, plus `MemoryStore`.
- **`device.ts`.** `Device.open({ store, transport factory, relayUrl, clock, policies, name? })`.
  - It creates or loads the identity, the profile and the lists, and rebuilds the models from the stored ops.
  - **Lists:** `createList(name)`, `invite(listDid, role) → Invitation`, `encodeInvitation(inv)` and `decodeInvitation(text)` (a URL fragment `#invite=<base64url JSON>`), and `join(invitationText)`.
  - **Items:** `add(listDid, text, readers?)`, `setChecked`, `edit`, `remove`.
  - **Members:** `removeMember(listDid, did)` and `leave(listDid)`.
  - **Catching up:** `syncNow()`.
  - **Reading state:** `lists()`, `view(listDid)` (items, members, my role, pending join state, refusals, roster version) and `inspector()` (the log).
  - **Events:** `subscribe(fn)`.
  - It handles every §4.3 message and persists after each change.
  - It records invitations it issued, with an expiry of 7 days.
  - Pending joins are kept until a `welcome` or `join-refused` arrives.
  - Held ops (for missing items) are retried.
- **`inspector.ts`.** A ring buffer of 500 entries: traffic entries, check entries and refusals.

Integration tests (`tests/integration.test.ts`): a real relay with a temporary database, and 3 to 4 devices with `MemoryStore` and `RelayTransport`. They cover:
- the §8 list
- **Review Focus 2:** restart a device from its store between a send and its acknowledgement
- **Review Focus 5:** a reused invitation, and an expired one (by clock)
- the relay database file never contains item text

### Task 5: Web app, cleanup, README

- **Remove v1 code:** `world.ts`, `scenario.ts`, `member.ts`, the old `relay.ts`, `list.ts`, the old `src/web/*`, and their tests.
- **Storage:**
  - `IndexedDBStore` (database `toip-todo-<profile>`)
  - profiles from `?profile=`
  - a Web Lock per profile
  - the outbox persisted through the store
- **UI:**
  - first-run name screen
  - list sidebar
  - list view: items, the add field with private readers, item menu
  - members sheet: invite by link, QR and copy; remove; leave
  - join by link (`#invite=`) or paste
  - a pending-join banner
  - refusal notices
  - connection status
  - the inspector drawer: Activity, Identity, What the relay sees, Refused
  - mobile-first responsive layout
- **Root `npm run dev`:** starts the relay and Vite together (a small Node script that spawns both and forwards their output).
- **README:**
  - how to run
  - how to try it with two profiles
  - how to deploy (static build plus the relay behind TLS)
  - the security notes: keys in IndexedDB, bearer invitations, what the relay sees
  - §7's guesses
- **Tests:** a UI smoke test with a fake in-memory transport. `npm test` and `npm run build` pass.
- **Browser check:** Chrome with `?profile=alice` and `?profile=bob` in two tabs. Do the §3 flows, including offline (stop the relay, edit, start it again).
