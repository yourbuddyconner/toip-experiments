# Agora: design

Forums where every post is anonymous, but only people with a given credential can post. "Only licensed nurses can post here." "Only residents of district 7 can vote in this poll." Each person gets one pseudonym per forum, so nobody can run sockpuppets. A person's pseudonyms in different forums can't be linked. Date: 2026-11-06.

Choices marked **(our call)** are the assistant's and open to change. A guess is labeled a guess.

The zero-knowledge statement is proved by a shared library, `packages/anon-membership`, whose design `projects/tipline` owns. Section 14 says exactly what Agora needs from it. Where this document names a hash or a proof system, it states a requirement or an expectation, not a choice that tipline has to accept.

## 1. Why

People with a shared credential often need to talk without being known:
- nurses about a hospital's staffing;
- employees about their employer;
- residents about their landlord or their council.

Today they choose between two bad options:
- **A real-name forum.** Speech is chilled.
- **A fully anonymous forum.** Anyone can claim to be a nurse, and one person can be twenty voices.

Agora gives a third option. A post proves "the author holds a current RN license from one of these boards" and nothing else. The forum still knows that two posts came from the same pseudonym, so it can rate-limit and ban that pseudonym. It never learns who is behind it.

**Why ToIP.** The credentials already exist, or will: licensing boards, employers and building managers are the issuers the stack expects. Agora adds no new identity. It reuses the person's did:key, their credentials, TSP and the relay, and adds one thing the stack doesn't have yet: proving membership without showing which member you are. zk-pdp-fit's "community gate" demo (`projects/zk-pdp-fit/ideas.md`) is this idea, made concrete.

## 2. Who uses it

| Who | Wants |
|---|---|
| **Member** (a nurse, a resident, an employee) | to post and vote without being identified, under a stable name that others can recognise |
| **Forum owner** (a union local, a residents' association, anyone) | to say who may post, and to appoint moderators |
| **Moderator** | to remove abuse and ban abusers, without being able to unmask them |
| **Reader** | to trust that "a licensed RN wrote this" is true, without trusting the host |
| **Issuer** (a licensing board, an employer, a building) | to keep issuing credentials as it does today. It doesn't have to change anything. |
| **Registrar** | to run the anonymity groups that the proofs are made against (section 4.3) |
| **Host** | to store and serve forums. The design treats it as untrusted for anonymity. |

## 3. Goals, non-goals, anti-goals

**Goals**

1. A post is accepted only if its author holds a current credential that meets the forum's gate.
2. One credential holder has one pseudonym (a **nym**) per forum, or per thread if the forum chooses. Posts under it are linkable. Nyms in different scopes are not.
3. One credential holder has one vote per poll.
4. Moderation works per nym: hide posts, ban a nym, rate-limit a nym. No moderation action needs to know who the person is.
5. Readers check every post themselves: the signature, the nym's proof, and the forum's signed policy. They don't trust the host for any of it.
6. The host, the registrar and the issuer cannot learn which person wrote a post, even by working together, except through the metadata leaks listed in section 11.
7. Posting feels normal. The person proves once per forum per day, and after that a post takes no longer than on any forum.
8. Reuses trust-core: did:key, `signDocument` and `verifyDocument`, credentials, status lists, Trust Task documents under `ourSpec`, the relay, and the passkey vault pattern from Settle.

**Non-goals (for now)**

- **Private forums.** In the MVP, anyone can read. Only posting and voting are gated. Members-only reading needs encrypted content and group keys (section 13).
- **Hiding network addresses.** The MVP doesn't route traffic through Tor or a mix network. Section 11 says what that leaks.
- **Proving over the issuer's signature inside the circuit.** It costs about 437,000 gates per Ed25519 signature (zk-pdp E13), plus parsing the credential in the circuit. Section 4.3 explains how the registrar avoids it.
- **P2P replication.** The formats allow it (section 7.6). The MVP has one host.
- **Edits.** A post can be deleted by its author, not edited.
- **Rich predicates.** The MVP supports equality and ranges over four attributes. Arbitrary policies (Cedar compiled by zk-pdp) come later.

**Anti-goals**

- **Unmasking.** No party, and no quorum of parties, can turn a nym into a person. That includes threshold deanonymization. It is not a feature that is switched off. The design doesn't contain it. Section 13 records why.
- **A host that serves the client.** If the host serves the code that holds the person's secret, it can serve code that leaks the secret. The client must come from somewhere else (section 6.1).
- **Logging addresses.** The host keeps no IP addresses, user agents or request logs tied to posts.
- **Moderation that needs identity.** If a moderation feature works only by learning who someone is, we don't build it.
- **Silent censorship.** The host can refuse or remove posts, but every removal is a signed entry in a public log (section 7.5).

## 4. Parties and trust

### 4.1 Who's who

| Party | Holds | Does | Trusted for |
|---|---|---|---|
| **Issuer** | a did:key; its status list | issues W3C-shaped credentials, as trust-core's `issueCredential` does; revokes them | the truth of the credential ("Ana is an RN") |
| **Registrar** | a did:key | admits credential holders to groups, publishes signed group roots, removes revoked members | admitting only real, current holders, one leaf each (soundness). **Not** trusted for anonymity. |
| **Member** | a did:key, credentials, an identity secret | joins groups, makes proofs, posts | nothing; they're the one being protected |
| **Forum owner** | a did:key | signs the forum's policy, names moderators | the policy |
| **Moderator** | a did:key | signs moderation actions | moderation, within the forum's rules |
| **Host** | a did:key | stores forums, checks proofs, enforces nullifiers, bans and rate limits, signs the feed head | availability; enforcing the gate on writes. **Not** trusted for anonymity or for authenticity. |
| **Reader** | nothing | reads and verifies | nothing |

A registrar may be the issuer itself (an **issuer-run group**) or an independent service that accepts the issuer's credentials (a **third-party group**). The software is the same. A third-party registrar is what makes Agora work with issuers that won't change anything.

### 4.2 The core idea

1. A member has one **identity secret** `s`, which never leaves their device.
2. To join a group, the member sends the registrar a credential and a **commitment** `C = H(s, groupId)`. The registrar checks the credential and adds a **leaf** to the group's Merkle tree. The leaf holds `C` and some of the credential's attributes.
3. To post, the member proves in zero knowledge: "I know an `s` whose leaf is in one of these group roots, its attributes meet the forum's predicates, and my nym for this forum is `N = H(s, scope)`." The proof hides which leaf.
4. The host checks the proof and accepts the nym. The same `s` and the same forum always give the same `N`, so one person has one nym. A different forum gives an unrelated `N`.

This is the Semaphore pattern (identity commitments in a Merkle group, nullifier = H(scope, secret)), extended with attributes, several groups, a rate-limit index and an expiry date.

### 4.3 Why a registrar

The proof has to be made against something cheap to check in a circuit. A Merkle root over Poseidon-family hashes costs about 25,600 gates at depth 20 (HashCloak's Semaphore Noir measurements). Checking an issuer's Ed25519 signature on a JCS-canonical credential in the circuit costs over 400,000 gates for the signature alone. That is 4 s or more before the rest of the proof (zk-pdp E13). A person makes many proofs, so we move the signature check out of the circuit and into a one-time step: joining a group.

**What the registrar learns:**
- which DIDs joined which groups, and when;
- each joiner's commitment `C`.

That is at most what the issuer already knows. **What the registrar can't learn:**
- Which leaf made a proof. The proof hides it.
- Any nym. A nym needs `s`, and `C` is a hash of `s` with the group id.

**What the registrar must be trusted for:**
- admitting only holders of real, current credentials;
- one active leaf per credential subject per group;
- removing revoked members.

A registrar that cheats can add fake members (sockpuppets, or padding that shrinks the real anonymity set, section 11). It can't unmask anyone. A forum policy names the registrars it trusts.

**Commitments are per group** **(our call)**. `C = H(s, groupId)` differs between groups, so two registrars comparing notes can't tell that the same secret joined both. The nym `N = H(s, scope)` doesn't depend on the group. So a member gets the same nym in a forum whichever of their groups they prove from.

## 5. The statements

All hashes here are the circuit's hash `H`, a sponge over field elements. We expect Poseidon2 over BN254 (section 14). Each call starts with a domain tag, so a value made for one purpose can't be used as another:

| Tag | Value | Used in |
|---|---|---|
| `T_ID` | 1 | commitment |
| `T_LEAF` | 2 | leaf |
| `T_NULL` | 3 | nullifier |
| `T_SCOPE` | 4 | scope |

`f(bytes)` turns bytes into a field element: the first 31 bytes of SHA-256(bytes), read big-endian. This is below the BN254 field modulus, so no reduction is needed. It's computed outside the circuit.

### 5.1 The one circuit

Agora needs a single circuit, the **gate circuit**. Every use is this circuit with different public inputs.

**Private inputs**
- `s`: the identity secret
- `g`: which of the public groups the leaf is in (0 to 3)
- the leaf's fields: `validUntilDay`, `registeredDay`, `attrs[4]`
- the Merkle path: `index` (20 bits) and `siblings[20]`
- `k`: the message index (0 ≤ k < limit)

**Public inputs**
- `groupIds[4]`, `roots[4]`: up to four groups. Unused slots are 0.
- `schemaId`: the attribute layout that all the groups share
- `today`: days since 1970-01-01 UTC
- `registeredBy`: a day number
- `ops[4]`, `operands[4]`: one predicate per attribute slot. Ops: 0 any, 1 equals, 2 at least, 3 at most.
- `scope`
- `limit`: how many nullifiers one person may make in this scope (1 for a nym or a vote)
- `signal`: the hash of the message this proof is bound to

**Public output**
- `nullifier`

**Constraints**
1. `C = H(T_ID, s, groupIds[g])`
2. `leaf = H(T_LEAF, C, schemaId, validUntilDay, registeredDay, attrs[0], attrs[1], attrs[2], attrs[3])`
3. `root = MerkleRoot(leaf, index, siblings)` at depth 20. `roots[g] == root` and `roots[g] != 0`. The proof doesn't reveal `g`.
4. `validUntilDay ≥ today`. The credential hasn't expired.
5. `registeredDay ≤ registeredBy`. The leaf is old enough (section 8.3).
6. For each slot `j`:
   - op 0: nothing.
   - op 1: `attrs[j] == operands[j]`.
   - op 2: `attrs[j] ≥ operands[j]`.
   - op 3: `attrs[j] ≤ operands[j]`.
   - For ops 2 and 3, both values must fit in 64 bits, and the circuit checks that they do.
7. `0 ≤ k < limit`, with `limit` at most 2^16.
8. `nullifier = H(T_NULL, s, scope, k)`
9. `signal` is bound to the proof. A proof made for one signal must not verify with another. This needs a test (section 12), not only a belief about the proof system. Semaphore's circom circuit squares its message for this reason.

Day numbers fit in 32 bits. `validUntilDay` and `registeredDay` are always compared as 64-bit values.

### 5.2 Posting: the nym pass

A member doesn't prove for every post. Once per forum per day, they prove a **nym pass**. It binds a fresh session key to their nym. After that, they sign each post with the session key, which is an ordinary did:key. This is the main speed decision **(our call)**. It is safe because posts under one nym are meant to be linkable anyway.

| Input | Value |
|---|---|
| `groupIds`, `roots`, `schemaId` | from the forum policy's gate, and the roots the host accepts (section 8.2) |
| `today`, `registeredBy` | today, and today minus the policy's `minRegisteredDays` |
| `ops`, `operands` | the policy's predicates, compiled (section 7.1) |
| `scope` | forum mode: `H(T_SCOPE, f("agora/v1/forum-nym"), f(forumId))`<br>thread mode: `H(T_SCOPE, f("agora/v1/thread-nym"), f(forumId), f(threadId))` |
| `limit` | 1, so `k` = 0 and there's exactly one nym per person per scope |
| `signal` | `f(JCS(pass without "zk" and "proof"))`. The pass names the session DID, so the proof is bound to that key. |
| output `nullifier` | the nym |

### 5.3 Voting

A vote carries its own proof. A session key would tie the vote to the voter's nym, and ballots must be secret even from the forum.

| Input | Value |
|---|---|
| `groupIds`, `roots` | **pinned in the poll** when it opens, not the current roots (section 8.4) |
| `schemaId`, `ops`, `operands`, `registeredBy` | the poll's own gate. It defaults to the forum's, and can be stricter ("district = 7"). |
| `today` | the day of the vote |
| `scope` | `H(T_SCOPE, f("agora/v1/poll"), f(pollId))` |
| `limit` | 1 |
| `signal` | `f(JCS({ poll: pollId, choice }))` |
| output `nullifier` | the vote's nullifier. A second vote with the same one is refused. |

### 5.4 Unlinkable rate-limited posts (statement now, app later)

Some forums want no nyms at all: every post unlinkable, with only a limit of N posts per person per day. Each post then carries its own proof:
- `scope = H(T_SCOPE, f("agora/v1/post-epoch"), f(forumId), epochDay)`
- `limit = N`
- `k` is any value the person hasn't used today
- `signal` is the post's hash

The host refuses a repeated nullifier, so a person gets at most N posts per day. This is RLN's counter without RLN's slashing: we refuse duplicates instead of revealing the secret. The circuit supports it from day one because tipline needs the same thing. Agora's app adds it later (section 13), because bans don't work in this mode.

## 6. Architecture

### 6.1 Components

```
 issuers (boards, city)        registrar                 host                    client (separate origin)
 ┌────────────────────┐   ┌──────────────────┐   ┌───────────────────────┐   ┌──────────────────────────┐
 │ issue VCs          │   │ groups, leaves   │   │ policies, feeds       │   │ wallet: DID, VCs, s      │
 │ status lists       │◀──│ signed root log  │──▶│ nym passes, posts     │◀─▶│ group sync, Merkle paths │
 └────────────────────┘   │ join over TSP    │   │ votes, nullifiers     │   │ prover (Web Worker)      │
          ▲               └──────────────────┘   │ moderation, bans      │   │ verifies everything read │
          │ TSP via relay          ▲             │ signed feed heads     │   └──────────────────────────┘
          └────────────────────────┴──── member ─┴───────────────────────┘
```

| Component | Runs where | Talks |
|---|---|---|
| Issuer | its own service (demo: in the platform process) | issues credentials over TSP. Publishes its status list over HTTP. |
| Registrar | its own service | `agora/group/*` Trust Tasks over TSP, from the member's real DID. Public HTTP reads for descriptors, roots and leaves. |
| Host | its own service. Node, `node:http`, `node:sqlite`, as Settle and the relay are. | HTTP. It takes the same signed Trust Task documents as bodies. |
| Client | a static web app served from a **different origin** than the host. Its build hash is shown on the About page. | HTTP to the host and the registrar's public reads. TSP via the relay for joining and receiving credentials. |
| Relay | `packages/relay`, unchanged | carries TSP for joins and credential issuance only |

**Why the client isn't served by the host.** The client holds `s`. Code served by the host could send `s` to the host. In the MVP, the client is a separate static bundle on its own port. In a real deployment, it is installed, or served by someone other than the host, with a published hash. The client can talk to any host.

**Why the host doesn't use the relay.** The relay authenticates each connection as a did:key and sees who sends to whom. Posting through it from the member's real DID would link the member to the forum. Posting from the session DID would be safe, but HTTP is simpler for public reads. P2P mode (section 7.6) would use session DIDs on the relay.

### 6.2 What runs where, in the MVP

`npm run agora` starts one process, as `npm run settle` does:
- the relay (4401);
- three demo issuers;
- the registrar (4402);
- the host (4400);
- the client's static server (4403), on a separate origin;
- a dev clock that can skip ahead, shared by every component.

The client's server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Without them, the browser won't allow `SharedArrayBuffer`, and the prover runs on one thread. The host and the registrar send CORS headers for the client's origin.

Layout of `projects/agora/`:

| Path | What |
|---|---|
| `src/protocol/` | document types, canonical hashing, `f()`, scope and signal helpers, policy-to-statement compilation, nym names |
| `src/registrar/` | the registrar: groups, leaves, root log, join, rotate and leave, status-list polling |
| `src/host/` | the host: HTTP API, SQLite store, feed log, checks |
| `src/issuers/` | the demo issuers and their credential types |
| `src/client/` | `AgoraClient`: wallet, group sync, prover, posting, voting. Used by the web app and the tests. |
| `src/platform/` | the one-process runner and the dev clock |
| `src/demo.ts` | the narrated terminal demo |
| `web/` | the React client and the moderator view |
| `tests/` | section 12 |

## 7. Data formats

Every signed document is JSON with an `issuer` and a Data Integrity proof (`eddsa-jcs-2022`), made with trust-core's `signDocument` and checked with `verifyDocument`. "Hash" means SHA-256 over the JCS form without `proof`, as Settle's terms hash is made. Field elements are `0x`-prefixed hex, 64 digits. Days are integers, days since 1970-01-01 UTC.

### 7.1 Group descriptor (registrar-signed)

```json
{
  "type": "agora/group", "version": 1,
  "id": "urn:agora:group:cascade-nursing-v1",
  "issuer": "did:key:z6Mk…registrar",
  "issuedAt": "2026-11-06T09:00:00Z",
  "groupId": "0x…",                       // f(id)
  "source": {
    "issuer": "did:key:z6Mk…cascadeBoard",
    "credentialType": "NursingLicense",
    "statusList": "https://cascade-board.example/status"
  },
  "schema": {
    "id": "agora/schema/nursing-license/1",
    "schemaId": "0x…",                    // f(schema.id)
    "slots": [
      { "name": "licenseType", "from": "credentialSubject.licenseType", "encoding": "hash", "publishCounts": true },
      { "name": "state",       "from": "credentialSubject.state",       "encoding": "hash", "publishCounts": true },
      { "name": "licensedSince","from": "credentialSubject.licensedSince","encoding": "day" },
      null
    ],
    "validUntil": "validUntil"
  },
  "depth": 20,
  "rotation": { "maxPerYear": 2 },
  "rootCadenceSeconds": 3600,
  "proof": { … }
}
```

- Encodings: `hash` is `f(utf8(value))`. `u64` is an integer below 2^64. `day` is an ISO date turned into a day number. An empty slot is 0.
- `validUntilDay` is the credential's `validUntil` as a day number, or `registeredDay + 365` if it has none **(our call)**.
- Every group used in one gate must have the same `schemaId`. The policy check refuses a gate that mixes schemas.

### 7.2 Group root (registrar-signed, hash-chained)

```json
{
  "type": "agora/group-root", "version": 1,
  "issuer": "did:key:…registrar", "issuedAt": "2026-11-06T10:00:00Z",
  "group": "urn:agora:group:cascade-nursing-v1",
  "seq": 42, "prev": "<hash of root 41>",
  "root": "0x…", "size": 1284,
  "added": 7, "removed": 1,
  "counts": { "licenseType": { "<f('RN')>": 1102, "<f('LPN')>": 182 } },
  "leavesHash": "<SHA-256 of the leaf update batch since seq 41>",
  "proof": { … }
}
```

- `size` is the number of non-zero leaves.
- `counts` covers only slots marked `publishCounts`. It lets a client estimate the anonymity set after an equality predicate (section 10.1).
- The registrar publishes a new root at most once per `rootCadenceSeconds`, batching changes. This limits the revocation probing in section 11.

### 7.3 Leaf updates (registrar, public)

`GET /groups/:id/leaves?after=<seq>` returns `{ seq, updates: [{ index, leaf }] }`. A removal sets the leaf to 0. Clients keep the whole leaf list and compute their own Merkle path, so they never ask the registrar for a path at posting time (section 11). At 32 bytes a leaf, 2^16 members is 2 MB. A group near 2^20 needs a frontier-and-subtree sync, which section 13 defers.

### 7.4 Forum policy (owner-signed)

```json
{
  "type": "agora/forum-policy", "version": 1,
  "id": "urn:uuid:…policy-version",
  "issuer": "did:key:…owner", "issuedAt": "2026-11-06T09:30:00Z",
  "forum": {
    "id": "urn:uuid:7c1e…",               // stable across policy versions and hosts
    "slug": "night-shift", "title": "Night Shift",
    "description": "For RNs on nights. Be kind.",
    "hosts": ["http://localhost:4400"]
  },
  "previous": "<hash of the previous policy version, or null>",
  "gate": {
    "anyOf": [
      { "group": "urn:agora:group:cascade-nursing-v1", "registrar": "did:key:…registrar" },
      { "group": "urn:agora:group:pine-nursing-v1",    "registrar": "did:key:…registrar" }
    ],
    "where": [ { "attr": "licenseType", "op": "eq", "value": "RN" } ],
    "minRegisteredDays": 7,
    "minAnonymitySet": 25
  },
  "nyms": "forum",                         // or "thread"
  "posting": {
    "rate": { "posts": 30, "perSeconds": 86400 },
    "maxBodyBytes": 20000,
    "polls": "moderators"                  // or "members"
  },
  "rootGraceSeconds": 3600,
  "moderators": ["did:key:…dee"],
  "rules": "No names of patients or colleagues. No doxxing.",
  "proof": { … }
}
```

- `anyOf` holds 1 to 4 groups. `where` holds at most four predicates, at most one per slot. Ops are `eq`, `gte` and `lte`. A value is encoded with its slot's encoding.
- **Compiling to the statement.** For each slot, its op and encoded operand, or op 0 and 0 if no predicate names it. `registeredBy = today − minRegisteredDays`. The host and the client both run `compileGate(policy, groups, roots, today)` from `src/protocol`, so they make the same public inputs.
- A new version names the old one in `previous` and is signed by the same owner. Nyms depend only on `forum.id`, so they survive policy changes and moves between hosts.

### 7.5 Documents in a forum

Every write becomes an entry in the forum's **feed**: a hash-chained, append-only log on the host.

**Nym pass** (signed by the session DID):

```json
{
  "type": "agora/nym-pass", "version": 1,
  "id": "urn:uuid:…",
  "issuer": "did:key:z6Mk…session",
  "issuedAt": "2026-11-06T10:05:00Z",
  "forum": "urn:uuid:7c1e…", "policy": "<policy hash>",
  "thread": null,
  "nym": "0x…",
  "validUntil": "2026-11-07T10:05:00Z",
  "statement": { "groupIds": […], "roots": […], "schemaId": "0x…", "today": 20398,
                 "registeredBy": 20391, "ops": [1,0,0,0], "operands": ["0x…","0x0","0x0","0x0"],
                 "scope": "0x…", "limit": 1, "signal": "0x…" },
  "zk": { "circuit": "<circuit id>", "proof": "<base64url>" },
  "proof": { … }
}
```

- `validUntil` is at most 24 hours after `issuedAt` **(our call)**. It is how long a revoked member can keep posting.
- The session key is fresh for each pass and each forum. It lives in the client's vault.

**Post** (signed by a session DID that holds a live pass):

```json
{
  "type": "agora/post", "version": 1,
  "id": "urn:uuid:…",
  "issuer": "did:key:z6Mk…session",
  "issuedAt": "2026-11-06T10:06:12Z",
  "forum": "urn:uuid:7c1e…",
  "thread": "urn:uuid:…",                  // equals id for a thread's first post
  "parent": "urn:uuid:…",                  // or null
  "title": "Float pool on 4 West?",        // first post only
  "body": "Markdown text…",
  "nym": "0x…", "pass": "<nym pass hash>",
  "proof": { … }
}
```

- **Delete:** `{ type: "agora/delete", forum, target: postId, nym, … }`, signed by any live session for the same nym.
- **Report:** `{ type: "agora/report", forum, target: postId, reason, nym, … }`, signed by a session key.
- **Moderation** (signed by a moderator's DID):

```json
{
  "type": "agora/moderation", "version": 1,
  "issuer": "did:key:…dee", "issuedAt": "…", "id": "urn:uuid:…",
  "forum": "urn:uuid:7c1e…",
  "action": "hide-post",                   // hide-post | restore-post | ban-nym | unban-nym | lock-thread | unlock-thread | slow-nym
  "target": "urn:uuid:…post" ,             // or a nym for ban-nym, unban-nym and slow-nym
  "until": "2026-12-06T00:00:00Z",         // for bans and slow-nym; null means permanent
  "rate": { "posts": 3, "perSeconds": 86400 },   // slow-nym only
  "reason": "Named a patient (rule 1).",
  "proof": { … }
}
```

**Poll** (signed by a moderator, or by a session key if the policy allows members to open polls):

```json
{
  "type": "agora/poll", "version": 1,
  "id": "urn:uuid:…", "issuer": "did:key:…", "issuedAt": "…",
  "forum": "urn:uuid:…", "thread": "urn:uuid:…",
  "question": "Support the staffing petition?",
  "choices": ["Yes", "No", "Abstain"],
  "opensAt": "…", "closesAt": "…",
  "gate": { "anyOf": […], "where": [ { "attr": "district", "op": "eq", "value": "7" } ], "minRegisteredDays": 0, "minAnonymitySet": 25 },
  "pinned": [ { "group": "urn:agora:group:riverton-v1", "seq": 17, "root": "0x…" } ],
  "proof": { … }
}
```

`pinned` is filled when the poll is made, from the latest root of each group, and can't change.

**Vote** (no session key; its proof is its authority):

```json
{
  "type": "agora/vote", "version": 1,
  "poll": "urn:uuid:…", "choice": 0,
  "nullifier": "0x…",
  "statement": { … },
  "zk": { "circuit": "<circuit id>", "proof": "<base64url>" }
}
```

**Feed entry and head** (host):

```
entry  = { seq, prev, at, kind, docHash, doc? }
hash_i = SHA-256(JCS({ seq, prev, at, kind, docHash }))
head   = { type: "agora/feed-head", issuer: host DID, forum, seq, hash, at, proof }
```

- The chain covers `docHash`, not the document. When a moderator hides a post, the host stops serving its `doc`, and the entry stays with its hash. The chain still verifies, and everyone can see that something was removed and by which moderation entry.
- The host signs a new head after each batch of writes. A client keeps the last head it saw for each forum. On the next sync, it checks that the new chain extends the old one. If the host rewrote or dropped entries, the client shows a warning.

### 7.6 Trust Task types

All are under our namespace, made with `ourSpec(name)`, for example `https://zk-toip.example/spec/agora/group/join/0.1`.

| Task | From → to | Transport in MVP | Payload → response |
|---|---|---|---|
| `agora/group/join` | member DID → registrar | TSP via relay | `{ group, credential, commitment }` → `{ receipt }` |
| `agora/group/rotate` | member DID → registrar | TSP | `{ group, commitment }` → `{ receipt }`. Replaces the member's leaf. |
| `agora/group/leave` | member DID → registrar | TSP | `{ group }` → `{ removedAtSeq }` |
| `agora/demo/issue` | member DID → demo issuer | TSP | `{ credentialType, claims }` → `{ credential }`. Dev only. |
| `agora/forum/pass` | session DID → host | HTTP `POST /forums/:id/passes` | a nym pass → `{ accepted, seq }` |
| `agora/forum/post` | session DID → host | HTTP `POST /forums/:id/posts` | a post → `{ seq }` |
| `agora/forum/delete`, `agora/forum/report` | session DID → host | HTTP | as above |
| `agora/forum/moderate` | moderator DID → host | HTTP | a moderation document → `{ seq }` |
| `agora/poll/open` | moderator or session DID → host | HTTP | a poll → `{ seq }` |
| `agora/poll/vote` | anyone → host | HTTP | a vote → `{ seq }` |
| `agora/feed/sync` | mirror → host | deferred | `{ forum, after }` → entries and head |

Over HTTP, the body is the signed document itself, not a TSP envelope. The vote has no issuer key. If votes ever travel over TSP, each one uses a throwaway did:key.

**The receipt**, signed by the registrar and sent only to the member:

```json
{ "type": "agora/group-receipt", "issuer": "did:key:…registrar", "issuedAt": "…",
  "group": "urn:agora:group:cascade-nursing-v1", "subject": "did:key:…ana",
  "index": 311, "leaf": "0x…", "commitment": "0x…",
  "validUntilDay": 20763, "registeredDay": 20398,
  "attrs": ["0x…RN", "0x…CA", "0x…", "0x0"], "atSeq": 43, "proof": { … } }
```

The client checks that `leaf` matches its own computation before it trusts the receipt.

### 7.7 HTTP API

**Host** (`http://localhost:4400`). All responses are JSON. POST bodies must be JSON.

| Method and path | Does |
|---|---|
| `GET /forums` | the current policy of every forum on this host |
| `GET /forums/:id` | `{ policy, groups, acceptedRoots, head }` |
| `GET /forums/:id/feed?after=<seq>&limit=<n>` | `{ entries, head }` |
| `GET /forums/:id/events` | server-sent events: `{ seq }` whenever the feed grows |
| `GET /forums/:id/polls/:pid` | `{ poll, tally, votes }` |
| `POST /forums` | create a forum: a signed policy. The MVP accepts any owner. |
| `PUT /forums/:id/policy` | a new policy version, signed by the same owner |
| `POST /forums/:id/passes`, `/posts`, `/deletes`, `/reports`, `/moderation`, `/polls`, `/polls/:pid/votes` | the writes in section 7.6 |
| `GET /moderation/session` | moderator sign-in: a challenge, signed back as Settle's operator login is |

Errors are `{ code, message }` with HTTP 400, 403, 409 or 429. Codes: `policyMismatch`, `statementMismatch`, `proofInvalid`, `rootNotAccepted`, `anonymitySetTooSmall`, `nymBanned`, `rateLimited`, `nullifierUsed`, `passExpired`, `passUnknown`, `notModerator`, `threadLocked`, `pollClosed`, `tooLarge`, `signatureInvalid`.

**Registrar** (`http://localhost:4402`), public reads only:
- `GET /groups`
- `GET /groups/:id` (the descriptor)
- `GET /groups/:id/roots?after=<seq>`
- `GET /groups/:id/leaves?after=<seq>`

## 8. Flows

### 8.1 Joining a group

1. Ana's client holds her did:key and a `NursingLicense` from the Cascade board, issued to her DID.
2. It computes `s` from her seed, if not done already: `s = f(HKDF-SHA256(seed, info = "agora/v1/identity-secret"))`. So her backup code restores `s` too.
3. It computes `C = H(T_ID, s, groupId)` and sends `agora/group/join { group, credential, commitment: C }` to the registrar over TSP.
4. The registrar checks:
   1. the credential verifies (`verifyCredential`), is from the descriptor's issuer and type, and is current;
   2. its status-list bit is clear;
   3. the TSP sender is `credentialSubject.id`, which is holder binding;
   4. there's no active leaf for this subject or this credential id already. If there is, it refuses with `alreadyMember`, and the member must use rotate.
5. It computes the leaf from `C`, the slots and the days, and records it. It answers with a receipt. The leaf appears in the next root.
6. The client syncs leaves, finds its leaf in the new root, and shows "Joined Cascade Board of Nursing group (1,284 members)".

**Rotate** replaces the subject's leaf with a new commitment, at most `rotation.maxPerYear` times. The new leaf gets a new `registeredDay`. Rotation is for a lost device or a reset secret. It is also the only way to get a fresh nym, which section 8.3 limits.

**Revocation.** The registrar polls each source's status list every 10 minutes. When a credential is revoked or expires, it sets the leaf to 0. The leaf drops out of the next root.

### 8.2 Posting

1. Ana opens Night Shift. The client fetches the policy, checks the owner's signature, and gets the groups and the host's accepted roots. It checks each root against the registrar's signed root log and against its own copy of the leaves.
2. It checks that Ana qualifies: a leaf in one of the groups, attributes that meet `where`, `registeredDay ≤ registeredBy` and `validUntilDay ≥ today`. If she doesn't, it says why ("This forum needs an RN license; yours is LPN") and stops.
3. It checks the anonymity set (section 10.1). Below `minAnonymitySet`, it refuses to post.
4. If there's no live pass, it makes a session key, builds the pass and proves it in a Web Worker. It shows progress (section 10.2). It sends the pass.
5. **The host checks the pass:**
   1. the DI signature by `issuer`;
   2. `forum` and `policy` name the current policy;
   3. `validUntil` is within 24 hours;
   4. it recomputes the statement from the policy, its accepted roots and `today`, and requires an exact match;
   5. `signal` equals `f(JCS(pass without zk and proof))`;
   6. `nym` equals the proof's nullifier;
   7. the proof verifies;
   8. the nym isn't banned.

   The host accepts `today` as its own day or the day before, so a pass made just before midnight still works. It accepts a root if it's the latest for its group, or if it was replaced less than `rootGraceSeconds` ago.
6. Ana writes and posts. The client signs the post with the session key and sends it. **The host checks the post:**
   1. the signature;
   2. a live pass from this session DID for this forum, and the post's `nym` matches it;
   3. the nym isn't banned;
   4. the nym's rate limit, and any `slow-nym`;
   5. the thread isn't locked;
   6. the size.

   It appends the post to the feed.
7. Every reader's client verifies the post's signature and its pass, the zk proof included, the first time it sees that pass. It caches the result by pass hash. A post whose pass doesn't verify is hidden with "couldn't verify".

**Thread mode.** The same flow, with a pass per thread. Starting a thread: the client chooses the thread id first, proves a pass for it, then sends the first post with `thread` equal to its own `id`.

### 8.3 Bans and ban evasion

- A ban names a nym. The host refuses that nym's passes and posts until `until`.
- To come back under a new nym, a person needs a new `s`, so a rotation, so a new leaf with a new `registeredDay`. A forum with `minRegisteredDays: 30` makes that new nym wait 30 days. The registrar allows only `maxPerYear` rotations. Together, these bound evasion to a few nyms per person per year, delayed by a month each. They don't stop it.
- **In thread mode, a ban covers only one thread.** The host can't tell that two thread nyms belong to one person. That's the point of thread mode. Owners who need forum-wide bans should use forum mode. The client says this when an owner picks thread mode.

### 8.4 Polls and votes

1. Dee, a moderator, opens a poll. The host fills in `pinned` from the current roots before Dee signs. Dee's client shows the pinned roots and checks them against the registrar's log.
2. Eve votes. Her client proves against the pinned roots. Every vote in the poll uses the same roots, so the root used reveals nothing. It submits the vote after a random delay of up to 10 minutes by default (section 11). The UI says "Your vote will be sent within 10 minutes" and offers "Send now".
3. **The host checks the vote:**
   1. the poll is open;
   2. the statement equals the one it computes from the poll;
   3. `signal` matches `{ poll, choice }`;
   4. the proof verifies;
   5. the nullifier is unused in this poll.

   It appends the vote. A second vote with the same nullifier gets `nullifierUsed` **(our call: first vote counts; section 13)**.
4. The tally is public and live. Anyone can recount from the feed by verifying every vote.

**Why pin the roots.** Without pinning, a person could vote, rotate their commitment, and vote again with the new secret. With pinning, the new leaf isn't in the pinned root. A leaf revoked after the poll opens can still vote. That's what a snapshot means, and the poll page says so.

### 8.5 Moderation

- A moderator signs in with their DID, by a challenge, as Settle's operators do. Moderators are named, not anonymous, in the MVP.
- The moderator view shows reports, and for each nym its posts in this forum, its report count, and its rate.
- Every action is a signed `agora/moderation` document in the feed, with a reason. Readers see "Removed by a moderator: rule 1" in place of a hidden post.
- The host has no admin override for content. The host's operator can delete the whole forum from storage, and the next head shows it as gone.

## 9. Threat model

| Adversary | Wants | Can | Can't, and why |
|---|---|---|---|
| **Host** | to unmask a nym, or link nyms across forums | see every pass, post, vote, nullifier and timestamp; see network addresses if it logs them, against the anti-goal; refuse or drop writes; withhold reads | Learn `s` or the leaf: the proofs are zero-knowledge. Link nyms across forums: different scopes give unrelated nullifiers, and session keys differ. Forge a post: posts are signed by session keys bound by proofs. Silently drop or rewrite the feed: heads are signed and chained, and clients check them. |
| **Issuer** | to learn who posts what | know every holder; revoke anyone | See commitments, unless it runs the registrar. Even then, commitments don't give nyms. **Probing:** revoke members one batch at a time and watch which nyms go quiet (section 11). |
| **Registrar** | to unmask, or to add sockpuppets | know which DID owns which leaf; add fake leaves; pad a group; publish different roots to different people | Link a leaf to a proof. **Can** add sybils: it is trusted for soundness. Different roots per person (a split view) are caught when clients and the host compare roots against the signed, chained root log. |
| **Host + registrar + issuer together** | to unmask | everything above | Break the zero-knowledge proof. What's left is metadata: timing, addresses, writing style and small groups (section 11). |
| **Sybil member** | many nyms in one forum | hold several qualifying credentials (two state licenses), rotate | Get two nyms from one leaf. One leaf per subject per group. Rotation is limited. **Can** get one nym per distinct qualifying credential if they use a different `s` for each. The honest client uses one `s` everywhere. This is a residual risk (section 11). |
| **Replay** | reuse a proof on another post or forum | copy any public pass or vote | Rebind it. `signal` covers the session DID, the forum and the policy, and a vote's covers the poll and the choice. The scope covers the forum or poll. |
| **Other members** | to find out who someone is | read everything | Anything more than the host can. |
| **Network observer** | to link a member to a forum | see connections to the host | Read content (TLS in a real deployment). **Can** see that an address talks to a host, and when. |
| **Malicious client code** | to steal `s` | — | Mitigated by not serving the client from the host, and by a published build hash. Not solved for a client served from the web at all. |

## 10. UX

### 10.1 What a poster sees

- **Wallet.** "Your credentials": each with its issuer, type and expiry, and its groups. A **Join** button sends the join. Joined groups show their size.
- **Forum page.** The title, rules and gate in words: "Posting needs: an RN license from the Cascade or Pine Valley Board of Nursing, held in a group for at least 7 days."
- **Your nym here.** A name made from the nym, such as **amber-otter-17**, with a color mark. Same forum, same name, on every device. The client keeps its own word lists of 256 adjectives and 256 nouns, takes two bytes of SHA-256(nym) for the words, and a number from 0 to 99. Names are only cosmetic. The full nym shows on hover, and clashes are possible.
- **"Who could have written this."** Under the compose box: "You'll post as amber-otter-17. The forum will know a current RN from one of 2 boards wrote it, out of about 1,980 people." The number is the sum of group sizes, narrowed by `counts` for equality predicates. It's labeled "about", because range predicates and `minRegisteredDays` narrow it further in ways the client can't count. Below the minimum, posting is off: "This group is too small to keep you anonymous (12 people; this forum needs 25)."
- **Ineligible.** The reason, in words, and what would fix it.
- **Leaks, said plainly.** A one-time notice before the first post:
  - the host can see your network address unless you use Tor or a VPN;
  - your writing style can identify you;
  - posting right after joining narrows who you are.

### 10.2 Proving times

**Expectations (a guess, until section 12's benchmark):**
- HashCloak measured Semaphore Noir with bb.js on an M2 laptop:
  - at depth 11, 1.8 s in a browser and 0.54 s in Node;
  - verification 15 ms in Node, warm.
- Our circuit adds a group selector, four predicates, a range check and two more hashes, at depth 20.
- We expect 2 to 4 s on a laptop and 6 to 12 s on a mid-range phone.
- The first use also downloads the prover and circuit, several megabytes, which the client caches.

**Budgets the MVP must meet, or report it didn't:**

| What | Budget |
|---|---|
| Pass or vote proof, laptop browser, warm | ≤ 4 s |
| Same, mid-range phone browser, warm | ≤ 12 s (reported, not required) |
| First proof including download, on broadband | ≤ 15 s |
| Verification, Node, warm | ≤ 50 ms |
| Verification in a reader's browser, warm | ≤ 100 ms |
| Proof size | ≤ 32 KB |

**How the client hides the wait:**
- It warms the prover when a forum page opens.
- It starts proving a pass as soon as the person focuses the compose box, if they don't have one. This is local, and nothing is sent until they post.
- It shows "Preparing your anonymous pass… (about 3 s, once a day)" with a progress bar driven by the library's callbacks. After that, "Post" is instant.
- A vote shows "Proving your vote…" and then "Vote ready, sending within 10 minutes."

### 10.3 What a moderator sees

- A queue of reports, newest first: the post, the nym's name, the report reasons.
- For a nym: its posts in this forum, when it first appeared, reports against it, and its rate. Never anything about other forums: the host has nothing to show.
- Actions: hide, restore, ban for 1 day, 7 days, 30 days or permanently, slow, and lock the thread. Each needs a reason, chosen from the forum's rules or typed.
- A note: "Bans apply to this nym. A banned person can come back under a new nym after rotating their membership, which takes at least N days in this forum."
- The moderation log: every action by every moderator, public.

## 11. Privacy leaks and mitigations

| Leak | To whom | Mitigation | What remains |
|---|---|---|---|
| Network address | host; network observers | the anti-goal of no logs; a notice; Tor or a VPN work, because the client is a plain web app (a guess: not tried with Tor Browser) | a host that logs addresses, against its promise, links a nym to an address |
| Timing: posting soon after joining | registrar + host | `minRegisteredDays`; the notice | joining is still a timed event |
| Timing: vote right after a post | host | the random vote delay | weaker if the person turns it off |
| Asking for a Merkle path when posting | registrar | clients sync all leaves on a schedule and compute paths locally | none for groups up to 2^16 |
| Small groups | everyone | `minAnonymitySet` checked by the client; `counts` for equality predicates | range predicates can narrow the set, and the client can't measure by how much |
| Padded groups | registrar + host | none in the protocol; choose registrars you trust; prefer issuer-run groups | a registrar can make a group look large |
| Revocation probing | issuer or registrar + host | roots at most hourly, batching changes; `added` and `removed` published in every root; clients warn if a group removes over 5% of members in a week | a slow, patient prober still learns something. Deleting a nym's activity history doesn't help, because the host saw it. |
| Split view of roots | registrar | signed, chained root log; the host and clients check each root is in it; the client refuses a root the host doesn't accept | none, if the client checks |
| Which group a proof used | host | hidden by the circuit (`g` is private) | none |
| Root choice partitions people | host | clients always use the latest accepted root; votes use pinned roots | a client offline for over `rootGraceSeconds` must resync |
| Writing style, content | everyone | a notice | real, and not ours to fix |
| One nym's history in a forum | everyone | by design; thread mode for forums that want less | — |
| Same `s` in every group | colluding registrars | commitments are per group | none from commitments. Registrars still know which DIDs joined. |
| Device compromise | thief | `s`, credentials and session keys are sealed in a passkey vault, as Settle seals its keys | an unlocked device is exposed |
| Different `s` per credential (a cheating sybil) | the forum | one leaf per subject per group; limited rotation | one nym per distinct qualifying credential |

## 12. MVP scope

### 12.1 Built

1. **Gate circuit and prover**, from `packages/anon-membership` (section 14). If that library isn't ready, Agora builds the circuit in that package, to its design, and doesn't fork it.
2. **Registrar**: groups with descriptors, joining, rotating and leaving over TSP; the leaf store in `node:sqlite`; the signed, chained root log published at most hourly; status-list polling; public reads.
3. **Three demo issuers**, each a did:key with a status list, issuing over `agora/demo/issue`:
   - Cascade Board of Nursing: `NursingLicense` with `licenseType` (RN or LPN), `state` and `licensedSince`;
   - Pine Valley Board of Nursing: the same type and schema;
   - City of Riverton: `ResidencyCredential` with `district` and `residentSince`.
4. **Host**: the HTTP API in section 7.7, the SQLite store, the feed log and signed heads, every check in section 8, bans, rate limits, polls and votes, moderator sign-in, and SSE.
5. **Client** (React, a separate origin):
   - an account in a passkey vault, reusing Settle's approach;
   - the wallet and credential requests from the demo issuers;
   - joining groups, and leaf sync every 15 minutes and on open;
   - forum list, forum page, thread page, compose, nym names, the anonymity estimate;
   - proving in a Web Worker with progress;
   - polls and votes with the delay;
   - verifying every post and pass it shows, and checking the feed chain.
6. **Moderator view** in the same client, at `/moderate/:forum`.
7. **Forum creation page**: write a policy from the registrar's groups, choose predicates, sign it and post it to a host.
8. **Dev clock** with **Skip ahead**, as in Settle, so `minRegisteredDays` and poll windows can be shown.
9. **Narrated terminal demo** `npm run demo --workspace @zk-toip/agora`, the same story as section 12.3 with real proofs.

### 12.2 Deferred

- Unlinkable rate-limited posting as a forum mode (the circuit already supports it).
- P2P replication and mirrors over TSP (`agora/feed/sync`).
- Members-only reading with encrypted content.
- Anonymous moderators: moderating as a nym of the forum.
- Leaf sync for groups past 2^16 members.
- Groups backed by a Commons roster instead of credentials (section 15).
- Rich predicates compiled from Cedar by zk-pdp.
- Native mobile proving.
- Proving the issuer's signature in the circuit, which would remove the registrar from soundness.
- Edits.

### 12.3 Demo script

The setup: `npm run agora`, with three browser profiles (Ana, Ben, Cal) and a fourth for Dee, all at `http://localhost:4403`. The platform prints the host's and the registrar's DIDs.

1. **Credentials.** Ana asks Cascade for an RN license and Riverton for residency in district 7. Ben asks Pine Valley for an RN license. Cal asks Cascade for an LPN license. Each appears in the wallet, verified.
2. **Join.** Each joins their groups. The registrar's console shows four joins by DID. The groups show their sizes. The platform pre-seeds each group with 40 simulated members, so the anonymity sets are realistic: 40 more did:keys with credentials and real leaves.
3. **A forum.** Dee creates Night Shift. The gate is RN, from Cascade or Pine Valley, `minRegisteredDays: 7`, forum nyms, Dee as moderator. Skip ahead 8 days.
4. **Ana posts.** The page says she'll post as *amber-otter-17*, out of about 80 people. The pass proves in about 3 s, and the post appears. Ben posts as a different name. Readers' clients show "Verified: a current RN".
5. **Cal is refused** before any proof: "This forum needs an RN license; yours is LPN." In the inspector, force the prover anyway: it can't make a proof, because the predicate fails in the circuit. Then send a pass proved with the `licenseType` predicate dropped (op 0): the host says `statementMismatch`, because it compiles the statement from the policy itself.
6. **One nym.** Ana opens a second browser with her backup code and posts. She's still *amber-otter-17*. She tries to join the Cascade group again for a second leaf, and the registrar says `alreadyMember`.
7. **Unlinkable across forums.** Riverton Town Square is gated on residency. Ana posts there and gets a different name. Show the host's database: two nyms, two session DIDs, nothing joining them, and no DIDs from the wallet anywhere.
8. **Replay.** In the inspector, copy Ana's pass, change the session DID, and send it. The host says `statementMismatch`, because the signal no longer matches. Change the forum id, and the host says `statementMismatch` too: wrong scope.
9. **Moderation.** Ben posts something that breaks rule 1. Ana reports it. Dee hides it and bans Ben's nym for 7 days. Readers see "Removed by a moderator: rule 1". Ben's next post is refused with `nymBanned`. Ben rotates his membership and gets a new leaf, but he can't post for 7 days.
10. **A poll.** In Town Square, Dee opens "Close Elm St to cars on Sundays?", restricted to district 7. Ana votes Yes, with "Send now". Her second vote is refused with `nullifierUsed`. A district-3 resident sees "This poll is for district 7". The tally updates live.
11. **Revocation.** Cascade revokes one simulated RN's license. Skip ahead an hour. The next root drops that leaf, and that member's pass can't be renewed. Point out the root's `removed: 1`, and explain revocation probing (section 11).
12. **The feed can't be rewritten silently.** Stop the host, edit one entry in SQLite, and restart it. The client shows "This host's history changed since you last read it."

### 12.4 Test plan

**The circuit** (`nargo test` in `packages/anon-membership`, and Agora-specific cases in `projects/agora/tests`):
- A valid witness proves and verifies, for each `g` from 0 to 3.
- Each of these makes proving fail:
  - a leaf not in any root;
  - a matching root that is 0;
  - `validUntilDay < today`;
  - `registeredDay > registeredBy`;
  - each op failing on its slot;
  - a value over 2^64 with ops 2 and 3;
  - `k ≥ limit`;
  - a wrong `groupIds[g]` in the commitment.
- A proof doesn't verify with any single public input changed. Run this for every input, `signal` included. This is the message-binding test.
- The same `s` and `scope` give the same nullifier from any group. Different scopes give different nullifiers.
- The JS and circuit hashes agree on fixed vectors: commitment, leaf, nullifier, scope and Merkle root.

**Protocol** (`src/protocol`):
- JCS and signal hashing on fixed vectors.
- `compileGate` on each predicate kind and encoding.
- Mixed schemas are refused.
- Nym names are stable.

**Registrar:**
- A join with a forged, expired, revoked, wrong-issuer or wrong-type credential is refused.
- A join from a TSP sender who isn't the subject is refused.
- A second join for the same subject or credential id is refused.
- Rotation over the limit is refused.
- A revoked status-list bit removes the leaf at the next root.
- The root chain verifies, and a forged or reordered root is detected.
- The root cadence is respected.

**Host:**
- Each error code in section 7.7 is produced by its cause.
- A replayed pass, post or vote is refused.
- A pass for an old policy version is refused.
- Root grace works: a root just replaced is accepted, one past grace is refused.
- `today` works: yesterday is accepted, two days ago is refused.
- Bans and their expiry; rate limits; slow-nym.
- Pinned roots: a vote made from a leaf added after the poll opened fails.
- Hiding keeps the chain valid.
- A restart keeps everything.

**Privacy** (automated):
- After the whole demo flow, the host's database and logs contain none of the members' wallet DIDs, no IP addresses, and no user agents.
- Two passes from the same person in different forums share no field except public policy values.
- Two proofs of the same statement are different bytes.

**Client** (Playwright, as Settle's e2e):
- the demo script, steps 1 to 10, in real browsers with virtual passkeys;
- screenshots;
- proof times written to `results/`.

**Benchmark** (`npm run bench --workspace @zk-toip/agora`):
- proving and verification for the gate circuit at depth 20, in Node and in Chrome, cold and warm, with 1 and all threads;
- written to a JSONL file with hardware and versions, as zk-pdp's results are.

## 13. Open questions

**For the convener**

1. **Third-party registrars or issuer-run groups first?** Third-party works with today's issuers, but adds a party trusted for soundness. Issuer-run needs issuers to run Agora's registrar. The MVP does both with one service. Which story leads?
2. **Re-voting.** First vote counts (MVP), or last vote counts? Last-counts lets a coerced voter change their vote later, but needs the host to keep replaceable votes.
3. **Default nym scope.** Forum (bans work) or thread (less linkable)? The MVP defaults to forum.
4. **Nym pass lifetime.** 24 hours means a revoked nurse can post for up to a day. Shorter means more proofs.
5. **Moderators as nyms.** Should moderators be anonymous too? It needs a moderator group per forum.
6. **Escrowed nyms in thread mode.** A careful option, *not* in the design: each thread pass carries the forum nym encrypted to the moderators, so a forum-wide ban works without revealing identity. It reveals forum-level linkage to moderators, and it is a slope towards unmasking. We left it out. Should it stay out?
7. **Members-only reading.** Is a public-read MVP enough for the first demo?
8. **Rotation limits.** Is 2 a year right?

**For the ToIP community**

1. What does hidden vetting (`vta/pcs/prove`) prove, and with what proof system? Could Agora's group join and gate proof use the same format?
2. Would issuers publish groups (signed roots of commitments) next to their status lists? That would make issuer-run groups the norm.
3. Is there a registry home for `agora/*`, perhaps near `rooms/*` or `voting/*`?
4. How should a forum policy relate to a VTC's governance document?

**Ours**

1. Do our proving budgets hold on phones?
2. Can leaf sync scale to 2^20 with a frontier and subtrees, without asking the registrar for a path?
3. Does the client work in Tor Browser at its standard setting?

## 14. Shared library needs

### 14.1 `packages/anon-membership` (owned by tipline)

**What Agora needs it to prove.** The gate circuit in section 5.1, exactly:
- membership in one of up to four groups, without saying which;
- a leaf with a commitment, a schema id, an expiry day, a registration day and four attribute slots;
- up to four predicates (equals, at least, at most);
- a scope-bound nullifier with a message index below a public limit;
- a bound signal;
- depth 20.

**How Agora differs from a drop box:**
- **Many proofs per person.** One pass per forum per day, one per vote. So the prover must be warmable, run in a Web Worker, report progress, and be fast. A whistleblower may prove once and can wait.
- **Attribute predicates.** "licenseType = RN", "district = 7". A drop box may need only "is a member".
- **A union of groups.** Several issuers' groups in one proof.
- **Pinned roots** for votes, and **expiry** checked in the circuit.
- **`registeredBy`**, to slow ban evasion.
- **Shared need: the rate-limit index `k`.** A drop box needs "N submissions per day, unlinkable". That is section 5.4.
- **Verification in Node and in browsers.** Readers verify too.

**Requirements:**
- **One hash in the circuit and in JS.** Synchronous in the browser and in Node, for tree building. We expect Poseidon2 over BN254, from Barretenberg's own implementation, so the JS side and the circuit agree.
- **Domain tags** as section 5 lists, or the library's own, as long as they're documented.
- **Fixed-depth trees with removal by zeroing a leaf.** Depth 20 for Agora.
- **A circuit id**: the hash of the compiled circuit and verification key. Documents name it, and verifiers refuse others.
- **JSON-safe serialization** of statements and proofs.
- The message-binding test in section 12.4.

**Proposed API:**

```ts
// packages/anon-membership/src/index.ts
export type Field = bigint;

export interface Leaf {
  commitment: Field;
  schemaId: Field;
  validUntilDay: number;
  registeredDay: number;
  attrs: [Field, Field, Field, Field];
}

export type Predicate =
  | { op: "any" }
  | { op: "eq"; value: Field }
  | { op: "gte"; value: bigint }   // < 2^64
  | { op: "lte"; value: bigint };

export interface Statement {
  groups: { groupId: Field; root: Field }[];   // 1..4; padded with zeros inside
  schemaId: Field;
  today: number;
  registeredBy: number;
  predicates: [Predicate, Predicate, Predicate, Predicate];
  scope: Field;
  limit: number;                               // 1..65536
  signal: Field;
}

export interface MerklePath { index: number; siblings: Field[] }

export interface Witness {
  secret: Field;
  groupIndex: number;
  leaf: Leaf;
  path: MerklePath;
  messageIndex?: number;                       // default 0
}

export interface MembershipProof {
  circuit: string;                             // circuit id
  statement: Statement;
  nullifier: Field;
  proof: Uint8Array;
}

// Hashes, identical to the circuit's
export function hash(...inputs: Field[]): Field;
export function fieldFromBytes(bytes: Uint8Array): Field;  // first 31 bytes of SHA-256
export function deriveSecret(seed: Uint8Array, info: string): Field;
export function commitment(secret: Field, groupId: Field): Field;
export function leafHash(leaf: Leaf): Field;
export function nullifier(secret: Field, scope: Field, messageIndex?: number): Field;
export function scope(label: string, ...parts: (string | Field)[]): Field;

// Trees
export class GroupTree {
  constructor(depth: number);
  static fromLeaves(depth: number, leaves: Field[]): GroupTree;
  set(index: number, leaf: Field): void;       // 0 removes
  root(): Field;
  path(index: number): MerklePath;
  readonly size: number;                       // non-zero leaves
}

// Proving and verifying
export interface ProveProgress { stage: "loading" | "witness" | "proving"; fraction: number }
export interface Prover {
  warm(): Promise<void>;
  prove(statement: Statement, witness: Witness, onProgress?: (p: ProveProgress) => void): Promise<MembershipProof>;
  dispose(): void;
}
export function createProver(opts?: { worker?: boolean; threads?: number; artifactsUrl?: string }): Promise<Prover>;

export type VerifyResult =
  | { ok: true; nullifier: Field }
  | { ok: false; reason: "unknownCircuit" | "statementMismatch" | "proofInvalid" };
export interface Verifier {
  /** Checks the proof, and that its statement equals `expected`, field by field. */
  verify(proof: MembershipProof, expected: Statement): Promise<VerifyResult>;
}
export function createVerifier(opts?: { circuits?: string[] }): Promise<Verifier>;

// Wire form
export function encodeProof(p: MembershipProof): { circuit: string; statement: unknown; nullifier: string; proof: string };
export function decodeProof(j: unknown): MembershipProof;
```

**Used by:** Agora (passes, votes), tipline (submissions), Commons (secret votes, Passes v2), agents (an agent proving it's one of a principal's agents without saying which, a guess).

### 14.2 `packages/anon-groups`: registrars and root logs (proposed, new)

The registrar side isn't Agora-specific. Anyone who proves membership needs someone to run the group. Proposed:

```ts
export interface GroupDescriptor { /* section 7.1 */ }
export interface RootRecord { /* section 7.2 */ }
export interface Receipt { /* section 7.6 */ }

/** Server side: the registrar's core, storage-agnostic. */
export class Registrar {
  constructor(opts: { identity: Identity; clock: Clock; store: GroupStore; fetchStatus: (url: string) => Promise<StatusListDoc> });
  define(desc: Omit<GroupDescriptor, "issuer" | "proof">): GroupDescriptor;
  join(req: { group: string; credential: Credential; commitment: Field; sender: string }): Promise<Receipt | Refusal>;
  rotate(req: { group: string; commitment: Field; sender: string }): Promise<Receipt | Refusal>;
  leave(req: { group: string; sender: string }): Promise<{ removedAtSeq: number } | Refusal>;
  pollStatus(): Promise<number>;               // leaves removed
  publishRoot(group: string): RootRecord | null; // null inside the cadence
  /** Registers the agora/group/* Trust Tasks on a trust-core Endpoint. */
  serve(endpoint: Endpoint): void;
}

/** Client side: keeps a verified copy of a group. */
export class GroupMirror {
  constructor(opts: { descriptor: GroupDescriptor; clock: Clock });
  applyRoots(roots: RootRecord[]): Promise<void>;          // checks signatures and the chain
  applyLeaves(seq: number, updates: { index: number; leaf: Field }[]): void; // checks against the root
  latest(): RootRecord;
  tree(): GroupTree;
  pathFor(leaf: Field): MerklePath | null;
  churn(days: number): { added: number; removed: number };
}

export function encodeAttribute(value: unknown, encoding: "hash" | "u64" | "day"): Field;
export function leafFromCredential(desc: GroupDescriptor, vc: Credential, commitment: Field, registeredDay: number): Leaf;
```

**Used by:** Agora, tipline (if submissions are credential-gated), Commons (household groups from rosters).

### 14.3 `packages/feed`: a signed append-only feed (proposed)

A host-kept, hash-chained log of signed documents, with signed heads, tombstones that keep the chain valid, and client-side checks that a new head extends the old one. Settle's transparency log is the same shape. Trail's event logs may be the base. If trail produces a log primitive, `feed` should be a thin layer on it, not a second one.

```ts
export interface FeedEntry { seq: number; prev: string; at: string; kind: string; docHash: string; doc?: unknown }
export interface FeedHead { type: "feed-head"; issuer: string; feed: string; seq: number; hash: string; at: string; proof?: Proof }

export class Feed {
  constructor(opts: { id: string; identity: Identity; clock: Clock; store: FeedStore });
  append(kind: string, doc: object): FeedEntry;
  tombstone(seq: number): void;                // drops doc, keeps docHash
  head(): FeedHead;
  read(after: number, limit: number): { entries: FeedEntry[]; head: FeedHead };
}

export type ExtendCheck = { ok: true } | { ok: false; reason: "forked" | "rewound" | "badSignature" | "badChain" };
export function verifyEntries(entries: FeedEntry[], head: FeedHead, clock: Clock): Promise<boolean>;
export function checkExtends(old: FeedHead, entries: FeedEntry[], head: FeedHead): ExtendCheck;
```

**Used by:** Agora (forum feeds), Settle (its log), trail, capture (capture logs), tipline (submission receipts, a guess).

### 14.4 `packages/vault`: keys sealed with a passkey (proposed)

Settle's `web/src/vault.ts`, moved into a package and made app-neutral. It needs:
- the storage prefix as a parameter, not `settle.accounts`;
- sealing for arbitrary named blobs, bound to an account and a purpose, as Settle's are;
- the backup code.

Agora seals the seed, credentials, receipts and session keys in it.

**Used by:** Settle, Agora, tipline, Commons, agents.

### 14.5 Dependencies Agora proposes

- **Existing:** `@zk-toip/trust-core`, `@zk-toip/relay`, React, Vite, Vitest, tsx, Playwright, `@noble/hashes`, `@noble/curves`.
- **New, through `packages/anon-membership`:**
  - `@noir-lang/noir_js` 1.0.0;
  - Barretenberg's bb.js. zk-pdp uses `@aztec-foundation/bb.js` 6.0.0, aliased as `@aztec/bb.js`.
  - Nargo, to compile circuits; not a runtime dependency.
  - Optionally the `binary-merkle-root` circuit from zk-kit.noir, and `@zk-kit/lean-imt`. These are tipline's call.
- **New in Agora itself:** none. The host uses `node:http` and `node:sqlite`, as Settle and the relay do.

## 15. Commons integration

Agora can serve Commons (`projects/commons/docs/design.md`) without either redesigning the other:

| Commons need | Agora piece | What's needed |
|---|---|---|
| Votes, "secret with a zero-knowledge proof" (Commons §5.4) | an Agora poll with pinned roots | A group whose members are **households**, not residents, so the vote is one per household. The household's admin device holds the household's secret. A roster-backed registrar admits one leaf per household entry in the building roster. |
| The residents' board (Commons §5.5) | an Agora forum gated on "current resident of Maple St", in forum mode | the same roster-backed group, at resident level |
| Passes v2 (the door learns only "a valid pass") | the same gate circuit, with the door as verifier and a challenge as the signal | not Agora's work. It uses `anon-membership` directly. |

**Roster-backed groups.** A registrar mode where the source is a signed Commons roster instead of a credential type. Joining needs the member's roster entry instead of a credential. Deferred (section 12.2). The descriptor's `source` gains `{ roster: <community DID> }`.

## 16. Sources

Read on 2026-11-06 unless noted.

**In this repository and in zk-pdp**
- `packages/trust-core/src/*`, `packages/relay/src/server.ts`. Read in full or in part, primary.
- `projects/settle/docs/design.md` and `README.md`; `projects/settle/web/src/vault.ts`; `projects/commons/docs/design.md`.
- `projects/zk-pdp-fit/ideas.md`, `open-questions.md`, `reuse.md`.
- `~/code/zk-pdp/README.md`: proving and verification times, 15 KB Noir proofs, E13's Ed25519 gate counts, Noir in Chrome at 4 to 8 s. `~/code/zk-pdp/bench/web/package.json` for versions.
- `docs/sources/S02-trust-tasks-registry-and-openvtc.md`, for hidden vetting (`vta/pcs/prove`) and the Trust Task envelope.

**Outside**
- HashCloak, Semaphore Noir final report, benchmarks: https://hashcloak.github.io/semaphore-noir-final-report/benchmarks.html. Primary for its numbers: M2 laptop, bb.js 0.82.2, nargo 1.0.0-beta.3.
- Semaphore's circuit, `packages/circuits/src/semaphore.circom`: https://github.com/semaphore-protocol/semaphore. Read for its commitment, nullifier and message constructions. Nothing copied.
- RLN documentation, "RLN in details": https://rate-limiting-nullifier.github.io/rln-docs/rln_in_details.html. Read through a summarizing fetch tool, so summary only.
- zk-kit.noir: https://github.com/privacy-scaling-explorations/zk-kit.noir. Package list only.
- npm registry metadata for `@noir-lang/noir_js`, `@aztec/bb.js`, `@aztec-foundation/bb.js` and `@zk-kit/lean-imt`: versions and dependencies.

## Decisions made (2026-11-06)

The open questions above were settled by the assistant, at the convener's request, so the MVP can be built. Each can be revisited.

- **Registrars.** Issuer-run groups first: the licensing board (or the employer, or the building's management) runs its own group. Third-party registrars come later.
- **Votes.** The last vote counts while the poll is open: a voter may change their mind, and the host replaces the earlier vote with the same nullifier. When the poll closes, the result is final.
- **Pseudonym scope.** Per forum by default. A thread can ask for its own scope.
- **Nym pass lifetime.** 24 hours.
- **Moderators** are not anonymous. They act under their own DIDs, and their actions are signed and logged.
- **Escrowed thread pseudonyms** (deanonymization by a threshold of trustees) stay out of the design, as an anti-goal.
- **Reading** is public in the MVP. Only posting and voting are gated.
