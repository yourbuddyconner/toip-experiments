# Commons: design (ideation)

A suite of apps for an apartment building and the households in it, on the Trust over IP stack. It's the next step after Shared To-Do. This is a design for thinking with, not a build plan: it settles the shape, keeps alternatives open where they're interesting, and ends with open questions. Date: 2026-11-05.

Choices marked **(our call)** are the assistant's, made so the design hangs together. The convener hasn't decided them.

## 1. The idea

Each person installs one app, **Commons**. It holds their identity and their memberships:

```
Maple St Building                   a community (VTC)
├── Unit 4B household               a community inside it
│   ├── Alice                       resident, household admin
│   └── Bob                         resident
├── Unit 2A household
│   └── Carol
├── Dana                            building manager (staff)
├── Front door                      a device, member with the role "door"
└── Landlord LLC                    an organisation, owner of the building
```

Several small apps sit on top of that one identity, the same relay, and the trust plumbing Shared To-Do already has:

| App | Who it's for | In one line |
|---|---|---|
| **Lists** | a household | Shared To-Do, moved into the suite |
| **Passes** | residents, guests, the door | time-boxed guest and delivery passes, checked by a door kiosk, even offline |
| **Expenses** | a household | split bills and settle up, with debts both people sign |
| **Requests** | residents, manager, landlord | maintenance requests with a signed history |
| **Votes** | the building's households | one vote per household, secret |
| **Board** | everyone in the building | notices and room bookings |

**Why this, why now.** Shared To-Do showed one flat community with one kind of credential. A building needs the rest of ToIP:
- communities inside communities
- delegation (building → household → resident → guest)
- verifiers that aren't members (the door)
- people who belong to an organisation, not a household (the landlord)
- disclosure that should be minimal (the door doesn't need your name)
- decisions that need secrecy (votes)

Each app exercises one or two of these. Together they are a credible picture of a ToIP-native "home network".

## 2. Goals, non-goals, anti-goals

**Goals**

1. One identity per person across every app. Joining the building and a household happens once.
2. Each app is small, and uses the shared core for identity, communities, credentials, messaging, policy and storage.
3. Every trust decision is made on the device at risk, from signatures and credentials, as in Shared To-Do.
4. Each app shows at least one ToIP idea that the earlier projects didn't.
5. Map honestly to Trust Task registry specs, and use them where they fit instead of our own namespace (`docs/sources/S02`).

**Non-goals**

- Real door hardware. The door is a browser in kiosk mode.
- Payments. Expenses records debts; settling them happens outside the app.
- Legal records, such as leases.
- Several buildings, or a landlord with a portfolio. One building is enough for now, though section 4.4 sketches how it would extend.

**Anti-goals**

- **A building server everyone has to trust.** The manager's devices hold the building's keys, but they must not be able to read households' lists or expenses, forge residents' actions, or vote for anyone.
- **A surveillance tool.** The door, the manager and the landlord learn only what each task needs. The design has to say what each party learns, as Shared To-Do's did.
- **Rails.** As in Shared To-Do v2, each running app is one device's view.

## 3. People, roles and devices

| Party | Belongs to | Can |
|---|---|---|
| **Building** | (root) | has its own DID and key, held by the manager's device: the building's equivalent of a list key |
| **Manager** | building, role `manager` | admits and removes households, staff and doors; runs votes; handles requests |
| **Landlord** | building, role `owner` | sees and answers requests; can't see households' private apps |
| **Household** | building, role `household` | is itself a community with its own DID, held by its admin resident |
| **Resident** | a household, role `admin` or `member` | uses the apps; issues guest passes if the household allows it |
| **Guest** | nobody | holds a pass; may not have the app at all, since a pass can be a QR code |
| **Door** | building, role `door` | verifies passes and residents; never issues anything |
| **Delivery service** | outside the building | holds a building-wide delivery pass, issued by the manager |

A household is a member of the building, and residents are members of the household. A resident's standing in the building follows from that chain: building roster → household entry → household roster → resident entry. No separate "building resident" credential is needed **(our call)**. When a household is removed from the building, all its residents lose building standing at once.

## 4. The shared core

### 4.1 What carries over from Shared To-Do

- did:key identities, TSP Direct messages, Trust Task envelopes with Data Integrity proofs, and the DID-authenticated relay with its outbox.
- **Signed, versioned rosters with sticky removals and `keptOps`.** This becomes the general membership record for every community: the building, each household, and any list.
- The ordered op checks, held ops, paged history sync, and convergence ordering, for any app whose state is a set of ops.
- Rego policies compiled to wasm, one bundle per app.
- The inspector.

### 4.2 What has to change

- **Communities inside communities.** A roster entry's member may itself be a community (a DID with its own roster). Checking "is Alice a resident of this building?" becomes a chain check of two signed rosters. Devices cache the rosters of every community they're in.
- **One device, many communities, many apps.** Shared To-Do's `Device` becomes a core that hosts *communities* and *app modules*. Each app registers its message types, its Rego bundle and its views. Apps share the endpoint, the relay connection and the store, with storage namespaced per app.
- **Message routing by app.** Types become `https://zk-toip.example/spec/commons/<app>/<name>/0.1`, or registry specs where they fit (section 6).
- **Devices that aren't people.** The door has a DID and a building membership with role `door`, a kiosk mode, and no person behind it.
- **Several devices per person (probably needed here).** A resident with a phone and a laptop is normal in a building. The natural design: the person has a long-lived DID; each device has its own key; the person's DID delegates to device keys with a device credential, which a roster or verifier follows. This is the stack's "delegation of authority" credential type (S01, S02) used on yourself. It could be deferred, but the passes app benefits from it, because a pass issued from a laptop should be checkable to the same person as one issued from a phone.

### 4.3 Data each community holds

| Community | Roster says | Other signed state |
|---|---|---|
| Building | households, staff, doors, owner, with roles | building rules (Rego), the pass-issuing policy, the revocation list for building-issued passes |
| Household | residents, with roles | household rules, the revocation list for passes the household issued |
| A list, ledger or room | members (could simply be "everyone in household X") | the app's ops |

**Membership by reference (our call).** An app community can say "members: every current resident of household X" instead of keeping its own list. Its members then follow the household roster automatically. Shared To-Do's per-list invitations remain possible for lists shared across households.

### 4.4 Later: buildings in a network

The registry's `vtn/*` tasks federate communities into networks. A city's buildings, or a landlord's buildings, could form a network. Recognition across buildings would use `vtc/recognition/check`, so a delivery service recognised by the network would be recognised at every door in it. Out of scope for now, but the core shouldn't rule it out.

## 5. The apps

### 5.1 Passes (the flagship)

**What people do:**
- Alice, a resident of 4B, issues a pass: *"Rosa, dog walker, weekdays 12:00–14:00, until 31 Dec, front door only."* She sends it as a link or QR code.
- Rosa needs no app. She can open the link to show the QR code, or save it to her phone's wallet.
- At the door, the kiosk scans it, and opens or refuses at once.
- Alice sees "Rosa came in at 12:04". She can revoke the pass at any time.
- The manager issues building-wide passes, such as a delivery company's for the parcel room, under the same mechanism.

**The pass itself:**
- A credential **issued by the resident's DID** to a **fresh pass key** made for this pass, not to Rosa's identity. Rosa needs no DID.
- The QR code holds the credential and the pass private key, or, better, the device holding the pass signs the door's challenge, as in Community Rides' pickup check.
- Claims: the doors it opens, the time windows, the expiry, a revocation index in the household's list, and the issuing household.

**What the door checks**, offline-capable, from cached signed state:
1. The pass is signed by Alice.
2. Alice is a current resident of 4B (the household roster, signed by 4B's key).
3. 4B is a current household of the building (the building roster, signed by the building key).
4. The household's rules let residents issue passes, and this pass is within them (Rego). For example, "residents may issue passes for up to 90 days, daytime only, front door".
5. The pass isn't revoked (the household's revocation list), and the cached lists are fresh enough. The kiosk's policy sets how fresh, such as 15 minutes when online or 24 hours when offline.
6. Now is inside a window.
7. The holder signed the door's fresh challenge with the pass key, so a screenshot of the QR isn't enough. Offering a QR-only mode, which is replayable, is an open question (section 9).

**What the door learns, in two versions:**
- **v1, simple (our call for a first version):** the door learns which household issued the pass, and the pass label ("dog walker"). This is what a doorman knows today. The door's entry log is signed and readable only by the manager and the issuing household.
- **v2, minimal:** the door learns only "a valid pass from a current household of this building, valid now". Rosa proves the delegation chain without revealing which household, using a zero-knowledge proof over the signed rosters. This is the **zk-pdp project's** territory (`projects/zk-pdp-fit`), and a strong demo of why ZK matters in ToIP. A middle option needs no ZK: the building's key countersigns passes ("blind" to the door, not to the building), but then the building learns every pass.

**Receipts.** When the door admits someone, it sends the issuing household a signed entry receipt ("pass #… used at the front door, 12:04"). That gives Alice her notification, and gives everyone a tamper-evident log.

**What this shows that's new:** delegation chains across nested communities; a verifier that is a device and not a member of the issuer's community; offline verification against cached signed state with freshness rules; holder binding through a challenge; selective disclosure as a v1→v2 path; signed audit receipts.

### 5.2 Expenses

**What people do:** add an expense ("Groceries $84, paid by Alice, split equally among Alice and Bob"), see balances, and record settle-ups.

**Trust model:**
- An expense is an op, like Shared To-Do's.
- A **debt** between two people becomes binding when **both sign it**. Alice records the expense, and Bob's device co-signs his share or disputes it. That makes a two-party credential, the stack's VRC idea, used for something people care about.
- A settle-up is co-signed the same way.
- Balances are computed on each device from co-signed records only. Unconfirmed items show as "waiting for Bob".

**What this shows that's new:** two-party signed credentials, disputes as a first-class state, and arithmetic over signed records. It's also a good test of convergence with amounts.

**Open:** multi-currency, and whether the household admin can void a record.

### 5.3 Requests (maintenance)

**What people do:** a resident files "Leak under the kitchen sink", with photos. The manager triages it and books a contractor. The landlord sees cost approvals. The resident sees progress.

**Trust model:**
- A request is a small community of its own: the resident's household, the manager, and the owner when cost approval is needed.
- **Field-level visibility.** The unit number and access instructions ("key under the mat, dog is friendly") are encrypted to the manager only, with the private-item sealing from Shared To-Do. The landlord sees the issue and the costs, not the access details.
- Every status change is a signed op, so the history is an audit trail no single party can rewrite.
- The registry's `audit/*` tasks are a candidate for exporting it.

**What this shows that's new:** an organisation's role (the owner) that isn't a household, field-level disclosure by role, and audit trails.

### 5.4 Votes

**What people do:** the manager opens a vote ("Repaint the lobby: green or blue?"). Each household votes once, and the result is published.

**Eligibility:** one vote per current household at the moment the vote opens. That's a snapshot of the building roster version, signed into the vote.

**Secrecy, in three levels:**
- **Signed, not secret.** Easy. Useful for "who's coming to the BBQ".
- **Secret with trustees.** The registry's `voting/*` tasks describe elections with trustees, encrypted ballots and a bulletin board. Reusing them is the honest way to do it.
- **Secret with a zero-knowledge proof.** Each household proves "I'm a household in roster version N, and this is my only vote" without revealing which household. A nullifier gives one vote per household. Again, the **zk-pdp project** is where this belongs.

**What this shows that's new:** time-scoped eligibility from a roster snapshot, ballot secrecy, and the bridge to the ZK work.

### 5.5 Board

**What people do:** building notices from the manager, a residents' board, and room bookings (laundry, the party room).

**Trust model:**
- Notices are signed by the manager's role in the building, which shows a verifiable "from building management".
- The residents' board and bookings are group spaces. Today they could reuse ops plus history sync. The registry's `rooms/*` tasks, and OpenVTC's encrypted group rooms, are the stack's answer, with keys that rotate when members leave.

**What this shows that's new:** role-signed announcements, and possibly encrypted group rooms.

### 5.6 Lists

Shared To-Do, moved into the suite. A household list's membership is "every resident of this household" by reference (section 4.3). Lists shared across households keep their own invitations.

## 6. Mapping to the ToIP stack and the Trust Task registry

Candidate registry specs to use instead of our namespace. These need checking against their schemas before use, as Community Rides' plan required:

| Need | Candidate registry specs (S02) |
|---|---|
| Join a building or household | `vtc/join-requests/submit`, `vtc/members/vmc`, `vtc/member-onboarding` (ceremony) |
| Roles | `vtc/roles/define`, `vtc/members/role/set`, `acl/*` |
| Remove, leave | `vtc/members/admin-remove`, `vtc/members/self-remove`, `vtc/relationships/revoke` |
| Endorse a delivery service | `vtc/endorsements/issue`, `vtc/endorsement-types/register` |
| Present a pass or credential | `credential-exchange/present` (OID4VP) |
| Recognise another building's members | `vtc/recognition/check`, `registry/recognition` (TRQP) |
| Votes | `voting/election/*`, `voting/ballot/*`, `voting/trustees/*` |
| Board, bookings | `rooms/*`, `vtc/rooms/community/*` |
| Audit | `audit/list`, `audit/verify` |
| Ask a yes/no of a person | `peer-check/ask` |
| Federation | `vtn/*` |

By layer:
- **Layer 1:** a did:key per device, person, household, building and pass. Whether people should get a long-lived `did:scid:vh` with pre-rotation and witnesses is an open question (section 9).
- **Layer 2:** TSP Direct messages through the relay. A door kiosk is a TSP endpoint too.
- **Layer 3:** nested VTCs, rosters, credentials and passes, Rego per app, and the registry tasks above.
- **Layer 4:** the Commons app and its mini-apps.

## 7. What each party learns

| Party | Learns |
|---|---|
| The relay | Who messages whom, when, and how much. Nothing else, as in Shared To-Do. |
| The manager | The building roster (households, staff, doors), requests sent to them, notices, the vote tally. **Not** households' lists, expenses or passes. Pass entry logs only if the household shares them, or in v1, door-entry receipts. |
| The landlord | Requests that need their approval, without access details. The building roster's household count and roles, if the building's rules say so. |
| The door | In v1: which household issued a pass, and the pass label. In v2: only "valid now". |
| A guest | Their own pass. Nothing about the building's members. |
| Another household | What's on the shared board, and what they're invited into. Nothing of other households' apps. |

## 8. Shape of the work, if we build it

Not a commitment, just the order that teaches the most soonest:

1. **The core refactor.** Communities inside communities, rosters by reference, app modules, one identity across apps, door devices. Move Lists into the suite.
2. **Passes v1 and the door kiosk.** The demo people will remember.
3. **Expenses.** Two-party credentials.
4. **Requests.** Organisation roles, field-level disclosure.
5. **Board.** Possibly with encrypted group rooms.
6. **Votes, and Passes v2.** Together with the zk-pdp project, because both need zero-knowledge proofs over signed rosters.

Several devices per person could slot in before step 2, if passes should follow a person across devices.

## 9. Open questions

**For us**

- One household, or a whole building, as the first demo? (The design covers both; a household is the smallest case.)
- Several devices per person: in the core from the start, or later?
- Passes: must the guest have any app? Is a QR-only mode, which is replayable from a screenshot, acceptable with short windows, or must the holder always answer a challenge?
- How fresh must a door's cached rosters and revocation lists be when it's offline? Who decides: the building's rules, or the kiosk?
- Should the manager's device hold the building key, or should the building be governed M-of-N (manager plus a residents' representative)? That would be the first real use of the stack's M-of-N signing.
- How much of this should move to registry specs now rather than later?

**For the ToIP community**

- Nested VTCs: is a household as a VTC that's a member of a building VTC the intended model? How do the DTG data models express it?
- Delegation of authority: what shape do the stack's delegation credentials take, and is a guest pass one?
- Is there a registry pattern for verifier devices (the door) and their freshness rules?
- What's the stack's direction for selective disclosure? SD-JWT, BBS+, or zero-knowledge, which is where zk-pdp comes in.
- Would `voting/*` work for one vote per household with a roster snapshot?

## 10. Related

- `projects/shared-todo`: the core and the lessons (design v2 §4.8 and its review).
- `projects/community-rides`: the pickup challenge (holder binding), endorsements and vouching. Rides could be one more Commons app, for a building's car share.
- `projects/zk-pdp-fit`: Passes v2 and secret Votes are its natural first applications.
