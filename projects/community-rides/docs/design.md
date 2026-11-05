# Community Rides: design

A straw-man ride-share for a local community, built on the OpenVTC TypeScript libraries (Apache-2.0), an implementation of the ToIP specs the P2P Trust Stack uses (TSP, Trust Tasks). For show and tell. Date: 2026-11-05.

Facts about the stack cite `docs/sources/S02-trust-tasks-registry-and-openvtc.md` (S02). Choices marked **(our call)** were made by the assistant while the convener was away, and are open to change.

## 1. Why this exists

People hear "decentralized identity" and "trust graph" and can't picture an app. This demo gives them one ordinary app, a neighborhood ride-share, and shows what changes when it's built on the P2P Trust Stack instead of a central platform:

- Your identity is a key pair on your phone, not an account on someone's server.
- The community vouches for people (members, vetted drivers), and peers check those vouchers themselves, on their own phones.
- The community's server is a notary and a bulletin board. It is not the source of trust, and it doesn't see private details such as pickup addresses.
- You can see, at each step, exactly what each party learns.

This project is independent of the repository's other projects. It doesn't use zk-pdp or zero-knowledge proofs (decision 0002).

The audience is IIW-style identity people, the P2P Trust Stack builders, and community organizers who aren't technical. The first two should recognize real wire formats. The last should follow the story without reading JSON.

## 2. Goals, non-goals, anti-goals

**Goals**

1. A five-to-ten-minute scripted demo, driven by a "next step" button with a one-line caption per step, that runs on one laptop with one command.
2. A free-play mode on the same screen, so the presenter can answer "what if…" questions live.
3. Real cryptography and real wire formats where the stack publishes them: TSP messages from `@openvtc/vti-tsp-js`, Trust Task envelopes and the consumer pipeline from `@openvtc/trust-tasks`, and Data Integrity proofs from `@openvtc/trust-tasks-proof` (S02). Signatures really verify, and tampering really fails.
4. Make disclosure visible: a wire view of what an observer sees, and a per-phone view of what that phone knows about whom.
5. Code clear enough that the stack's builders can read it and say "that's not how we'd do X". That reaction is the point of a straw man.

**Non-goals**

- Production use, real users, real accounts, persistence across reloads.
- Real maps, geolocation, routing or fares. Places are a handful of named spots.
- Payments.
- A mobile app, or networking across machines. All agents run in one browser page.
- Talking to live OpenVTC servers. (A possible later step, not this one.)
- Claiming conformance to Trust Task specs. Where we use a real spec, we say so. Where we don't, we use our own namespace.
- A real reputation system.

**Anti-goals.** Any of these makes the demo a failure, even if it works:

- **It looks like Uber with a crypto sticker**: a central server that holds everything and decides everything, with signatures for decoration. Every trust decision must visibly happen on a phone.
- **It hides the mechanics.** If an audience member can't tell what was revealed to whom, the demo has missed its purpose.
- **Fake crypto.** No mocked "✓ verified" badges. If a check shows a tick, real code computed it.
- **Overclaiming.** It must not imply the stack works this way when we guessed. Section 9 lists the guesses.
- **Copyleft code.** No GPL or other copyleft dependency, and nothing copied from the P2P Trust Stack's own repositories (S03). The convener doesn't want GPL code in this repository.

## 3. The story

One community, **Eastside Rides**, and five people. All names are fictional.

| Who | Role |
|---|---|
| Eastside Rides | The community. It has its own agent, run on a small server that a neighborhood co-op hosts. |
| Carol | Founding member and admin. Vets drivers. |
| Dave | Founding member. |
| Bob | Member who becomes a driver. |
| Alice | Newcomer who joins, then needs a ride. |
| Mallory | Member whose driver status gets revoked. |

The scripted demo has these steps. Each is one or more presses of "next".

1. **The community exists.** At startup, before the first step, the setup code builds the starting state with the same agent code and real signatures: Carol, Dave, Bob and Mallory are members, Carol is the admin, Mallory already holds a driver endorsement, and Dave has already ridden with Bob once, so each holds a "rode with" statement from the other. Step 1 shows this graph and its caption says it was set up beforehand. **(our call)**
2. **Alice joins.** Carol and Dave each sign a vouch for Alice. Alice's phone sends a join request carrying the two vouches. The community checks its join rule ("two vouches from current members") and admits her. Both sides sign the membership credential, and a new edge appears.
3. **Bob becomes a driver.** Carol checks Bob's license and insurance in person. That part is outside the system, and the caption says so. Carol's phone then asks the community to issue Bob a driver endorsement. The community checks that Carol is an admin, issues the endorsement with a revocation slot, and delivers it to Bob.
4. **Alice posts a ride request:** "Maple & 5th area → Eastside Clinic, today 3–4pm". The board shows it under a one-time pseudonym, not under Alice's identity. The exact address isn't posted.
5. **Bob offers.** Alice's phone checks Bob's offer itself and shows each check: the signatures verify, the issuer is Eastside Rides, Bob is a member, Bob holds a driver endorsement, it isn't revoked, the revocation list is fresh, and the policy permits it. The offer also carries the "rode with" statements Bob chooses to show. Alice's phone checks each one and shows "rode with 1 verified member (Dave), rated 5". The caption notes that Bob picked which statements to show, so he could hide a bad one. That's an open problem the demo should admit, not solve.
6. **Alice accepts.** Her phone sends the exact pickup address straight to Bob, encrypted. The wire view shows that the community's server and any observer see only the sender, the receiver and the ciphertext.
7. **Pickup.** Alice's phone shows a QR code holding a fresh random challenge. Bob's phone "scans" it. This simulated camera step carries no network message. Bob's phone signs the challenge and sends the answer to Alice over the network, so it appears on the wire panel. Alice's phone checks that the signature is from the key Bob's credentials name. Then they do the same in the other direction. The caption claims only what this proves: "the phone at the curb holds Bob's key" (and Alice's), not "this person is Bob".
8. **After the ride.** Each signs a "rode with" statement for the other, with a 1–5 rating, and sends it to the other. Each person keeps the statements about themselves. Bob now holds two (Dave's and Alice's). When he next offers anyone a ride, that phone shows "rode with 2 verified members". Each phone computes this from the signed statements. The server never sees them.
9. **Revocation.** After a complaint, Carol's phone asks the community to revoke Mallory's driver endorsement. The community checks that Carol is an admin and flips Mallory's bit in the signed revocation list. Mallory offers Alice a ride, and Alice's phone rejects it: "driver endorsement revoked".
10. **Forgery.** Mallory edits her old endorsement to look valid and offers again. Alice's phone rejects it: "signature does not verify".

Free play allows any action from any phone: post, offer, accept, vouch, revoke, rate, and tamper with a held credential.

## 4. What's on screen

One page, sized for a projector at 1920×1080. **(our call)**

- **Five phone frames** in a row: Alice, Bob, Carol, Dave and Mallory. Each shows that person's app: their credentials, the ride board, offers, and a "what I know" drawer listing what the phone knows about each other party and how it learned it.
- **A community console**: Eastside Rides' agent, showing members, endorsements, the revocation list, the join rule, and the admin list. It is labeled "server, hosted by the co-op". It has no action buttons. Admin actions come from Carol's phone as signed requests, so the server never acts on its own say-so.
- **A wire panel** along the bottom: one row per TSP message, giving sender VID, receiver VID, the Trust Task type, size, and the first bytes of ciphertext. Clicking a row shows the decrypted document, labeled "only <recipient> can see this".
- **A trust graph**: nodes for agents, edges for credentials. Edges appear as they're signed and turn red when revoked.
- **Demo controls**: next and previous, the step caption, reset, and a switch between scripted and free play.

Visual design is left to the builder. It must read from the back of a room: large type, high contrast, and few colors that carry meaning (verified, revoked, encrypted).

## 5. Architecture

### 5.1 Everything runs in one browser page

Each person and the community is an **agent object** with its own keys, held in memory **(our call)**. A simulated network connects them. This is a demo constraint, not a claim about the stack. In the stack, members' keys live on their own devices and the community agent runs on a server (S02). The code keeps the community agent free of browser APIs, so it could later run in Node behind a real transport.

The same agent code also runs headless in Node, for tests and for the scripted scenario.

### 5.2 Layers in the code

| Layer | What | Built from |
|---|---|---|
| Identity | One Ed25519 key pair per agent. The X25519 encryption key is derived from it, as the stack does (S02 glossary). Identifiers are `did:key`. | `@noble/curves` |
| Messaging | Each message is a real TSP Direct message, HPKE-Auth sealed and Ed25519 signed. | `@openvtc/vti-tsp-js` through `@openvtc/trust-tasks-tsp` |
| Network | An in-memory bus that delivers bytes by receiver VID and lets the wire panel tap every message. Key lookup by VID goes through a local resolver: for `did:key` it decodes the identifier. | ours |
| Trust Tasks | Every request and response is a Trust Task document (`trust-task/0.6.0` envelope), received through the `TspConsumer` pipeline with a replay guard. | `@openvtc/trust-tasks`, `@openvtc/trust-tasks-tsp` |
| Credentials | W3C VC-shaped JSON, signed with `eddsa-jcs-2022` Data Integrity proofs. Every credential has exactly one issuer and one proof. A two-way relationship is two credentials. | `@openvtc/trust-tasks-proof` signer, or `@noble` directly if that signer only takes Trust Task documents |
| Policy | Each decision is a Rego policy, compiled to WebAssembly and evaluated on the phone that decides. | OPA (`opa build -t wasm`), `@open-policy-agent/opa-wasm` |
| App | Community handlers, member agent logic, scenario script. | ours |
| UI | React components over the agents' state. | React, Vite |

**`did:key`, not `did:peer:4` (our call).** The stack uses `did:peer:4` for VIDs today (S02). `@openvtc/trust-tasks-proof` resolves keys from `did:key` verification methods with no network, which keeps the demo self-contained. Both are self-certifying, so the story doesn't change. The README says so.

**Rego (our call).** The trusttasks.org registry specifies Rego policy tasks (S02). The P2P Trust Stack's own engine uses its own JSON rule format instead (S03). Policies are `.rego` files, compiled with the OPA CLI (`opa build -t wasm`) into a bundle that is committed, so installing and running the demo never needs OPA. Only changing a policy does (`brew install opa`, and an `npm run policies` script). Each phone loads the bundle with `@open-policy-agent/opa-wasm` and evaluates its own decisions. **(our call:** commit the compiled bundle.)

### 5.3 Trust Tasks: real specs where they fit, ours elsewhere

Rule for the builder: **use a real registry spec, with its type URI and generated payload type, when its required fields can be filled honestly for this story. Otherwise use our namespace**, `https://zk-toip.example/spec/rides/<name>/0.1`. Record every choice and its reason in a table in the project README. Always use the real envelope.

| Step | Candidate real spec (S02) | Expected outcome |
|---|---|---|
| Vouch for an applicant | `vtc/endorsements/issue` 0.1 is community-issued, but a vouch is member-issued | ours: `rides/vouch` |
| Join | `vtc/join-requests/submit` 0.3 | real if its required fields fit, otherwise ours: `rides/join` |
| Membership credentials | the community's credential comes back in the join response; the member's credential back to the community goes through `vtc/members/vmc` 0.1, which replaced `vtc/join-requests/accept` | real `vtc/members/vmc`, if it fits |
| Driver endorsement | `vtc/endorsements/issue` 0.1, sent by Carol's phone. The predicate is registered once at setup through `vtc/endorsement-types/register`. The spec returns the credential to the requester (Carol), so the community also delivers it to Bob. | real issue and register, community predicate `https://zk-toip.example/rides/driver/1`. Delivery is ours: `rides/endorsement/deliver` |
| Post, list and withdraw ride requests | none found | ours: `rides/board/post`, `rides/board/list`, `rides/board/withdraw` |
| Offer, accept, decline | none found | ours: `rides/offer`, `rides/accept`, `rides/decline` |
| Pickup answer | `peer-check/ask` 0.1 puts a yes/no question to a person; here the phone answers a challenge it scanned | ours: `rides/pickup-check` |
| Rode-with statement | `vrc/relationships/*` is person to person, but it starts with a `propose` step and fresh pairwise DIDs, which is more than a rating needs | ours: `rides/rode-with`. Statements also travel inside `rides/offer`. |
| Revocation list fetch | `vtc/vetting/revocations/list` is for vetting | ours: `rides/status/get` |
| Revoke | `vtc/endorsements/revoke`, sent by Carol's phone | real |

For generated types, prefer the supported path: pin the tasks in `trust-tasks.lock` and generate with `@openvtc/trust-tasks-gen`. If that path takes more than about an hour to get working, use the deprecated prebuilt modules from `@openvtc/trust-tasks` 0.28.17, and note it.

## 6. Credentials

All are W3C VC-shaped JSON with `eddsa-jcs-2022` proofs. Exact field names are left to the builder, but each credential must carry what's listed here.

| Credential | Issuer | Subject | Carries | Signed by |
|---|---|---|---|---|
| Vouch | a member | applicant DID | community DID, "I know this person", issued date | the member |
| Membership | the community | member DID | community DID, member since, revocation index | the community |
| Membership acknowledgement | the member | community DID | the member's acceptance of membership | the member. With the row above, this is the two-way edge. |
| Driver endorsement | the community | member DID | predicate `…/rides/driver/1`, vehicle description, "license and insurance checked by" admin DID, valid until, revocation index | the community |
| Rode-with | a member | the other member's DID | ride id, date, rating 1–5 | the issuing member. Each side issues one and sends it to the other, who keeps it and may show it with later offers. |

**Revocation.** The community keeps one signed status list, a bit per revocation index, with an `issuedAt` time. A verifier fetches it over a Trust Task and checks two things: the bit is clear, and the list is fresher than a limit set in the policy (default 10 minutes of demo time). Revoking flips the bit and re-signs the list.

**Ride pseudonyms.** Each ride request is posted under a fresh `did:key` that Alice's phone mints for that ride only. The community knows which member posted it, because it checked membership before accepting the post. Other members don't. Bob replies to the pseudonym. The pattern follows `vtc/directory/introduce`, which uses a fresh pairwise DID (S02).

## 7. Who decides what

Every trust decision is made by the party at risk, on that party's own device.

| Decision | Made by | Policy says |
|---|---|---|
| Admit an applicant | community | Two valid vouches from current, unrevoked members, issued within 30 days. |
| Issue or revoke a driver endorsement | community | The request is signed by an admin. Admins are a list in the community's configuration, like the stack's current "flat admin list" (S02). |
| Accept a board post | community | The poster is a current member. |
| Show an offer to Alice | Alice's phone | The offerer holds a valid membership and a valid, unrevoked driver endorsement from Eastside Rides, and the status list is fresh. |
| Accept a rider | Bob's phone | The rider holds a valid, unrevoked membership. |
| Pickup | both phones | The person at the curb signed this phone's fresh challenge with the key the credentials name. |
| Count a rode-with statement | the viewing phone | The statement is signed, its issuer is a current member, and its subject is the offerer. The count is of distinct issuers. The phone also shows the mean rating. |

The community console shows its own decisions. Each phone shows its decisions as a checklist with the policy text one click away. Policies live in one folder of `.rego` files, so the presenter can open them. A decision returns the reasons it failed, not only allow or deny, so the checklist can name the failing condition.

## 8. Disclosure: what each party learns

The UI must make this table checkable. A test asserts it.

| Party | Learns |
|---|---|
| The community | Who its members are, who vouched for whom, who is a driver, which member posted each ride request (as a pseudonym it can map back), offers it relays if any. **Not** the exact pickup address, the accept message, the pickup check, or rode-with statements and ratings. |
| Alice, before accepting | That *some* member wants to drive her, and that member's identity, vehicle and endorsement, because a plain presentation reveals them. |
| Bob, before Alice accepts | A coarse area and time window, from a pseudonym. |
| Bob, after Alice accepts | Alice's membership credential and her exact pickup address. |
| A network observer | Sender and receiver VIDs, timing and sizes. TSP Direct mode doesn't hide those. The wire panel says so. Nested mode would (S02), but it's out of scope. |

## 9. Where we guessed about the stack

The README and the presenter's notes repeat these:

- How a real VTC admits members. Its join flow is mostly "planned" on the stack's site, though the registry specifies one (S02).
- That a ride board belongs on the community's server. The stack has data rooms (`rooms/*`, MLS, S02), which a real build would likely use.
- `did:key` instead of `did:peer:4` (section 5.2).
- That the OpenVTC libraries behave like the P2P Trust Stack's own implementation. They implement the same ToIP specs, but wire compatibility between them wasn't checked (S03).
- Vouch, rode-with and revocation formats are ours.
- Membership as two one-way credentials, following the registry (`vtc/members/vmc`). The stack's M-of-N co-signed VRC format (S02) wasn't read, and may be what a real community uses.
- Reputation as statements the subject holds and chooses to show. A real system has to deal with members hiding bad ratings.

## 10. Constraints

- TypeScript throughout. Node 20 or later. Vite and React for the UI. **(our call)**
- Lives in `projects/community-rides/`, self-contained: its own `package.json` and lockfile. One command after install starts it (`npm run dev`).
- Pin exact versions of the `@openvtc/*` packages. They changed on the day S02 read them. `@openvtc/trust-tasks-tsp` 0.1.2 needs `@openvtc/vti-tsp-js` `^0.2.0`. Use the version it resolves, even though 0.4.0 is out.
- No network access at runtime. Everything is in the page.
- Keys may come from fixed seeds, so DIDs are the same on every run. This helps the presenter, and it's fine for a demo **(our call)**.

## 11. Testing and done

- Unit tests (Vitest) for credential signing and verification, status lists, policies, and the TSP round trip.
- One headless scenario test that runs steps 1 to 10 in Node with the same agent code, and asserts each step's outcome: Alice admitted, the offer shown, the address only in Bob's inbox, Mallory's offer rejected as revoked, the forged offer rejected as a bad signature.
- A disclosure test for section 8: after the scenario, inspect each agent's state, and assert, for example, that the community agent never held Alice's exact address in plaintext.
- Done for v1: steps 1 to 10 run in the browser from a fresh `npm install`, the tests pass, and the README explains how to run the demo, the spec-or-ours table, and section 9's guesses.

## 12. Left to the builder

Visual design and component structure; exact payload and credential field names; Rego policy text; the status-list encoding; the bus's API; how the scenario script drives the UI; whether to split the code into workspace packages (one package is fine); and whether to show raw JSON or a friendly rendering by default (offer both).
