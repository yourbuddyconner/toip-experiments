# Shared To-Do Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared trust core, then a one-page browser demo of a shared to-do list on it: four people and a relay, each holding its own copy, with every change checked on each device.

**Architecture:** An npm workspace at the repository root. `packages/trust-core` (`@zk-toip/trust-core`) holds framework-free plumbing: clock, identity, bus, Trust Task endpoint over TSP, credentials, status list, item sealing, and the Rego loader. `projects/shared-todo` holds the to-do domain (`src/todo`), its Rego policy (`policies/`) and a React view (`src/web`). Agent code runs unchanged in Node tests and the browser.

**Tech Stack:** As in `projects/community-rides/docs/plan.md`, plus `@noble/ciphers` for ChaCha20-Poly1305.

**Spec:** `projects/shared-todo/docs/design.md` (§ numbers refer to it). The shared core's detailed tasks are Tasks 1 to 4 of `projects/community-rides/docs/plan.md`. Build those here, in `packages/trust-core`, with the changes listed in Task 1 below.

## Global Constraints

- All of Community Rides' plan Global Constraints apply: pinned `@openvtc/*` versions, `did:key` identities, every document signed, no runtime network access, no copyleft dependencies, components take the demo clock and never read `Date.now()`, and a license check whenever `package.json` changes.
- Our type URIs: `https://zk-toip.example/spec/todo/<name>/0.1`. Names: `join`, `op`, `sync`, `status`, `relay/deposit`, `relay/collect`.
- List name: "Maple St House". People: Alice (admin), Bob (editor), Carol (viewer), Mallory (not a member), plus the relay. Seeds: `sha256("shared-todo/<name>")`, and `sha256("shared-todo/list")` for the list.
- The demo clock starts at `2026-11-05T14:30:00Z`.
- Fixed reason strings: `"<role> may not <kind>"` (for example `"viewer may not add"`), `"not a reader of this item"`, `"membership revoked"`, `"not a member"`, `"credential is for someone else"`, `"operation: signature does not verify"`, `"membership: signature does not verify"`, `"not from its author"`, `"no such item"`.

## Review Focus

1. **A message to an offline member** must go to the relay, not be lost, and not hang the sender. Pinned in Task 3.
2. **An operation arriving twice** (directly, and again through sync or the relay) is applied once, with no duplicate item and no false rejection. Pinned in Task 2.
3. **A forwarded copy with the same id but different content** is rejected for its signature, and the original stays. Pinned in Task 2.
4. **Pressing "next" during a step, or out of order,** is refused. Pinned in Task 4.
5. **A reader who can't decrypt** (a bad wrapped key) shows the item as unreadable and doesn't crash. Pinned in Task 2.

---

### Task 1: Workspace and `@zk-toip/trust-core`

Build Community Rides' plan Tasks 1 to 4 in `packages/trust-core/` (sources in `src/`, tests in `tests/`), with these changes:

- The root `package.json` is `private`, with `workspaces: ["packages/trust-core", "projects/shared-todo"]`.
- The package exports everything from `src/index.ts`.
- `Policies` becomes generic, with no ride-specific decision points: `Policies.load(wasm: BufferSource): Promise<Policies>` and `evaluate<T>(entrypoint: string, input: object): T`. The ride-specific Rego and its tests stay with Community Rides. The core's test uses a small fixture policy compiled into `tests/fixtures/policy.wasm`.
- `Endpoint` gains one-way messages:
  - `seal(to: string, spec: SpecPolicy, payload: unknown): Promise<Uint8Array>` builds, signs and packs a document.
  - `notify(to, spec, payload): Promise<"delivered" | "undelivered">` seals and sends, expecting no reply.
  - `ingest(wire: Uint8Array): Promise<void>` processes a wire as if it had just arrived. The relay's collect uses it.
  - A handler returning `undefined` sends no reply.
  - The endpoint's consumer takes a `freshness` option. For the to-do app it is `{ skewMs: 60_000, maxAgeMs: 7 * 24 * 3600_000 }`, because relayed messages arrive late.
- `Bus` gains `setOnline(vid: string, online: boolean)` and `isOnline(vid)`. Sending to an offline VID marks the record `undelivered`.
- New `src/sealing.ts`:
  - `sealItem(text: string, readers: { did: string; encryptionPublic: Uint8Array }[]): Promise<{ key: Uint8Array; sealed: SealedText }>`
  - `openItem(sealed: SealedText, me: Identity): Promise<{ key: Uint8Array; text: string } | null>`
  - `resealText(text: string, key: Uint8Array, readers…): SealedText`, for edits
  - `SealedText` is `{ nonce, ciphertext, keys: { to, enc, wrapped }[] }`, base64url throughout.
  - The text is ChaCha20-Poly1305 under a random 32-byte key. The key is wrapped per reader with `hpke.sealBase` from `@openvtc/vti-tsp-js`, with info `"zk-toip/todo/item-key"`.
  - `openItem` returns `null` when it has no wrapped key, or when unwrapping fails.

- [ ] Tests: everything listed in the rides plan for Tasks 1 to 4 (minus the ride policies), plus:
  - the endpoint's `notify` and `ingest`
  - offline delivery reports `"undelivered"`
  - `sealItem`, then `openItem` by a reader, gives the same text
  - `openItem` by a non-reader gives `null`
  - a corrupted `wrapped` gives `null`
- [ ] Commit: `trust-core: shared identity, TSP endpoint, credentials, status list, sealing, policy loader`.

### Task 2: To-do domain (operations, list state, policy)

**Files:** `projects/shared-todo/src/todo/{specs,ops,list,checks}.ts`, `projects/shared-todo/policies/todo.rego`, `policies/policy.wasm`. Tests: `tests/ops.test.ts`, `tests/list.test.ts`, `tests/policy.test.ts`.

**Interfaces:**
- `ops.ts`:
  - `type OpKind = "add" | "check" | "uncheck" | "edit" | "delete"`
  - `interface Op { id: string; type: "todo/op"; list: string; issuer: string /* author */; kind: OpKind; itemId: string; at: string; text?: string; sealed?: SealedText; readers?: string[]; membershipId: string; proof?: Proof }`
  - `signOp(author: Identity, clock: DemoClock, body: Omit<Op, "id" | "type" | "issuer" | "at" | "proof">): Op`
  - `verifyOp(op: Op, clock): Promise<boolean>`
  - `tamperOp(op: Op, text: string): Op` changes `text` without re-signing
- `checks.ts`: `checkOp(input: { op: Op; membership: Credential | undefined; directSender?: string; listDid: string; status: StatusListDoc; state: ListState; policies: Policies; clock: DemoClock }): Promise<{ ok: true } | { ok: false; reason: string }>`, implementing §4.5 in order:
  1. op signature
  2. `directSender === op.issuer` when given, else `"not from its author"`
  3. the membership: signature, issuer is the list, subject is the author, id equals `op.membershipId`, not revoked
  4. item existence
  5. the policy
- `list.ts`:
  - `interface Item { id: string; author: string; text?: string; locked: boolean; readers?: string[]; checked: boolean; addedAt: string }`
  - `class ListState { apply(op: Op, readable?: string): void; has(itemId: string): boolean; item(itemId: string): Item | undefined; items(): Item[]; seen(opId: string): Op | undefined }`. Items are in `addedAt` order, with the author as the tie-break.
- `todo.rego`: package `todo.authz`, entrypoint `todo/authz/decision`. Input is `{ role, kind, isItemAuthor, itemPrivate, isReader }`. Output is `{ allow, reasons }`, following the §4.6 table and the private-item rule.

- [ ] Tests:
  - every cell of the §4.6 role table
  - private items: a non-reader editor checking one gets `"not a reader of this item"`; a viewer reader editing gets `"viewer may not edit"`
  - each `checkOp` failure gives its reason string
  - **Review Focus 2:** the same op applied twice gives one item; a second arrival of a known op id with identical content returns `ok` and is a no-op
  - **Review Focus 3:** a known id with different content is rejected with `"operation: signature does not verify"`, and the original text stays
  - **Review Focus 5:** a private add with a corrupted wrapped key, at a reader, gives `locked: true` without throwing
- [ ] Commit: `shared-todo: operations, list state and policy`.

### Task 3: Member agent and relay

**Files:** `src/todo/member.ts`, `src/todo/relay.ts`, `src/todo/knowledge.ts`. Test: `tests/member.test.ts`.

**Interfaces:**
- `class RelayAgent { constructor({ identity, bus, clock }); readonly did: string; held(): { to: string; bytes: number; head: string; at: string }[] }`. It handles `relay/deposit { to, wire /* base64url */ }`, storing the message. It handles `relay/collect {}` by returning `{ wires }` for the TSP sender and deleting them.
- `class MemberAgent`:
  - Constructor and fields: `constructor({ name, bus, clock, policies, relayDid }); readonly did; readonly name; online: boolean`.
  - State: `list?: { did: string; name: string }`, `role?: Role`, `membership?: Credential`, `state: ListState`, `rejected: { at; opId; from; reason; summary }[]`, `members: Map<did, { name; role; membership: Credential }>`, `status?: StatusListDoc`, `lastError: string | null`, `sendAnyway: boolean`.
  - Admin only: `createList(name: string): void`, which holds the list identity, issues its own admin membership and makes the first status list. `invite(role: Role): Invitation` returns `{ inviter, list, listName, code }`. `revoke(memberDid: string): Promise<void>`.
  - Anyone: `scan(inv: Invitation): Promise<void>`, which sends `join`.
  - Edits: `add(text: string, readers?: string[]): Promise<string /* itemId */>`, `check(itemId)`, `uncheck(itemId)`, `edit(itemId, text)`, `remove(itemId)`. Each signs an op, checks it locally (it refuses when the check fails, unless `sendAnyway`), applies it locally, then `notify`s every known member. An `"undelivered"` member gets a `relay/deposit`.
  - Online and sync: `setOnline(on: boolean): Promise<void>` collects from the relay when coming online. `syncFrom(memberDid): Promise<void>`.
  - Free play: `forwardTampered(opId: string, text: string, to: string): Promise<void>` sends `tamperOp` of a held op in `sync` form.
  - `knowledge: KnowledgeLog`, the same shape as Community Rides.
- `join`:
  - The admin checks the code.
  - The list identity issues a membership credential (types `["VerifiableCredential", "TodoListMembership"]`, subject `{ id, list, role }`, a status entry).
  - The admin replies with `{ membership, members: [{ did, name, role, membership }], ops: [{ op, membership }], status }`.
  - The new member acknowledges (an acknowledgement credential sent in the `join` follow-up `op`-free `status` message, or recorded in `ext`; builder's choice, but it must be signed by the member and stored at the admin).
  - The admin announces the new member to the others with `status { status, members }`.
- `op` handler: `checkOp` with `directSender`. On reject, push to `rejected`. On accept, decrypt if a reader, then apply.
- `sync` handler: returns all accepted ops, each with its author's membership. The receiver checks each one without `directSender`.
- `status` handler: accepted only when the status list is signed by the list DID. It replaces `status` and merges `members`. A revoked member is dropped from the send set.

- [ ] Tests, with a real relay and four members:
  - invites work, and Bob's add appears at Alice and Carol
  - Carol's add with `sendAnyway` is rejected at Alice and Bob with `"viewer may not add"`
  - Mallory's op carrying Bob's membership is rejected with `"credential is for someone else"`
  - **Review Focus 1:** with Bob offline, Alice's check goes to the relay (`relay.held().length === 1`), and the item isn't checked at Bob until he comes back online; after `setOnline(true)` Bob's item is checked and the relay holds 0
  - after revoking Bob, his add is rejected with `"membership revoked"` at Alice and Carol
  - Bob's `forwardTampered` to Carol is rejected with `"operation: signature does not verify"`
  - a private item is readable at Alice and Bob, and `locked` at Carol
- [ ] Commit: `shared-todo: member agent and relay`.

### Task 4: World and scenario

**Files:** `src/todo/world.ts`, `src/todo/scenario.ts`. Tests: `tests/scenario.test.ts`, `tests/disclosure.test.ts`.

**Interfaces:** `class World { static create({ policyWasm }): Promise<World>; clock; bus; relay; people: { alice; bob; carol; mallory }; busy: boolean; stepIndex: number; runStep(n: number): Promise<void>; subscribe(fn): () => void }` and `STEPS: readonly { n; title; caption; run(w) }[]`, eleven of them as in §3. Advance the clock by 1 minute before each step, and by 1 hour before step 9.

- [ ] Tests:
  - the scenario: after each step, assert each pane's item texts, its locked count, its checked flags and its newest rejection reason, per §3
  - **Review Focus 4:** a concurrent `runStep` gives `"busy"`, and a step out of order gives `"out of order"`
  - two `create` calls give the same DIDs
  - disclosure, per design §6 and §9: no `raw` wire bytes contain `"Milk"`, `"Carol's birthday present"` or `"Raise rent"`; `JSON.stringify` of the relay's state and of Carol's state doesn't contain `"birthday present"`
- [ ] Commit: `shared-todo: world and scripted scenario`.

### Task 5: Web UI, README, browser check

**Files:** `projects/shared-todo/index.html`, `vite.config.ts`, `src/web/*`. Test: `tests/ui.test.tsx` (smoke).

- Layout per §5. Controls go across the top, the four person panes and the relay pane in a row, and the wire panel at the bottom.
- Each person pane shows its DID, credentials, list (locked rows show "🔒 private item by <name>"), rejected list, connections, an online switch and free-play actions. Mallory has a "use Bob's credential" action.
- A wire row click shows the decrypted document "only <name> can read this". Relay rows show "sealed for <name>".

- [ ] Smoke test: the app renders "Maple St House" after step 2, and five pane headings.
- [ ] `npm test` and `npm run build` pass.
- [ ] README: how to run, the steps, and the §8 guesses.
- [ ] Run `npm run dev`, click through all 11 steps in Chrome, and screenshot steps 6, 9 and 11.
- [ ] Commit: `shared-todo: web UI and README`.
