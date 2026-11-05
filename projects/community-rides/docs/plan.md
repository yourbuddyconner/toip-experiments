# Community Rides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-page browser demo of a community ride-share on the Apache-2.0 OpenVTC libraries for the ToIP specs the P2P Trust Stack uses: real TSP messages, real Trust Task envelopes, real Data Integrity signatures, and Rego policies decided on each phone.

**Architecture:** One npm package in `projects/community-rides/`. Framework-free agent code in `src/core` (identity, clock, bus, Trust Task endpoint, credentials, status list, policy loader) and `src/rides` (community agent, member agent, world, scenario) runs unchanged in Node tests and in the browser. `src/web` is a React view over a `World`. Rego policies in `policies/` compile to one committed `policy.wasm`.

**Tech Stack:** TypeScript 5, Node 22 (20 or later), Vite, React, Vitest, `@openvtc/trust-tasks`, `@openvtc/trust-tasks-tsp`, `@openvtc/trust-tasks-proof`, `@openvtc/vti-tsp-js`, `@noble/curves`, `@noble/hashes`, `@open-policy-agent/opa-wasm`, OPA CLI 1.22.1 (to rebuild policies only).

**Spec:** `projects/community-rides/docs/design.md`. Section numbers below (§) refer to it.

## Global Constraints

- All paths below are relative to `projects/community-rides/`. Run every command from there.
- Pin exact versions (`npm install --save-exact`): `@openvtc/trust-tasks` 0.28.17, `@openvtc/trust-tasks-tsp` 0.1.2, `@openvtc/trust-tasks-proof` 0.1.6, `@open-policy-agent/opa-wasm` 1.10.0. `@openvtc/vti-tsp-js` is whatever `-tsp` 0.1.2 resolves (0.2.x). Don't add 0.4.0.
- Use the prebuilt spec modules by deep import (`@openvtc/trust-tasks/vtc/endorsements/issue/0.1/payload`), not `trust-tasks-gen`. They are deprecated. Record this in the README (§5.3 allows it).
- No network access at runtime. Everything is in the page.
- No GPL or other copyleft dependencies, direct or transitive. Don't read or copy code from the `TrustStackers` repositories. Before each commit that changes `package.json`, list the licenses in `node_modules` and confirm none is copyleft.
- `did:key` (Ed25519) for every VID. X25519 keys are derived from the Ed25519 key (`ed25519.utils.toMontgomerySecret` and `ed25519.utils.toMontgomery` in `@noble/curves` 2.x).
- Every Trust Task document we send carries a Data Integrity proof (`signTrustTask`), responses included. Our own specs set `isProofRequired: true`, `isRecipientRequired: true`, `isIssuedAtRequired: true` and `isBearer: false`.
- Our namespace: type URIs `https://zk-toip.example/spec/rides/<name>/0.1`. The driver predicate is `https://zk-toip.example/rides/driver/1`. The extension key in `ext` is `example.zk-toip.rides`.
- The community's name is "Eastside Rides". People: Alice, Bob, Carol (admin), Dave, Mallory. Keys come from `sha256("community-rides/<name>")`.
- The demo clock starts at `2026-11-05T14:30:00Z`. Every component takes the clock, and none reads `Date.now()`.
- Status-list freshness limit: 600 seconds. Vouch age limit: 30 days. Admission needs 2 vouches.
- Fixed reason strings (asserted by tests and shown in the UI): `"driver endorsement revoked"`, `"driver endorsement: signature does not verify"`, `"no driver endorsement"`, `"membership revoked"`, `"membership: signature does not verify"`, `"no membership"`, `"revocation list stale"`, `"revocation list: signature does not verify"`, `"needs 2 vouches from current members, has <n>"`, `"not a member"`, `"not an admin"`.
- No mocked ticks. Every check shown in the UI comes from a function that computed it (§2 anti-goals).

## Review Focus

1. **A request that never gets a reply.** A handler that is suppressed (replay, staleness) or a recipient that isn't on the bus must give the caller a `TaskError`, not a promise that hangs. Pinned in Task 2.
2. **Pressing "next" during a step.** Steps must run one at a time. A second `runStep` while one is running is refused, and the UI disables the button. Pinned in Task 7.
3. **Free play out of order.** For example, Alice posts before joining, or Bob offers before he's a driver. The community or the phone refuses with a reason, and the UI shows it in place, without crashing. Pinned in Tasks 5 and 6.
4. **Acting on a post that's already matched.** An offer on a matched or withdrawn post is refused by the rider's pseudonym with `"post is not open"`, and a second withdraw is refused by the community the same way. Pinned in Tasks 5 and 6.
5. **Previous and reset.** Rebuilding the world must give the same DIDs and the same step outcomes, so "previous" (reset, then replay steps 1..n-1) is safe. Pinned in Task 7.

---

### Task 1: Scaffold, clock and identity

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (`node_modules`, `dist`, `policies/bundle.tar.gz`)
- Create: `src/core/clock.ts`, `src/core/identity.ts`
- Test: `tests/identity.test.ts`

**Interfaces:**
- Produces:
  - `class DemoClock { constructor(startIso: string); now(): number; iso(): string; date(): Date; advance(ms: number): void; subscribe(fn: () => void): () => void }`
  - `interface Identity { did: string; signingSecret: Uint8Array; signingPublic: Uint8Array; encryptionSecret: Uint8Array; encryptionPublic: Uint8Array; signer: Signer }`. `Signer` comes from `@openvtc/trust-tasks-proof`.
  - `seedFrom(label: string): Uint8Array`, which is sha256 of the UTF-8 label
  - `identityFromSeed(seed: Uint8Array): Identity`
  - `resolveDidKey(did: string): { signingKey: Uint8Array; encryptionKey: Uint8Array }`. It throws `Error("not an Ed25519 did:key")` on anything else.

- [ ] **Step 1:** Create `package.json` with `"type": "module"` and scripts `test` (`vitest run`), `dev` (`vite`), `build` (`tsc --noEmit && vite build`) and `policies` (Task 4). Install the pinned dependencies plus `typescript`, `vitest`, `vite`, `react`, `react-dom`, `@types/react`, `@types/react-dom` and `@vitejs/plugin-react`. Use strict `tsconfig` with `moduleResolution: "bundler"`.
- [ ] **Step 2: Write the failing tests** in `tests/identity.test.ts`:
  - `identityFromSeed(seedFrom("community-rides/alice"))` called twice gives the same `did`, and the DID starts with `did:key:z6Mk`.
  - `resolveDidKey(id.did).signingKey` equals `id.signingPublic`, and `.encryptionKey` equals `id.encryptionPublic`.
  - `x25519.getPublicKey(id.encryptionSecret)` equals `id.encryptionPublic` (the derivation is consistent).
  - `resolveDidKey("did:web:example.com")` throws `"not an Ed25519 did:key"`.
  - `new DemoClock("2026-11-05T14:30:00Z")`, then `advance(60_000)`, gives `iso() === "2026-11-05T14:31:00.000Z"`, and the subscriber is called once.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 4:** Implement both files. `did` comes from `didKeyFromPublicKey({ curve: "ed25519", bytes })`, and `signer` from `signerFromPrivateKey("ed25519", signingSecret)`. Both are in `@openvtc/trust-tasks-proof`. `resolveDidKey` uses `publicKeyFromDidKey`.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6:** Commit: `community-rides: scaffold, demo clock, did:key identities`.

### Task 2: Bus and Trust Task endpoint over real TSP

**Files:**
- Create: `src/core/bus.ts`, `src/core/tasks.ts`
- Test: `tests/tasks.test.ts`

**Interfaces:**
- Consumes: `DemoClock`, `Identity`, `resolveDidKey` (Task 1).
- Produces:
  - `interface WireRecord { seq: number; at: string; from: string; to: string; bytes: number; head: string /* hex of first 24 bytes */; raw: Uint8Array; undelivered?: true; opened?: { by: string; document: TrustTaskDocument<unknown> } }`
  - `class Bus { constructor(clock: DemoClock); attach(vid: string, deliver: (wire: Uint8Array, rec: WireRecord) => Promise<void>): void; detach(vid: string): void; send(from: string, to: string, wire: Uint8Array): WireRecord; records(): readonly WireRecord[]; subscribe(fn: () => void): () => void }`. Delivery is asynchronous (`queueMicrotask`). An unknown `to` marks the record `undelivered`.
  - `class Refusal { constructor(readonly code: string, readonly message: string) }`. A handler returns it to refuse.
  - `class TaskError extends Error { readonly code: string }`
  - `type Handler<P, R> = (doc: TrustTaskDocument<P>, ctx: { sender: string }) => Promise<R | Refusal> | R | Refusal`
  - `class Endpoint { constructor(opts: { identity: Identity; bus: Bus; clock: DemoClock }); readonly vid: string; handle<P, R>(spec: SpecPolicy, handler: Handler<P, R>): void; request<P, R>(to: string, spec: SpecPolicy, payload: P): Promise<TrustTaskDocument<R>>; close(): void }`
  - `function ourSpec(name: string): SpecPolicy`. It returns the type URI `https://zk-toip.example/spec/rides/<name>/0.1` with the flags in Global Constraints.

How `Endpoint` works:
- Outgoing requests are documents with `id` from `newUrnUuid()`, `issuer = vid`, `recipient = to`, and `issuedAt`/`expiresAt` (+5 min) from the clock. They are signed with `signTrustTask(doc, identity.signer, { created: clock.date() })`, sealed with `packTrustTask`, and sent on the bus.
- Incoming messages go through `unpackTrustTask`, which sets `rec.opened`. A type ending `#response`, or the `trust-task-error` type, settles the pending request whose id equals `threadId`. This happens only after `DataIntegrityProofVerifier` (with `now: clock.now`) verifies the proof, and only when the authenticated sender is the one asked. Anything else is dispatched by `type` to `TspConsumer.consume(unpacked, spec, wrapped)`. The consumer uses `proofVerifier`, `now: clock.now` and one `InMemoryReplayGuard` per endpoint.
- The wrapped handler maps a returned value to `signTrustTask(respondWith(doc, newUrnUuid(), value, clock.iso))`, and a `Refusal` to `rejectWith`. It then sends `consumer.packReply(received)` on the bus.
- An unknown type gets a `trust-task-error` with the standard code for an unsupported type (pick it from `STANDARD_CODES`).
- `request` rejects with `TaskError(code, message)` on an error response, with `TaskError("undelivered")` when the bus can't deliver, and with `TaskError("timeout")` after 3000 ms real time with no reply.

- [ ] **Step 1: Write the failing tests** in `tests/tasks.test.ts`, with two endpoints (Alice and Bob) on one bus, and a spec `ourSpec("echo")` whose handler returns `{ echoed: payload.text }`:
  - `alice.request(bob.vid, echo, { text: "hi" })` resolves to a document whose `payload.echoed === "hi"`, `issuer === bob.vid` and `type` ends with `#response`.
  - The bus holds two records. Neither `raw` contains the UTF-8 bytes of `"hi"`. Both have `opened.by` set to the receiving VID.
  - A handler returning `new Refusal("forbidden", "nope")` makes `request` reject with a `TaskError` whose `message` contains `"nope"`.
  - A request to an unknown VID rejects with `code === "undelivered"`.
  - **Review Focus 1:** with Bob's handler for `ourSpec("slow")` never resolving, `request` rejects with `code === "timeout"`. Use fake timers, or make the timeout injectable through a constructor option `timeoutMs`.
  - Replaying the same wire bytes to Bob a second time doesn't run the handler twice. Count the calls.
- [ ] **Step 2:** Run `npm test -- tasks`. Expected: FAIL.
- [ ] **Step 3:** Implement `bus.ts` and `tasks.ts` as specified above.
- [ ] **Step 4:** Run `npm test -- tasks`. Expected: PASS.
- [ ] **Step 5:** Commit: `community-rides: bus and Trust Task endpoint over TSP`.

### Task 3: Credentials and status list

**Files:**
- Create: `src/core/credentials.ts`, `src/core/statusList.ts`
- Test: `tests/credentials.test.ts`

**Interfaces:**
- Consumes: `Identity`, `DemoClock`.
- Produces:
  - `interface Credential { "@context": string[]; id: string; type: string[]; issuer: string; validFrom: string; validUntil?: string; credentialSubject: { id: string; [k: string]: unknown }; credentialStatus?: { type: "BitstringStatusListEntry"; statusListIndex: number; statusListCredential: string }; proof?: Proof }`
  - `issueCredential(issuer: Identity, clock: DemoClock, body: { type: string[]; credentialSubject: Credential["credentialSubject"]; validUntil?: string; credentialStatus?: Credential["credentialStatus"] }): Credential`. It sets `@context` to `["https://www.w3.org/ns/credentials/v2"]`, `id` to `urn:uuid:…`, `validFrom` from the clock, and the proof through `signTrustTask` (cast).
  - `type CredentialCheck = { ok: true } | { ok: false; failure: "signatureInvalid" | "issuerMismatch" | "malformedProof" | "notYetValid" | "expired" }`
  - `verifyCredential(vc: Credential, clock: DemoClock): Promise<CredentialCheck>`. It maps `verifyDetailed`'s failure, then checks `validFrom` and `validUntil` against the clock.
  - `interface StatusListDoc { id: string; type: "rides/status-list"; issuer: string; issuedAt: string; length: number; bits: string /* base64url */; proof?: Proof }`
  - `class StatusList { constructor(length?: number /* 1024 */); allocate(): number; revoke(index: number): void; isRevoked(index: number): boolean; sign(issuer: Identity, clock: DemoClock): StatusListDoc }`
  - `checkStatus(doc: StatusListDoc, index: number, expectedIssuer: string, clock: DemoClock): Promise<{ signatureValid: boolean; revoked: boolean; ageSeconds: number }>`

- [ ] **Step 1: Write the failing tests:**
  - An issued credential verifies `{ ok: true }`.
  - Changing `credentialSubject.vehicle` after signing gives `failure: "signatureInvalid"`.
  - Changing `credentialStatus.statusListIndex` gives `"signatureInvalid"`. This is step 10's forgery.
  - Changing `issuer` to another DID gives `"issuerMismatch"`.
  - With `validUntil` one hour ahead, `advance(2h)` gives `"expired"`.
  - `allocate()` returns 0, then 1. After `revoke(1)`, `checkStatus(signed, 1, …)` gives `{ signatureValid: true, revoked: true }` and index 0 gives `revoked: false`. After `advance(601_000)`, `ageSeconds > 600`. A list signed by another identity gives `signatureValid: false`.
- [ ] **Step 2:** Run `npm test -- credentials`. Expected: FAIL.
- [ ] **Step 3:** Implement both files. If `signTrustTask` or `verifyDetailed` refuse a non-Trust-Task shape at runtime, sign the JCS bytes yourself with the `eddsa-jcs-2022` algorithm using `canonicalize` from `@openvtc/trust-tasks-proof` and `@noble/curves`. Note this in the file header.
- [ ] **Step 4:** Run `npm test -- credentials`. Expected: PASS.
- [ ] **Step 5:** Commit: `community-rides: credentials and signed status list`.

### Task 4: Rego policies

**Files:**
- Create: `policies/admit.rego`, `policies/post.rego`, `policies/show_offer.rego`, `policies/accept_rider.rego`, `policies/admin_action.rego`, `policies/rodewith_summary.rego`
- Create: `policies/policy.wasm` (built, committed)
- Create: `src/core/policy.ts`
- Modify: `package.json` (the `policies` script)
- Test: `tests/policy.test.ts`

**Interfaces:**
- Produces:
  - `interface Decision { allow: boolean; reasons: string[] }`
  - `type DecisionPoint = "admit" | "post" | "show_offer" | "accept_rider" | "admin_action"`
  - `class Policies { static load(wasm: BufferSource): Promise<Policies>; decide(point: DecisionPoint, input: object): Decision; summarizeRodeWith(input: RodeWithInput): { count: number; meanRating: number | null } }`
  - `interface CredFacts { signatureValid: boolean; issuerIsCommunity: boolean; subjectIsSender: boolean; revoked: boolean; expired: boolean }`
  - `interface StatusFacts { signatureValid: boolean; ageSeconds: number }`
  - Inputs:
    - `admit`: `{ maxVouchAgeDays: 30, vouches: { issuer: string; signatureValid: boolean; subjectIsApplicant: boolean; issuerIsMember: boolean; issuerRevoked: boolean; ageDays: number }[] }`
    - `post`: `{ senderIsMember: boolean; senderRevoked: boolean }`
    - `show_offer`: `{ maxStatusAgeSeconds: 600, membership: CredFacts | null, driver: CredFacts | null, statusList: StatusFacts }`
    - `accept_rider`: `{ maxStatusAgeSeconds: 600, membership: CredFacts | null, statusList: StatusFacts }`
    - `admin_action`: `{ requester: string, admins: string[] }`
    - `RodeWithInput`: `{ statements: { issuer: string; signatureValid: boolean; issuerIsMember: boolean; subjectIsOfferer: boolean; rating: number }[] }`

Each file is package `rides.<point>`, in Rego v1 syntax, with a rule `decision := {"allow": …, "reasons": …}`. `reasons` is the sorted set of failure strings from Global Constraints, and is empty when allowed. `rides.rodewith_summary.summary := {"count": …, "meanRating": …}` counts distinct issuers among the valid statements and averages the rating of each one's first valid statement. `meanRating` is null when the count is 0. The `policies` script is `opa build -t wasm` with one `-e rides/<point>/decision` per point plus `-e rides/rodewith_summary/summary`, writing `policies/bundle.tar.gz`, then extracting `/policy.wasm` into `policies/`. `Policies.decide` selects the entrypoint by name, not index.

- [ ] **Step 1:** Install OPA if it's missing: `brew install opa`. Check that `opa version` reports 1.x.
- [ ] **Step 2: Write the failing tests** in `tests/policy.test.ts`, loading `policies/policy.wasm` with `fs`:
  - `admit` with two valid vouches from distinct members gives `{ allow: true, reasons: [] }`. Two from the same issuer gives `allow: false` and reasons `["needs 2 vouches from current members, has 1"]`. One of age 31 days counts as 0.
  - `show_offer` with good facts gives allowed. `driver.revoked: true` gives reasons containing `"driver endorsement revoked"`. `driver.signatureValid: false` gives `"driver endorsement: signature does not verify"`. `driver: null` gives `"no driver endorsement"`. `statusList.ageSeconds: 601` gives `"revocation list stale"`.
  - `accept_rider` with `membership: null` gives `"no membership"`.
  - `post` with `senderIsMember: false` gives `"not a member"`.
  - `admin_action` with a requester not in `admins` gives `"not an admin"`.
  - `summarizeRodeWith` with two valid statements from Dave (ratings 5 and 1) and one from Alice (rating 4) gives `{ count: 2, meanRating: 4.5 }`. Empty input gives `{ count: 0, meanRating: null }`.
- [ ] **Step 3:** Run `npm test -- policy`. Expected: FAIL.
- [ ] **Step 4:** Write the Rego files and `policy.ts`, run `npm run policies`, and commit `policies/policy.wasm`.
- [ ] **Step 5:** Run `npm test -- policy`. Expected: PASS.
- [ ] **Step 6:** Commit: `community-rides: Rego policies compiled to wasm`.

### Task 5: Community agent

**Files:**
- Create: `src/rides/specs.ts`, `src/rides/facts.ts`, `src/rides/knowledge.ts`, `src/rides/community.ts`
- Test: `tests/community.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces:
  - `specs.ts`: real `SPEC` objects re-exported as `JOIN_SUBMIT` (`vtc/join-requests/submit/0.3`), `MEMBERS_VMC` (`vtc/members/vmc/0.1`), `ENDORSEMENT_TYPES_REGISTER` (`vtc/endorsement-types/register/0.1`), `ENDORSEMENTS_ISSUE` (`vtc/endorsements/issue/0.1`) and `ENDORSEMENTS_REVOKE` (`vtc/endorsements/revoke/0.1`). Ours are `VOUCH`, `ENDORSEMENT_DELIVER`, `BOARD_POST`, `BOARD_LIST`, `BOARD_WITHDRAW`, `STATUS_GET`, `OFFER`, `ACCEPT`, `PICKUP_CHECK` and `RODE_WITH`, all made with `ourSpec`. It also exports `DRIVER_PREDICATE` and the TS payload types for ours: `BoardPost { postId: string; pseudonym: string; area: string; destination: string; window: { from: string; to: string }; status: "open" | "matched" | "withdrawn" }`, `OfferPayload { offerId: string; postId: string; driver: { displayName: string; vehicle: string }; presentation: { membership: Credential; driver: Credential; rodeWith: { statement: Credential; issuerMembership: Credential }[] } }`, `AcceptPayload { offerId: string; pickupAddress: string; rider: { displayName: string; membership: Credential } }`, and `PickupCheckPayload { rideId: string; challenge: string }`.
  - `facts.ts`: `credFacts(vc: Credential | null | undefined, expect: { community: string; subject: string; type: string }, status: StatusListDoc, clock: DemoClock): Promise<CredFacts | null>` and `statusFacts(doc: StatusListDoc, community: string, clock: DemoClock): Promise<StatusFacts>`
  - `knowledge.ts`: `interface Fact { about: string; what: string; value?: string; how: string; at: string }` and `class KnowledgeLog { add(f: Omit<Fact, "at">): void; list(): readonly Fact[]; about(did: string): Fact[] }`, stamped by the clock.
  - `community.ts`: `class CommunityAgent { constructor(opts: { identity: Identity; bus: Bus; clock: DemoClock; policies: Policies; name: string }); readonly did: string; readonly name: string; readonly knowledge: KnowledgeLog; bootstrapFounder(did: string, displayName: string, admin: boolean): Credential /* membership */; snapshot(): CommunitySnapshot; subscribe(fn: () => void): () => void }`
  - `CommunitySnapshot { members: { did: string; displayName: string; since: string; statusIndex: number; acknowledged: boolean }[]; admins: string[]; endorsements: { endorsementId: string; subjectDid: string; typeUri: string; statusListIndex: number; revokedAt: string | null }[]; board: (BoardPost & { poster: string })[]; statusList: StatusListDoc; decisions: { at: string; point: DecisionPoint; subject: string; decision: Decision }[] }`

Handlers the community registers:
- `JOIN_SUBMIT`: `payload.vp.verifiableCredential` holds vouches, and `payload.attributes` holds `[{ type: "displayName", value: { name } }]`. Build the `admit` input with `verifyCredential`. On allow, issue a membership credential (types `["VerifiableCredential", "EastsideRidesMembership"]`, subject `{ id, community, memberSince }`, a `credentialStatus` from `statusList.allocate()`). Reply with `{ requestId, verdict: { effect: "allow", with: { role: "member" } }, ext: { "example.zk-toip.rides": { membership } } }`. On deny, use `effect: "deny"` and put the reasons in `ext`.
- `MEMBERS_VMC`: store the member's acknowledgement credential (issuer is the member, subject is the community). Reply with `{ memberDid, vmcId, status: "stored" }`.
- `ENDORSEMENT_TYPES_REGISTER`, `ENDORSEMENTS_ISSUE`, `ENDORSEMENTS_REVOKE`: gate on `admin_action`. Issue refuses a predicate that isn't registered. Issue mints the driver credential (types `["VerifiableCredential", "StatementCredential"]`, subject `{ id, predicate, object: { value: claim } }`, `validUntil` from `validitySeconds`, a status entry), replies to the requester per the spec, and then sends `ENDORSEMENT_DELIVER { credential, endorsementId }` to the subject. Revoke flips the bit.
- `BOARD_POST`: the `post` policy on the authenticated sender. Allocate `postId`, store the poster privately, and log "poster of <postId> is <member>" to knowledge. `BOARD_LIST` returns posts without `poster`, and only to members. `BOARD_WITHDRAW` comes from the poster's member DID.
- `STATUS_GET`: returns `statusList.sign(...)`, freshly signed.
- An offer, accept, pickup or rode-with is never sent to the community.

- [ ] **Step 1: Write the failing tests** in `tests/community.test.ts`, using raw `Endpoint`s and real credentials as the members:
  - Founders Carol (admin) and Dave are bootstrapped. Alice submits a join with two vouches, gets `verdict.effect === "allow"` and a membership that verifies, and then `MEMBERS_VMC` gives `status: "stored"`.
  - A join with one vouch is denied with reason `"needs 2 vouches from current members, has 1"`.
  - Dave (not an admin) calling `ENDORSEMENTS_ISSUE` is refused with `"not an admin"`.
  - Carol registers the predicate and issues Bob's endorsement. Bob's endpoint receives `ENDORSEMENT_DELIVER` with a credential that verifies. After Carol's revoke, `STATUS_GET` shows that index revoked.
  - **Review Focus 3:** a non-member's `BOARD_POST` is refused with `"not a member"`.
  - **Review Focus 4:** after `BOARD_WITHDRAW`, the listed post has `status: "withdrawn"`, and a second withdraw is refused with `"post is not open"`.
  - `BOARD_LIST` entries have no `poster` field.
- [ ] **Step 2:** Run `npm test -- community`. Expected: FAIL.
- [ ] **Step 3:** Implement the four files. For the real specs, fill every required field of the generated `Payload` and `Response` types honestly. If one can't be filled, switch that step to `ourSpec`, and note it for the README table (Task 8).
- [ ] **Step 4:** Run `npm test -- community`. Expected: PASS.
- [ ] **Step 5:** Commit: `community-rides: community agent`.

### Task 6: Member agent

**Files:**
- Create: `src/rides/member.ts`
- Test: `tests/member.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Produces:
  - `interface Check { label: string; ok: boolean; detail?: string }`
  - `interface ReceivedOffer { offerId: string; postId: string; from: string; driver: { displayName: string; vehicle: string }; checks: Check[]; decision: Decision; rodeWith: { count: number; meanRating: number | null } }`
  - `interface Trip { rideId: string; role: "rider" | "driver"; other: string; otherName: string; pickupAddress?: string; myChallenge?: string; otherVerifiedAtCurb: boolean; rated: boolean }`
  - `class MemberAgent`:
    - Constructor: `constructor(opts: { name: string; bus: Bus; clock: DemoClock; policies: Policies; community: { did: string; name: string } })`. Its identity is `identityFromSeed(seedFrom("community-rides/" + name.toLowerCase()))`.
    - Fields: `readonly did: string; readonly name: string; readonly knowledge: KnowledgeLog`
    - `wallet: { membership?: Credential; acknowledgement?: Credential; driver?: Credential; driverEndorsementId?: string; vouches: Credential[]; rodeWith: Credential[] }`
    - `posts: Map<string, BoardPost>`, `offersReceived: Map<string, ReceivedOffer>`, `offersSent: Map<string, { offerId: string; postId: string; to: string; status: "sent" | "accepted" }>`, `trips: Map<string, Trip>`, `lastError: string | null`
    - Actions:
      - `vouchFor(applicantDid: string): Promise<void>`
      - `join(): Promise<{ admitted: boolean; reasons: string[] }>`
      - `registerDriverPredicate(): Promise<void>`
      - `issueDriver(subjectDid: string, claim: { vehicle: string }): Promise<string /* endorsementId */>`
      - `revokeEndorsement(endorsementId: string, reason: string): Promise<void>`
      - `post(req: { area: string; destination: string; window: { from: string; to: string } }): Promise<string /* postId */>`
      - `board(): Promise<BoardPost[]>`
      - `offer(postId: string, pseudonym: string): Promise<string /* offerId */>`
      - `accept(offerId: string, pickupAddress: string): Promise<string /* rideId = offerId */>`
      - `pickupQr(rideId: string): string`, which returns a fresh 16-byte hex challenge and stores it
      - `scanPickupQr(rideId: string, challenge: string): Promise<boolean>`
      - `rate(rideId: string, rating: number): Promise<void>`
      - `exchangeRodeWith(other: MemberAgent, rideId: string, rating: number): Promise<void>`, for setup only
      - `tamperDriverEndorsement(): void`
      - `subscribe(fn: () => void): () => void`

Behavior:
- `post` mints a pseudonym identity from `seedFrom("community-rides/<name>/ride/<n>")`, opens an `Endpoint` for it that handles `OFFER` (it stays open), and posts with `pseudonym` set to its DID.
- On `OFFER`, the pseudonym refuses with `"post is not open"` unless its post is open. Otherwise it fetches `STATUS_GET` through the member's main endpoint and builds `checks`. Each check is a real computation: signature on the membership, signature on the driver endorsement, issuer, subject equals the authenticated sender, not revoked, status list fresh, then the policy decision. It also builds `rodeWith` with `summarizeRodeWith` and stores a `ReceivedOffer`. It replies `{ received: true }` whatever the decision, and logs the driver's DID, name and vehicle to knowledge with `how: "offer on post <postId>"`.
- `accept` refuses with `lastError = "offer was not allowed"` unless `decision.allow` is true. It sends `ACCEPT` from the **main** endpoint to `offer.from`, then withdraws the post.
- On `ACCEPT`, Bob checks that `offerId` is one he sent, runs `accept_rider`, stores the `Trip` with `pickupAddress`, and logs Alice's DID and the address to knowledge.
- `scanPickupQr` sends `PICKUP_CHECK { rideId, challenge }` to the other party. The receiver sets `otherVerifiedAtCurb` when the challenge equals its stored one and the authenticated sender is `trip.other`. The proof on the document is the signature over the challenge.
- `rate` issues a rode-with credential (subject `{ id: other, rideId, rating }`) and sends `RODE_WITH`. The receiver appends it to `wallet.rodeWith`.
- `offer` includes every `wallet.rodeWith` statement with its issuer's membership. The membership comes from the statement sender, who attaches it to `RODE_WITH` as `{ statement, issuerMembership }`.
- `tamperDriverEndorsement` changes `wallet.driver.credentialStatus.statusListIndex` to a free index without re-signing.
- Every action catches `TaskError` and `Refusal` and sets `lastError` to the message. It rethrows only in tests that ask for it. Each action that the UI calls returns normally, with `lastError` set.

- [ ] **Step 1: Write the failing tests** in `tests/member.test.ts`, using a real `CommunityAgent`:
  - The full happy path between Alice and Bob: join, endorse, post, offer, accept, both pickup scans, rate. Alice's `ReceivedOffer.decision.allow === true`, and every check is `ok`. Bob's trip has `pickupAddress === "412 Maple St, Apt 3"`. Both trips have `otherVerifiedAtCurb: true`. Bob's `wallet.rodeWith.length === 1`.
  - After Carol revokes Bob's endorsement, a new offer has `decision.reasons` containing `"driver endorsement revoked"`, and `accept` sets `lastError` to `"offer was not allowed"`.
  - After `tamperDriverEndorsement`, reasons contain `"driver endorsement: signature does not verify"`.
  - A pickup scan with the wrong challenge leaves `otherVerifiedAtCurb: false`.
  - **Review Focus 4:** an offer on Alice's post after she accepted another offer is refused, and the offerer's `lastError` contains `"post is not open"`.
  - **Review Focus 3:** `bob.offer` before Bob holds a driver endorsement sets `lastError` (offer refused locally: `"no driver endorsement"`) and sends nothing. Alice posting before joining sets `lastError` to a message containing `"not a member"`.
- [ ] **Step 2:** Run `npm test -- member`. Expected: FAIL.
- [ ] **Step 3:** Implement `member.ts`.
- [ ] **Step 4:** Run `npm test -- member`. Expected: PASS.
- [ ] **Step 5:** Commit: `community-rides: member agent`.

### Task 7: World, setup and the scripted scenario

**Files:**
- Create: `src/rides/world.ts`, `src/rides/scenario.ts`
- Test: `tests/scenario.test.ts`, `tests/disclosure.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces:
  - `class World { static create(opts: { policyWasm: BufferSource }): Promise<World>; readonly clock: DemoClock; readonly bus: Bus; readonly community: CommunityAgent; readonly people: { alice: MemberAgent; bob: MemberAgent; carol: MemberAgent; dave: MemberAgent; mallory: MemberAgent }; readonly busy: boolean; stepIndex: number /* last completed, 0 = setup */; runStep(i: number): Promise<void>; subscribe(fn: () => void): () => void }`
  - `interface Step { n: number; title: string; caption: string; run(w: World): Promise<void> }`
  - `const STEPS: readonly Step[]`, ten of them, numbered as in §3

`World.create` runs setup (§3 step 1):
1. Bootstrap Carol (admin) and Dave as founders. Each sends `MEMBERS_VMC`.
2. Carol registers the driver predicate.
3. Carol and Dave vouch for Bob and Mallory, and both join.
4. Carol issues Mallory an endorsement (`vehicle: "Silver 2009 Corolla"`).
5. Dave and Bob `exchangeRodeWith` with `rideId: "setup-carpool"`, rating 5.

Then the clock advances 10 minutes.

`runStep(i)` throws `Error("busy")` while a step is running (Review Focus 2) and `Error("out of order")` unless `i === stepIndex + 1`. The steps, with captions in plain language, one line each, written for non-technical people:
- Step 2: Carol and Dave vouch for Alice. Alice joins.
- Step 3: Carol issues Bob's endorsement, `vehicle: "Blue 2014 Honda Fit"`. The caption says the license check happened in person.
- Step 4: Alice posts `{ area: "Maple & 5th", destination: "Eastside Clinic", window: { from: "15:00", to: "16:00" } }`.
- Step 5: Bob reads the board and offers on Alice's post.
- Step 6: Alice accepts with `"412 Maple St, Apt 3"`.
- Step 7: both pickup scans, Alice's QR first.
- Step 8: advance 1 hour, then both rate 5.
- Step 9: Carol revokes Mallory's endorsement. Alice posts the return trip `{ area: "Eastside Clinic", destination: "Maple & 5th", window: { from: "17:00", to: "18:00" } }`. Mallory offers on it.
- Step 10: Mallory tampers and offers again on the same post.

- [ ] **Step 1: Write the failing tests:**
  - `tests/scenario.test.ts`: after `create`, the community has 4 members and Mallory holds a driver credential. Running steps 2 to 10 in order gives the expected results:
    - Alice is a member after step 2.
    - Bob's `wallet.driver` verifies after step 3.
    - Alice's offer from Bob is allowed, with `rodeWith.count === 1`, after step 5.
    - Bob's trip has the address after step 6.
    - `otherVerifiedAtCurb` is true on both sides after step 7.
    - Bob has `rodeWith.length === 2` after step 8.
    - Mallory's offer has `"driver endorsement revoked"` after step 9.
    - Mallory's second offer has `"driver endorsement: signature does not verify"` after step 10.
  - **Review Focus 2:** calling `runStep(2)` twice without awaiting makes the second reject with `"busy"`. `runStep(4)` straight after setup rejects with `"out of order"`.
  - **Review Focus 5:** two `World.create` calls give identical DIDs for all six agents and the same `community.snapshot().members.length`.
  - `tests/disclosure.test.ts` (§8), after steps 2 to 10:
    - `JSON.stringify(community.snapshot())` and the community's `knowledge.list()` don't contain `"412 Maple St"` or any rode-with rating.
    - No `bus.records()[i].raw` contains the UTF-8 bytes of `"412 Maple St"`.
    - Bob's knowledge has a fact with `value: "412 Maple St, Apt 3"`.
    - Before step 6, Bob's knowledge about Alice's member DID is empty.
    - The community's knowledge maps Alice's step-4 pseudonym to Alice.
- [ ] **Step 2:** Run `npm test -- scenario disclosure`. Expected: FAIL.
- [ ] **Step 3:** Implement `world.ts` and `scenario.ts`.
- [ ] **Step 4:** Run `npm test`. Expected: all suites PASS.
- [ ] **Step 5:** Commit: `community-rides: world, setup and scripted scenario`.

### Task 8: Web UI and README

**Files:**
- Create: `index.html`, `vite.config.ts`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/useWorld.ts`, `src/web/Phone.tsx`, `src/web/CommunityConsole.tsx`, `src/web/WirePanel.tsx`, `src/web/TrustGraph.tsx`, `src/web/Controls.tsx`, `src/web/styles.css`
- Modify: `README.md`
- Test: `tests/ui.test.tsx` (smoke)

**Interfaces:**
- Consumes: `World`, `STEPS`, and every snapshot and map above.
- Produces: `useWorld(): { world: World | null; version: number; reset(): Promise<void>; next(): Promise<void>; previous(): Promise<void> }`. `previous` rebuilds the world and replays steps 2..n-1.

Layout (§4), at 1920×1080:
- **Controls** across the top: step number, title and caption, plus previous, next (disabled while `busy`), reset, and a scripted or free-play switch.
- **Five phones** in a row. Each shows:
  - credentials held, each with a "tamper" button in free play
  - the board
  - offers received, with the `checks` list, and the policy reasons in red when denied
  - trips, with "show QR" and "scan QR"
  - `lastError`
  - a "what I know" drawer listing `knowledge`

  Free-play controls are buttons for each `MemberAgent` action, with small inputs.
- **Community console**: members, admins, endorsements (revoked in red), the board including `poster`, the status-list summary, and decisions with their reasons. It has no action buttons.
- **Wire panel**: newest first, showing from and to (short DIDs with names), size and `head`. Clicking a row opens `opened.document` as JSON, labeled "only <name> can read this".
- **Trust graph**: an SVG with fixed positions for the six agents. Edges cover membership (community to member, solid once acknowledged), vouches, driver endorsements (red when revoked) and rode-with.
- **Policies**: a "policy" link on each decision opens the `.rego` source, imported with `?raw`.

The browser loads `policies/policy.wasm` with `?url` and `fetch`.

- [ ] **Step 1: Write the failing smoke test** `tests/ui.test.tsx`. Install `jsdom` and `@testing-library/react` as dev dependencies, and set the file's Vitest environment to jsdom: it renders `App` with a world built in the test, then shows "Eastside Rides" and five phone headings. After `next()` it shows step 2's title.
- [ ] **Step 2:** Run `npm test -- ui`. Expected: FAIL.
- [ ] **Step 3:** Implement the UI. Use large type and high contrast. The meaningful colors are verified (green), revoked or denied (red), and encrypted (gray).
- [ ] **Step 4:** Run `npm test` and `npm run build`. Expected: all PASS, and the build succeeds.
- [ ] **Step 5:** Write `README.md`:
  - how to run (`npm install && npm run dev`, and `npm run policies` after editing `.rego`)
  - the 10 steps
  - the spec-or-ours table from §5.3, with what was actually used
  - the guesses from design §9, plus `did:key` and the prebuilt modules
- [ ] **Step 6:** Verify in a real browser. Run `npm run dev`, open it in Chrome, click "next" through all 10 steps, and confirm each step's visible result matches Task 7's assertions. Take a screenshot at steps 5, 6 and 10.
- [ ] **Step 7:** Commit: `community-rides: web UI and README`.
