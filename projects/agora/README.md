# Agora

Forums where every post is anonymous, but posting needs a credential. "Only licensed RNs post here." "Only residents of district 7 vote in this poll." Each person has one pseudonym per forum, so there are no sockpuppets. A person's pseudonyms in different forums can't be linked.

- Design: `docs/design.md`. Its last section, "Implementation notes", says how the MVP differs from it.
- Status: **an MVP that runs end to end.** The demo script in design section 12.3 passes in real browsers, with real zero-knowledge proofs.

## Run it

```bash
npm install     # at the repository root
npm run agora   # http://localhost:4320
```

One command starts everything on your machine, in one process:
- three demo issuers: Cascade Board of Nursing, Pine Valley Board of Nursing and the City of Riverton;
- each issuer's group of credential holders (an issuer-run group), seeded with 40 simulated members;
- the forum host;
- the TSP relay;
- the web app, on its own origin;
- a dev clock that every part shares.

It prints the URLs and the DIDs. Data is kept in `projects/agora/.data/local`. Add `-- --fresh` to start again.

| What | Default | Setting |
|---|---|---|
| Web app | http://localhost:4320 | `AGORA_WEB_PORT` |
| Forum host | http://127.0.0.1:4321 | `AGORA_HOST_PORT` |
| Registrars (public reads) | http://127.0.0.1:4322 | `AGORA_REGISTRAR_PORT` |
| TSP relay | ws://127.0.0.1:4323/v1 | `AGORA_RELAY_PORT` |
| Data | `projects/agora/.data/local` | `AGORA_DATA` |

The web app uses Vite's dev server by default. For the built app, run `npm run build:web --workspace @zk-toip/agora`, then `npm run app --workspace @zk-toip/agora -- --static`.

Open the app in separate browser profiles, or private windows, to be different people. Accounts are sealed with a passkey (Touch ID, Windows Hello, a phone), or a passphrase if the browser's passkeys can't do it.

Try the demo:
1. **Credentials.** Make accounts for Ana, Ben, Cal and Dee. On **Wallet**, Ana asks Cascade for an RN license and Riverton for residency in district 7. Ben asks Pine Valley for an RN license. Cal asks Cascade for an LPN license.
2. **Join.** Each joins their groups on **Wallet**. The group learns the account's DID and a commitment, nothing more.
3. **A forum.** Dee opens **New forum**: Night Shift, for Cascade or Pine Valley, license type RN, 7 days in the group. Then **Skip ahead 8 days** at the bottom of the page.
4. **Post.** Ana opens Night Shift. It shows her pseudonym, such as *lemon-ballot-46*, and about how many people could have written her post. She posts. Proving her daily pass takes under a second. Ben replies under another name.
5. **Refused.** Cal sees "This forum is for license type RN; yours is LPN." No proof is made.
6. **One pseudonym.** On **Sign in**, Ana's backup code restores her account in another browser. There she has the same pseudonym.
7. **Moderation.** Ben breaks a rule, Ana reports him, and Dee hides the post and bans his pseudonym from **Moderate this forum**.
8. **A poll.** In a forum for Riverton residents, Dee opens a poll for district 7. Ana proves her vote, and it is sent within 10 minutes, or at once with **Send now**. Cal, in district 3, is told why he can't vote.

`npm run demo --workspace @zk-toip/agora` tells the whole story in the terminal (design section 12.3, steps 1 to 12), with real proofs.

## What's built

| Part | Where |
|---|---|
| Documents, hashes, gate compilation, scopes, signals, nym names, gates in words | `src/protocol/` |
| Registrar: credential checks before a leaf is added, one leaf per subject and per credential, rotation limits, status-list polling, roots at most once an hour with added, removed and per-value counts, receipts | `src/registrar/` |
| Demo issuers, each running its own group | `src/issuers/` |
| Forum host: every check in design section 8, bans, slow-nym, rate limits, thread locks, polls and votes, SSE, the feed as a trail in `packages/eventlog`, SQLite storage | `src/host/` |
| Client: wallet, joining over TSP, group sync, proving passes and votes, posting; the reader that checks every feed | `src/client/` |
| One-process platform, dev clock, dual-stack localhost | `src/platform/` |
| Web app: wallet, forums, threads, compose, polls, moderator view, forum creation, About | `web/` |

The proofs are `packages/anon-membership`'s gate circuit. Accounts use `packages/web-vault` with the prefix `agora`. TSP runs over `packages/relay`.

How trust works:
- The host checks every write. It never sees a wallet DID or a secret. Its database holds pseudonyms, session DIDs and the moderators' DIDs.
- A reader with no account checks everything in the browser: the host's key log and its DID binding, every feed entry's signature and chain, every body against its header, every document's signature, and every pass's and vote's proof against the forum's policy and the registrar's signed roots.
- The reader remembers the last entry it saw. If the host rewrites its history, the reader says "This host's history changed since you last read it."

## Tests

```bash
npm test --workspace @zk-toip/agora    # 42 tests, about 7 seconds, real proofs
npm run e2e --workspace @zk-toip/agora # the demo in Chromium, with virtual passkeys
```

- `tests/protocol.test.ts`: gate compilation for each predicate kind and encoding, refused gates, scopes, signals, nym names, words, anonymity estimates.
- `tests/registrar.test.ts`: forged, expired, revoked, wrong-issuer and wrong-type credentials; a sender who isn't the subject; one leaf per subject and per credential; rotation limits; revocation at the next root; the root cadence; the root chain.
- `tests/flow.test.ts`: the demo script with real proofs, plus stale roots, expired membership, and feed tampering.
- `tests/host.test.ts`: rate limits, slow-nym, ban expiry, thread locks, thread-scoped nyms, author deletes, old policy versions, over-long passes, the day window for votes, SSE, and a restart on SQLite. It also checks that the database holds no wallet DIDs.
- `web/e2e.ts`: four people, a second device and a reader with no account, in six browser profiles. Screenshots go to `web/e2e-shots/`, and proof times to `results/e2e-times.json`.

Measured on an Apple M1 Max: proving a pass and sending the first post takes about 0.8 s in Chromium and 0.35 s in Node. A post with a live pass takes about 0.1 s. A vote proof takes about 0.8 s in Chromium, including the page's work around it.

## Not built yet

- Everything in design section 12.2: unlinkable rate-limited posting, P2P mirrors, members-only reading, anonymous moderators, leaf sync past 2^16 members, roster-backed groups, Cedar predicates, native mobile proving, the issuer's signature in the circuit, and edits.
- Third-party registrars. Groups are issuer-run, as decided.
- `npm run bench`. The tests and the e2e record proof times instead.
- A page for changing a forum's policy. The host takes new versions (`PUT /forums/:id/policy`), and the tests use it.
- Leaving a group from the web app. The registrar answers `agora/group/leave`.
- Phones and Tor Browser are not measured or tried.
